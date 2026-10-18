"""Validate and atomically publish only confirmed word timings for this book."""
from pathlib import Path
import copy, json, os, stat, subprocess
from align_words import identity, same, atomic, log
from job_config import ROOT, AUDIO, DEST, REPO, MODEL, ITEM_ID, assert_job
from word_validation import evaluate
from recovery import addition_checks

def strip_chapter(chapter):
    return {**chapter, 'paragraphs': [{k: v for k, v in p.items() if k != 'words'} for p in chapter['paragraphs']]}

def strip_document(document):
    result = copy.deepcopy(document)
    result.pop('wordAlignment', None)
    result['chapters'] = [strip_chapter(c) for c in result['chapters']]
    return result

def choose(n, original):
    path = ROOT / f'words-{n:02}.json'
    if not path.exists():
        return None, None
    base = json.loads(path.read_text())
    assert strip_chapter(base) == original, 'Book text or paragraph timing changed'
    quality = json.loads((ROOT / f'quality-{n:02}.json').read_text())
    samples = {label: json.loads((ROOT / 'checks' / f'transcript-{n:02}-{label}.json').read_text()) for label in ('begin', 'middle', 'end')}
    selected = base
    candidate_path = ROOT / f'candidate-{n:02}.json'
    if candidate_path.exists():
        candidate = json.loads(candidate_path.read_text())
        assert strip_chapter(candidate) == original, 'Recovery changed book content'
        for prior, current in zip(base['paragraphs'], candidate['paragraphs']):
            indexed = {tuple(w[:2]): w for w in current.get('words', [])}
            assert all(indexed.get(tuple(w[:2])) == w for w in prior.get('words', [])), 'Recovery changed a confirmed timing'
        additions = addition_checks(candidate, samples, base)
        verified = sum(c['newMatches'] for c in additions)
        good = all(c['median'] <= .2 and c['p90'] <= .6 and c['max'] <= .6 for c in additions if c['newMatches'])
        if verified and good and evaluate(candidate, quality, samples)['ok']:
            selected = candidate
    report = evaluate(selected, quality, samples)
    atomic(ROOT / f'validation-{n:02}.json', report)
    return selected, report

def publish():
    document = assert_job()
    baseline = copy.deepcopy(document)
    passed, failed = [], []
    for n, chapter in enumerate(document['chapters'], 1):
        selected, report = choose(n, chapter)
        if selected is None:
            continue
        if report['ok']:
            document['chapters'][n - 1] = selected; passed.append(n)
        else:
            failed.append(n)
    if not passed:
        log(publishedChapters=[], reviewChapters=failed, live=False); return
    document['wordAlignment'] = {'method': 'wav2vec2-ctc', 'model': json.loads((MODEL / 'provenance.json').read_text()),
        'completedChapters': passed, 'reviewChapters': failed}
    prepared = ROOT / 'prepared.json'
    atomic(prepared, document)
    check = "const fs=require('fs'),r=require(process.argv[1]+'/lib/audio-read-along');const d=JSON.parse(fs.readFileSync(process.argv[2]));const parsed=r.parseDocument(d,d.itemId);const count=x=>x.chapters.reduce((n,c)=>n+c.paragraphs.reduce((m,p)=>m+(p.words?.length||0),0),0);if(count(parsed)!==count(d)||fs.statSync(process.argv[2]).size>r.MAX_FILE_BYTES)throw Error('Rejected word timing');if(!r.sameSource(d.source,fs.statSync(process.argv[3])))throw Error('Audio changed');console.log('verified');"
    assert subprocess.check_output(['node', '-e', check, str(REPO), str(prepared), str(AUDIO)], text=True).strip() == 'verified'
    if os.environ.get('PUBLISH_WORDS') == '1':
        assert DEST == REPO / 'data' / 'read-along' / f'{ITEM_ID}.json', 'Unexpected publication path'
        assert stat.S_ISDIR(DEST.parent.lstat().st_mode) and stat.S_ISREG(DEST.lstat().st_mode), 'Unsafe publication path'
        assert os.geteuid() == DEST.stat().st_uid, 'Run as the document owner'
        original_bytes = DEST.read_bytes()
        prior = json.loads(original_bytes)
        assert strip_document(prior) == baseline, 'Read-along changed outside this job'
        for prior_chapter, current in zip(prior['chapters'], document['chapters']):
            for prior_p, current_p in zip(prior_chapter['paragraphs'], current['paragraphs']):
                indexed = {tuple(w[:2]): w for w in current_p.get('words', [])}
                assert all(indexed.get(tuple(w[:2])) == w for w in prior_p.get('words', [])), 'Would remove published word timings'
        backup = ROOT / 'original-read-along.json'
        if not backup.exists():
            atomic(backup, prior)
        assert DEST.read_bytes() == original_bytes and same(identity(), baseline['source']), 'Source changed before publication'
        atomic(DEST, document)
    log(publishedChapters=passed, reviewChapters=failed, bytes=prepared.stat().st_size, live=os.environ.get('PUBLISH_WORDS') == '1')

if __name__ == '__main__':
    os.umask(0o077)
    publish()
