"""Read-along for an audiobook with no ebook, made from the audio itself.

Transcribes each embedded chapter with faster-whisper (small.en), biased toward the book's names (look them
up on the web; only sourced names, see paragraphs.NameFixer), splits the text into paragraphs at pauses and
writes a version-1 read-along document with word timings to <out>/prepared.json. Finished chapters are cached
as words-NN.json, so an interrupted run resumes and a rebuild needs no model at all.

Usage: transcribe_book.py <job.json>   (job: itemId, audio, title, names, out, optional threads, model)
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import settings  # noqa: E402
from paragraphs import NameFixer, build_chapter  # noqa: E402


def log(**fields):
    print(json.dumps(fields), flush=True)


def pcm(audio, start, end):
    import numpy as np
    raw = subprocess.check_output(['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{start:.3f}', '-t', f'{end - start:.3f}', '-i', audio,
                                   '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'])
    return np.frombuffer(raw, dtype=np.float32)


def main(job_file):
    job = json.load(open(job_file))
    out, audio, names = job['out'], job['audio'], job.get('names', [])
    os.makedirs(out, exist_ok=True)
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_chapters', '-show_format', '-of', 'json', audio]))
    duration, chapters = float(probe['format']['duration']), probe['chapters']
    model = None
    fix = NameFixer(names)
    document_chapters = []
    for index, chapter in enumerate(chapters, 1):
        start, end = float(chapter['start_time']), float(chapter['end_time'])
        cached = os.path.join(out, f'words-{index:02}.json')
        if os.path.exists(cached):
            words = json.load(open(cached))
        else:
            if model is None:
                from faster_whisper import WhisperModel
                model = WhisperModel(job.get('model', str(settings.WHISPER_SMALL)), device='cpu', compute_type='int8',
                                     cpu_threads=int(job.get('threads', 4)))
            began = time.time()
            segments, _ = model.transcribe(pcm(audio, start, end), language='en', beam_size=5, word_timestamps=True, vad_filter=True,
                                           vad_parameters={'min_silence_duration_ms': 700}, hotwords=', '.join(names) or None,
                                           condition_on_previous_text=True)
            words = [[start + w.start, start + w.end, w.word] for s in segments for w in (s.words or [])]
            json.dump(words, open(cached + '.tmp', 'w'))
            os.replace(cached + '.tmp', cached)
            log(chapter=index, phase='transcribed', words=len(words), audioMinutes=round((end - start) / 60, 1), seconds=round(time.time() - began))
        paragraphs = build_chapter(index, start, end, words, fix)
        if paragraphs:
            document_chapters.append({'id': f'chapter-{index:02}', 'title': chapter.get('tags', {}).get('title') or f'Chapter {index}',
                                      'start': start, 'end': end, 'paragraphs': paragraphs})
    st = os.stat(audio)
    document = {'version': 1, 'itemId': job['itemId'], 'title': job['title'], 'origin': 'transcript',
                'source': {'size': st.st_size, 'mtimeMs': st.st_mtime_ns / 1e6, 'ctimeMs': st.st_ctime_ns / 1e6, 'dev': st.st_dev, 'ino': st.st_ino},
                'duration': duration, 'chapters': document_chapters,
                'transcription': {'model': 'faster-whisper small.en int8', 'names': names, 'nameFixes': fix.fixes,
                                  'madeAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}}
    json.dump(document, open(os.path.join(out, 'prepared.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    log(phase='done', chapters=len(document_chapters), paragraphs=sum(len(c['paragraphs']) for c in document_chapters),
        words=sum(len(p['words']) for c in document_chapters for p in c['paragraphs']), nameFixes=fix.fixes)


if __name__ == '__main__':
    main(sys.argv[1])
