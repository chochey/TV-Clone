"""Validate and atomically publish recovered gap timings for one book (see recover_gaps.py).

Usage (as the service user):  publish_gaps.py <job-dir> <out-dir> [--dry-run]

For every chapter that has an out/gaps-NN.json this checks that:
  * the book text and every paragraph's start/end are exactly the original's,
  * every word timing already in the live document is still there, unchanged,
  * the candidate passes the same chapter validation the word job uses (coverage and independent spot checks),
and then, for the whole document, that the server's own parser (lib/audio-read-along.js) accepts it, the file is
under the reader's size limit and the audiobook is the one the timings were made for. Only then is the live file
replaced (atomically, keeping a one-time backup). Chapters that fail any check are left exactly as they are.
"""
import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))
import settings  # noqa: E402  (tools/readalong/settings.py)
import os
os.environ.setdefault('OMP_NUM_THREADS', '1')
import argparse, copy, json, subprocess, sys, tempfile, time
from pathlib import Path

LIVE_DIR = settings.READ_ALONG_DIR


def atomic(path, value):
    fd, name = tempfile.mkstemp(prefix='.gaps-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, ensure_ascii=False, separators=(',', ':')); f.flush(); os.fsync(f.fileno())
        os.chmod(name, 0o600); os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def strip_chapter(chapter): return {**chapter, 'paragraphs': [{k: v for k, v in p.items() if k != 'words'} for p in chapter['paragraphs']]}
def count(chapter): return sum(len(p.get('words', [])) for p in chapter['paragraphs'])
def timed_paragraphs(chapter): return sum(1 for p in chapter['paragraphs'] if p.get('words'))


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('job'); parser.add_argument('out'); parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(); os.umask(0o077)
    job, out = Path(args.job), Path(args.out)
    sys.path.insert(0, str(job))
    from word_validation import evaluate
    config = json.loads((job / 'job.json').read_text())
    item, audio, repo = config['itemId'], config['audio'], config['repository']
    dest = LIVE_DIR / f'{item}.json'
    original = json.loads((job / 'input.json').read_text())
    raw_live = dest.read_bytes(); live = json.loads(raw_live)
    assert live['itemId'] == item and len(live['chapters']) == len(original['chapters']), 'Wrong or incomplete document'
    document = copy.deepcopy(live)
    completed = set(live.get('wordAlignment', {}).get('completedChapters', []))
    chosen, notes = [], []
    for n in range(1, len(live['chapters']) + 1):
        path = out / f'gaps-{n:02}.json'
        if not path.exists(): continue
        gaps = json.loads(path.read_text()); candidate = gaps['candidate']
        current = live['chapters'][n - 1]
        if strip_chapter(candidate) != original['chapters'][n - 1]: notes.append((n, 'book text or paragraph timing differs from the original; skipped')); continue
        if strip_chapter(current) != original['chapters'][n - 1]: notes.append((n, 'live chapter differs from the original; skipped')); continue
        preserved = all(w in new.get('words', []) for old, new in zip(current['paragraphs'], candidate['paragraphs']) for w in old.get('words', []))
        if not preserved: notes.append((n, 'would change an existing timing; skipped')); continue
        added = count(candidate) - count(current)
        if added <= 0: notes.append((n, 'nothing recovered')); continue
        quality = json.loads((job / f'quality-{n:02}.json').read_text())
        samples = {label: json.loads((job / 'checks' / f'transcript-{n:02}-{label}.json').read_text()) for label in ('begin', 'middle', 'end')}
        report = evaluate(candidate, quality, samples)
        (out / f'validation-{n:02}.json').write_text(json.dumps(report)); os.chmod(out / f'validation-{n:02}.json', 0o600)
        if not report['ok']: notes.append((n, f'does not pass chapter validation (coverage {report["coverage"]}, checks {[c["status"] for c in report["checks"]]}); left as it was')); continue
        document['chapters'][n - 1] = candidate; chosen.append((n, added, count(current), count(candidate), report['coverage'], n not in completed))
    if not chosen:
        for n, why in notes: print(f'chapter {n}: {why}')
        print(json.dumps({'published': False, 'reason': 'no chapter qualified'})); return
    alignment = dict(document.get('wordAlignment', {}))
    done = sorted(completed | {n for n, *_ in chosen})
    alignment['completedChapters'] = done
    alignment['reviewChapters'] = [n for n in alignment.get('reviewChapters', []) if n not in done]
    alignment['gapRecovery'] = {'method': 'wav2vec2-ctc re-alignment inside gaps, words verified by whisper tiny.en', 'recoveredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'chapters': [n for n, *_ in chosen]}
    document['wordAlignment'] = alignment
    prepared = out / 'prepared.json'; atomic(prepared, document)
    size = prepared.stat().st_size   # the reader's own size limit is enforced by the node check below
    check = ("const fs=require('fs'),r=require(process.argv[1]+'/lib/audio-read-along');const d=JSON.parse(fs.readFileSync(process.argv[2]));"
             "const parsed=r.parseDocument(d,d.itemId);const count=x=>x.chapters.reduce((n,c)=>n+c.paragraphs.reduce((m,p)=>m+(p.words?.length||0),0),0);"
             "if(count(parsed)!==count(d)||fs.statSync(process.argv[2]).size>r.MAX_FILE_BYTES)throw Error('Rejected word timing');"
             "if(!r.sameSource(d.source,fs.statSync(process.argv[3])))throw Error('Audio changed');console.log('verified');")
    assert subprocess.check_output(['node', '-e', check, repo, str(prepared), audio], text=True).strip() == 'verified', 'The reader would reject this document'
    summary = {'published': False, 'dryRun': args.dry_run, 'bytes': size,
               'chapters': [{'chapter': n, 'wordsBefore': b, 'wordsAfter': a, 'coverage': c, 'newlyPublished': new} for n, _, b, a, c, new in chosen],
               'wordsBefore': sum(count(c) for c in live['chapters']), 'wordsAfter': sum(count(c) for c in document['chapters']),
               'paragraphsWithWordsBefore': sum(timed_paragraphs(c) for c in live['chapters']), 'paragraphsWithWordsAfter': sum(timed_paragraphs(c) for c in document['chapters']),
               'notes': notes}
    if not args.dry_run:
        backup = out / 'original-read-along-before-gaps.json'
        if not backup.exists(): backup.write_bytes(raw_live); os.chmod(backup, 0o600)
        assert dest.read_bytes() == raw_live, 'The live document changed while this ran; nothing was published'
        atomic(dest, document); summary['published'] = True
    print(json.dumps(summary, indent=1))


if __name__ == '__main__': main()
