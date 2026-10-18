"""Recover short, acoustically supported omissions without changing old tuples."""
import os
os.environ['OMP_NUM_THREADS'] = '1'; os.environ['OPENBLAS_NUM_THREADS'] = '1'
import copy, json, sys
import numpy as np
from align_words import ROOT, STEP, atomic, log
from job_config import assert_job
from recovery import recover, addition_checks
from word_validation import evaluate

def run(n):
    assert_job()
    old = json.loads((ROOT / f'words-{n:02}.json').read_text())
    candidate = copy.deepcopy(old)
    emissions = np.load(ROOT / f'emissions-{n:02}.npy').astype(np.float32)
    assert emissions.ndim == 2 and emissions.shape[1] == 32 and np.isfinite(emissions).all()
    quality = json.loads((ROOT / f'quality-{n:02}.json').read_text())
    for p in candidate['paragraphs']:
        lo = max(0, int((p['start'] - old['start'] - .8) / STEP))
        hi = min(len(emissions), int(np.ceil((p['end'] - old['start'] + .8) / STEP)))
        try:
            added, _ = recover(p, emissions[lo:hi], old['start'] + lo * STEP)
        except (ValueError, AssertionError):
            continue
        if added:
            p['words'] = sorted(p.get('words', []) + added, key=lambda w: w[0])
    samples = {label: json.loads((ROOT / 'checks' / f'transcript-{n:02}-{label}.json').read_text()) for label in ('begin', 'middle', 'end')}
    validation = evaluate(candidate, quality, samples)
    added_checks = addition_checks(candidate, samples, old)
    matched = sum(c['newMatches'] for c in added_checks)
    passed = all(c['median'] <= .2 and c['p90'] <= .6 and c['max'] <= .6 for c in added_checks if c['newMatches'])
    accepted = validation['ok'] and matched > 0 and passed
    for prior, current in zip(old['paragraphs'], candidate['paragraphs']):
        indexed = {tuple(w[:2]): w for w in current.get('words', [])}
        assert all(indexed.get(tuple(w[:2])) == w for w in prior.get('words', [])), 'Recovery changed a previously confirmed timing'
    report = {'chapter': n, 'accepted': accepted, 'before': sum(len(p.get('words', [])) for p in old['paragraphs']),
              'after': sum(len(p.get('words', [])) for p in candidate['paragraphs']), 'validation': validation,
              'independentAdditions': matched, 'addedChecks': [{k: v for k, v in c.items() if k != 'words'} for c in added_checks]}
    atomic(ROOT / f'candidate-{n:02}.json', candidate)
    atomic(ROOT / f'recovery-{n:02}.json', report)
    log(phase='recovered confirmed omissions', **report)

if __name__ == '__main__':
    os.umask(0o077)
    for value in sys.argv[1:]:
        run(int(value))
