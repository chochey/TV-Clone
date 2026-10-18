#!/usr/bin/env python3
"""Book 5 (The Butcher's Masquerade): PDF text -> chapters.json + chapter-NN.txt.

The PDF merges two pairs of chapters that the audiobook splits (PDF 61 = audio
61+62, PDF 64 = audio 65+66), so those are split here at paragraphs located by
transcribing the audio. Part announcements are spoken at the head of chapters
16, 30 and 56, so they go into the spoken heading line, not the story text.
"""
import json, os, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from pdf_sections import pages_of, parse

scratch, audio, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
os.umask(0o077); out.mkdir(parents=True, exist_ok=True)
pages = pages_of(f'{scratch}/book5.txt')
secs, _ = parse(pages, first_body_page=15)
by = {s['title']: s['paragraphs'] for s in secs}

# 1. drop Part divider pages stranded on the tail of the chapter before each part
for title in ('Chapter 15', 'Chapter 29', 'Chapter 55'):
    paras = by[title]
    while paras and (re.fullmatch(r'PART \d', paras[-1]['text']) or
                     (paras[-1]['text'].isupper() and len(paras[-1]['text']) < 45)):
        paras.pop()
# 2. keep the story only: author bio and advertising pages follow the epilogue
ep = by['Epilogue']
cut = next(i for i, p in enumerate(ep) if p['text'].startswith('ABOUT THE AUTHOR'))
by['Epilogue'] = ep[:cut]

# 3. chapters in audiobook order, splitting the two merged PDF chapters
def split_at(paras, idx): return paras[:idx], paras[idx:]
chapters = []   # (paragraphs, spoken heading prefix)
SPLITS = {'Chapter 61': 70, 'Chapter 64': 93}
for s in secs:
    paras = by[s['title']]
    if s['title'] in SPLITS:
        a, b = split_at(paras, SPLITS[s['title']]); chapters += [a, b]
    else:
        chapters.append(paras)
PARTS = {15: 'Part 2. The Vengeance of the Daughter. ', 29: 'Part 3. The Unhinged Child. ', 55: 'Part 4. The Butchering. '}

probe = json.loads(subprocess.run(['ffprobe','-v','quiet','-print_format','json','-show_chapters',audio],
                                  capture_output=True, text=True).stdout)['chapters']
narrated = [(float(c['start_time']), float(c['end_time'])) for c in probe][1:]   # drop the 22 s credits
assert len(chapters) == 78, len(chapters)
doc = []
for i, paras in enumerate(chapters):
    last = i == len(chapters) - 1
    title = 'Epilogue' if last else f'Chapter {i + 1}'
    spoken = PARTS.get(i, '') + title
    start, end = narrated[i]
    doc.append({'id': f'c{i+1:02d}', 'title': title, 'start': start, 'end': end,
                'paragraphs': [{'id': f'c{i+1:02d}-p{j:04d}', 'text': p['text'], 'page': p['page']}
                               for j, p in enumerate(paras, 1)]})
    f = out / f'chapter-{i+1:02d}.txt'
    f.write_text(spoken + '\n' + '\n'.join(p['text'] for p in paras) + '\n'); f.chmod(0o600)
(out / 'chapters.json').write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
st = os.stat(audio)
(out / 'source.json').write_text(json.dumps({'size': st.st_size, 'mtimeMs': st.st_mtime_ns / 1e6}, indent=1) + '\n')
words = [sum(len(p['text'].split()) for p in c['paragraphs']) for c in doc]
print(json.dumps({'chapters': len(doc), 'paragraphs': sum(len(c['paragraphs']) for c in doc),
                  'words': sum(words), 'unusedAudioChapters': len(narrated) - len(doc),
                  'longestParagraphChars': max(len(p['text']) for c in doc for p in c['paragraphs'])}))
