"""Create independently recognized word checkpoints, without book-text prompts.

This can run before paragraph alignment: embedded audio chapters supply times.
Usage: python make_checks.py [chapter numbers ...] [--heads]
All model access is local; source audio is never sent to a remote service.
"""
import os
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['HF_HUB_OFFLINE'] = '1'
from pathlib import Path
import argparse, json, re, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel
from job_config import ROOT, AUDIO, WHISPER, CONFIG
from align_words import atomic, identity, log

def audio_chapters():
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_chapters', '-of', 'json', str(AUDIO)], text=True))
    windows = CONFIG.get('chapterWindows')
    if windows:
        # A combined file with credits between its parts cannot be described by one offset, so the
        # windows are listed explicitly. Each must still sit inside a real embedded chapter, the
        # same safety the single-chapter bounds below enforce.
        assert len(windows) == CONFIG['chapterCount'], 'Chapter window count changed'
        embedded = [(float(c['start_time']), float(c['end_time'])) for c in probe['chapters']]
        result = []
        for start, end in windows:
            assert any(a - .01 <= start < end <= b + .01 for a, b in embedded), 'Chapter window is outside the embedded chapters'
            result.append({'start': float(start), 'end': float(end)})
        return result
    offset, count = CONFIG['audioChapterOffset'], CONFIG['chapterCount']
    chapters = probe['chapters'][offset:offset + count]
    assert len(chapters) == count, 'Audio chapter count changed'
    result = [{'start': float(c['start_time']), 'end': float(c['end_time'])} for c in chapters]
    for key, bounds in CONFIG.get('chapterBounds', {}).items():
        index = int(key) - 1
        embedded = result[index]
        assert embedded['start'] <= bounds['start'] < bounds['end'] <= embedded['end'], 'Custom story boundary is outside the embedded chapter'
        result[index] = bounds
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('chapters', nargs='*', type=int)
    parser.add_argument('--heads', action='store_true')
    parser.add_argument('--sample-start', type=float)
    parser.add_argument('--sample-label', default='extra')
    parser.add_argument('--sample-duration', type=float, default=35)
    args = parser.parse_args()
    assert re.fullmatch(r'[a-z][a-z0-9-]*', args.sample_label), 'Unsafe sample label'
    assert 1 <= args.sample_duration <= 60, 'Sample duration outside safe range'
    os.umask(0o077)
    dest = ROOT / 'checks'; dest.mkdir(exist_ok=True, mode=0o700)
    chapters = audio_chapters()
    order = args.chapters or list(range(1, len(chapters) + 1))
    assert all(1 <= n <= len(chapters) for n in order)
    assert args.sample_start is None or len(order) == 1, 'Custom checkpoints require one chapter'
    heads = args.heads
    source = identity()
    model = WhisperModel(str(WHISPER), device='cpu', compute_type='int8', cpu_threads=1, num_workers=1, local_files_only=True)
    for n in order:
        ch = chapters[n - 1]
        windows = [('heading', ch['start'], min(25, ch['end']-ch['start']))] if heads else [
            ('begin', ch['start'] + 7, 35), ('middle', (ch['start'] + ch['end']) / 2, 35), ('end', ch['end'] - 42, 35)]
        if args.sample_start is not None:
            assert ch['start'] <= args.sample_start and args.sample_start + args.sample_duration <= ch['end'], 'Checkpoint is outside this chapter'
            windows = [(args.sample_label, args.sample_start, args.sample_duration)]
        for label, start, duration in windows:
            target = dest / f'transcript-{n:02}-{label}.json'
            signature = {'source': source, 'chapter': n, 'chapterStart': ch['start'], 'chapterEnd': ch['end'], 'start': start, 'duration': duration}
            if target.exists():
                cached = json.loads(target.read_text())
                assert cached.get('identity') == signature, 'Independent checkpoint source changed'
                log(chapter=n, checkpoint=label, phase='cached'); continue
            raw = subprocess.check_output(['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(start), '-t', str(duration), '-i', str(AUDIO),
                '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-threads', '1', '-f', 'f32le', '-'], timeout=45)
            pcm = np.frombuffer(raw, dtype=np.float32)
            assert len(pcm) >= 16000, 'Empty checkpoint audio'
            segments, _ = model.transcribe(pcm, beam_size=3, language='en', word_timestamps=True, condition_on_previous_text=False)
            words, times, intervals = [], [], []
            for segment in segments:
                for word in segment.words:
                    normalized = re.findall(r'[a-z0-9]+', word.word.lower())
                    words.extend(normalized); times.extend([start + (word.start + word.end) / 2] * len(normalized))
                    intervals.extend([[start + word.start, start + word.end]] * len(normalized))
            assert identity() == source, 'Audiobook changed during checkpoint extraction'
            atomic(target, {'start': start, 'words': words, 'times': times, 'intervals': intervals, 'identity': signature})
            log(chapter=n, checkpoint=label, phase='independently checked speech', words=len(words))

if __name__ == '__main__':
    main()
