"""Core of the gap-recovery pass: wav2vec2 CTC forced alignment over a window, plus Whisper (tiny.en) as an
independent check. The CTC pieces (normalize/tokens/align_ctc) are the same code the word job uses
(align_words.py), copied so this tool does not depend on a job directory."""
import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))
import settings  # noqa: E402  (tools/readalong/settings.py)
import os
os.environ.setdefault('OMP_NUM_THREADS', '2'); os.environ.setdefault('OPENBLAS_NUM_THREADS', '1'); os.environ.setdefault('HF_HUB_OFFLINE', '1')
import json, re, subprocess, unicodedata
import numpy as np

STEP = .02
MODEL = str(settings.WAV2VEC2_MODEL)
WHISPER = str(settings.WHISPER_TINY)


def normalize(value):
    value = value.replace('’', "'").replace('‘', "'")
    from num2words import num2words
    value = re.sub(r'\b\d+(?:,\d{3})*(?:\.\d+)?(?:st|nd|rd|th)?\b',
                   lambda m: num2words(m[0][:-2].replace(',', ''), to='ordinal') if re.search(r'(st|nd|rd|th)$', m[0]) else num2words(m[0].replace(',', '')), value)
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode().upper()
    return re.sub(r"[^A-Z']+", '|', value).strip('|')


def tokens(text, vocab):
    ids = []; mapping = []
    for match in re.finditer(r'\S+', text):
        word = normalize(match[0])
        a = len(text[:match.start()].encode('utf-16-le')) // 2; b = len(text[:match.end()].encode('utf-16-le')) // 2
        if not word:
            continue
        if ids:
            ids.append(vocab['|'])
        begin = len(ids); ids.extend(vocab[c] for c in word); mapping.append((a, b, begin, len(ids), word))
    return np.array(ids, dtype=np.int32), mapping


def align_ctc(emission, ids):
    states = np.zeros(len(ids) * 2 + 1, dtype=np.int32); states[1::2] = ids
    count = len(states); previous = np.full(count, -np.inf, dtype=np.float32); previous[0] = 0
    if count * len(emission) > 80_000_000:
        raise ValueError('Window too large for bounded acoustic alignment')
    skip = np.zeros(count, dtype=bool); skip[2:] = (states[2:] != 0) & (states[2:] != states[:-2])
    back = np.zeros((len(emission), count), dtype=np.uint8)
    best = -np.inf; finish = None
    for t, frame in enumerate(emission):
        one = np.r_[-np.inf, previous[:-1]]; two = np.r_[-np.inf, -np.inf, previous[:-2]]; two[~skip] = -np.inf
        choices = np.stack((previous, one, two)); direction = choices.argmax(axis=0)
        current = choices[direction, np.arange(count)] + frame[states]
        current[0] = 0; back[t] = direction; previous = current
        for end in (count - 2, count - 1):
            if current[end] > best:
                best = float(current[end]); finish = (t, end)
    if finish is None or not np.isfinite(best):
        raise ValueError('No alignment path')
    t, state = finish; frames = [[] for _ in ids]
    while t >= 0 and state > 0:
        if state % 2:
            frames[state // 2].append(t)
        state -= int(back[t, state]); t -= 1
    if state > 0 or any(not f for f in frames):
        raise ValueError('Incomplete alignment path')
    return [sorted(f) for f in frames]


def read_pcm(audio, start, duration):
    raw = subprocess.check_output(['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(start), '-t', str(duration), '-i', str(audio),
                                   '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-threads', '1', '-f', 'f32le', '-'], timeout=300)
    return np.frombuffer(raw, dtype=np.float32)


class Acoustic:
    def __init__(self):
        import onnxruntime as ort
        config = ort.SessionOptions(); config.intra_op_num_threads = 2; config.inter_op_num_threads = 1
        config.add_session_config_entry('session.intra_op.allow_spinning', '0'); config.add_session_config_entry('session.inter_op.allow_spinning', '0')
        self.session = ort.InferenceSession(f'{MODEL}/model_quantized.onnx', config, providers=['CPUExecutionProvider'])
        self.vocab = json.loads(open(f'{MODEL}/vocab.json').read())

    def infer(self, pcm):
        pcm = (pcm - pcm.mean()) / np.sqrt(pcm.var() + 1e-7)
        y = self.session.run(None, {'input_values': pcm[None]})[0][0]
        y = y - y.max(-1, keepdims=True); return y - np.log(np.exp(y).sum(-1, keepdims=True))

    def window(self, audio, start, end):
        """Log-probabilities for [start, end) at 20 ms steps (long windows are done in overlapping 20 s cores)."""
        duration = end - start
        pcm = read_pcm(audio, start, duration)
        seconds = len(pcm) / 16000
        output = np.full((int(np.ceil(seconds / STEP)), 32), -30, dtype=np.float32); output[:, 0] = 0
        for core in np.arange(0, seconds, 20):
            low = max(0, core - 1.5); high = min(seconds, core + 21.5)
            y = self.infer(pcm[round(low * 16000):round(high * 16000)])
            offset = round(low / STEP); indices = np.arange(len(y)) + offset
            use = (indices >= round(core / STEP)) & (indices < round(min(seconds, core + 20) / STEP)) & (indices < len(output))
            output[indices[use]] = y[use]
        return output


def paragraph_words(text, emission, frames, mapping, ids, vocab, origin, lo_bound, hi_bound):
    """Per-word [charStart, charEnd, start, end, score] from a forced path (times relative to `origin`)."""
    rows = []
    for a, b, begin, end, word in mapping:
        f = [t for i in range(begin, end) for t in frames[i]]
        score = float(np.exp(np.mean([max(emission[t, ids[i]] for t in frames[i]) for i in range(begin, end) if ids[i] != vocab['|']])))
        lo = max(lo_bound, origin + min(f) * STEP - .03); hi = min(hi_bound, origin + (max(f) + 1) * STEP + .07)
        rows.append([a, b, round(lo, 3), round(hi, 3), score, word])
    return rows


class Whisper:
    def __init__(self):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(WHISPER, device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)

    def words(self, audio, start, end):
        pcm = read_pcm(audio, start, end - start)
        segments, _ = self.model.transcribe(pcm, beam_size=3, language='en', word_timestamps=True, condition_on_previous_text=False)
        out = []
        for segment in segments:
            for w in segment.words:
                out.append((start + w.start, start + w.end, w.word.strip()))
        return out
