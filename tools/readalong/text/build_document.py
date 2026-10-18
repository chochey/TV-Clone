#!/usr/bin/env python3
"""Assemble a read-along sidecar from aeneas paragraph alignment.

Times from aeneas are relative to each chapter's extracted wav, so the chapter
start is added back. The server requires strictly increasing, non-overlapping
spans, so timings are made monotonic here rather than hoping alignment was.
"""
import hashlib, json, os, re, subprocess, sys
from pathlib import Path

EPS = 0.001

# The books wrap in-world annotations in ASCII angle brackets -- "<Note added by
# Crawler Rosetta>", "<Empty>" -- which the reader rejects as possible markup.
# Book 3 solved this by displaying them as typographic angle marks, so match
# that. Only balanced pairs are converted: book 6 also uses ">>" as a
# transmission prefix, which is not markup and must survive untouched.
ANGLE_PAIR = re.compile(r'<([^<>]{1,200})>')
def normalize_angles(text):
    return ANGLE_PAIR.sub(lambda m: '\u2039' + m.group(1) + '\u203a', text)

def main():
    root = Path(sys.argv[1]); audio = Path(sys.argv[2]); item_id = sys.argv[3]
    title = sys.argv[4]; repo = Path(sys.argv[5])
    os.umask(0o077)
    chapters_in = json.loads((root/'chapters.json').read_text())
    st = audio.stat()
    # validIdentity still requires every field present, even though sameSource
    # now compares only size and mtime (mergerfs renumbers inodes on mount).
    source = {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size,
              'mtimeMs': st.st_mtime_ns/1e6, 'ctimeMs': st.st_ctime_ns/1e6}
    duration = float(json.loads(subprocess.run(
        ['ffprobe','-v','quiet','-print_format','json','-show_format',str(audio)],
        capture_output=True,text=True).stdout)['format']['duration'])

    out_chapters = []; cursor = 0.0; nudged = 0; normalized = []
    for n, ch in enumerate(chapters_in, 1):
        frags = json.loads((root/f'aligned-{n:02}.json').read_text())['fragments']
        paras_in = ch['paragraphs']
        assert len(frags) == len(paras_in)+1, f'chapter {n}: {len(frags)} frags vs {len(paras_in)}+1'
        offset = ch['start']
        paragraphs = []; prev = max(cursor, offset)
        for p, f in zip(paras_in, frags[1:]):
            s = offset + float(f['begin']); e = offset + float(f['end'])
            if s < prev: s = prev
            if e <= s: e = s + EPS; nudged += 1
            body = normalize_angles(p['text'])
            if body != p['text']: normalized.append(p['id'])
            entry = {'id': p['id'], 'text': body, 'start': round(s, 3), 'end': round(e, 3)}
            # Only books prepared from a PDF carry pages; never invent them.
            if isinstance(p.get('page'), int): entry['page'] = p['page']
            paragraphs.append(entry)
            prev = e
        c_start = paragraphs[0]['start']; c_end = paragraphs[-1]['end']
        if c_start < cursor: c_start = cursor
        if c_end <= c_start: c_end = c_start + EPS
        out_chapters.append({'id': ch['id'], 'title': ch['title'],
                             'start': round(c_start,3), 'end': round(c_end,3),
                             'paragraphs': paragraphs})
        cursor = out_chapters[-1]['end']
    assert cursor <= duration + 1, f'alignment runs past the audio: {cursor} > {duration}'

    text = '\n'.join(p['text'] for c in out_chapters for p in c['paragraphs'])
    document = {'version':1,'itemId':item_id,'title':title,'source':source,'duration':duration,
                'sourceTextSha256':hashlib.sha256(text.encode()).hexdigest(),
                'method':'aeneas-1.7.3-paragraph','chapters':out_chapters}
    if normalized:
        document['displayNormalization'] = {
            'angleMarks':'ASCII angle brackets displayed as typographic angle marks',
            'paragraphs': len(normalized)}
    target = root/f'{item_id}.json'
    target.write_text(json.dumps(document, ensure_ascii=False, separators=(',',':')))
    target.chmod(0o600)
    # The live server's own parser is the authority on whether this is valid.
    check = ("const f=require('fs'),r=require(process.argv[1]+'/lib/audio-read-along');"
             "const d=JSON.parse(f.readFileSync(process.argv[2]));r.parseDocument(d,d.itemId);"
             "if(!r.sameSource(d.source,f.statSync(process.argv[3])))throw Error('Audio changed');"
             "if(f.statSync(process.argv[2]).size>r.MAX_FILE_BYTES)throw Error('Too large');"
             "console.log('verified');")
    verdict = subprocess.check_output(['node','-e',check,str(repo),str(target),str(audio)],text=True).strip()
    assert verdict=='verified', verdict
    print(json.dumps({'itemId':item_id,'chapters':len(out_chapters),
        'paragraphs':sum(len(c['paragraphs']) for c in out_chapters),
        'nudgedZeroLength':nudged,'angleNormalized':len(normalized),'bytes':target.stat().st_size,
        'durationHours':round(duration/3600,2),'verified':True}, indent=1))
main()
