import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))
import settings  # noqa: E402
import json, subprocess, re, sys, numpy as np
from faster_whisper import WhisperModel
book, audio, chapters = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3].split(',')]
doc = json.load(open(book if book.endswith('.json') else f'{settings.READ_ALONG_DIR}/{book}.json'))
m = WhisperModel(str(settings.WHISPER_TINY), device='cpu', compute_type='int8',
                 cpu_threads=1, local_files_only=True)
norm = lambda s: re.findall(r"[a-z0-9']+", s.lower().replace('’', "'"))
def clip(t, d):
    out = subprocess.run(['ffmpeg','-nostdin','-v','error','-ss',str(t),'-t',str(d),'-i',audio,'-map','0:a:0',
                          '-ac','1','-ar','16000','-f','s16le','-'], capture_output=True).stdout
    return np.frombuffer(out, dtype=np.int16).astype(np.float32) / 32768
def score(ch, t, heard):
    near = [p['text'] for p in ch['paragraphs'] if p['end'] > t - 3 and p['start'] < t + 38]
    far  = [p['text'] for p in ch['paragraphs'] if p['start'] > t + 240 or p['end'] < t - 240][:12]
    ref, ctl = set(norm(' '.join(near))), set(norm(' '.join(far)))
    n = max(1, len(heard))
    return sum(w in ref for w in heard) / n, sum(w in ctl for w in heard) / n
print(f"{'chapter':<8}{'where':<8}{'match':>7}{'control':>9}  verdict")
for ci in chapters:
    ch = doc['chapters'][ci - 1]
    for label, t in (('begin', ch['start'] + 7), ('middle', (ch['start'] + ch['end']) / 2), ('end', ch['end'] - 42)):
        segs, _ = m.transcribe(clip(t, 35), language='en', beam_size=1)
        heard = norm(' '.join(s.text for s in segs))
        s, c = score(ch, t, heard)
        v = 'ok' if s >= 0.7 else ('WEAK' if s >= 0.45 else 'MISALIGNED')
        print(f"{ci:<8}{label:<8}{s:>7.2f}{c:>9.2f}  {v}" + (f"   heard: {' '.join(heard[:14])}" if v != 'ok' else ''), flush=True)
