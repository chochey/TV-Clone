"""Recover word timings for paragraphs the word job withheld, without trusting any single recognizer.

The word job (align_words.py) drops every word of a paragraph when a weak greedy decode disagrees with the
book, so announcer voices, shouted lines and quick dialogue lose their word highlights. Here each run of
such paragraphs is re-aligned *inside the gap between its well-timed neighbours* (wav2vec2 CTC, the same
forced aligner), and a word is kept only if an independent recognizer (Whisper tiny.en) hears the same
word at about the same time, or the aligner is very sure of it. Nothing already timed is ever changed.

Usage (as the service user):  recover_gaps.py <job-dir> <chapter> [<chapter> ...] [--force]
Writes <work>/gaps-NN.json per chapter (the candidate chapter plus a per-paragraph report); it never
publishes. Publishing is a separate, validated step.
"""
import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))
import settings  # noqa: E402  (tools/readalong/settings.py)
import os
os.environ.setdefault('OMP_NUM_THREADS', '2'); os.environ.setdefault('OPENBLAS_NUM_THREADS', '1'); os.environ.setdefault('HF_HUB_OFFLINE', '1')
import argparse, copy, difflib, json, math, re, statistics, sys, tempfile, time
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gapalign as g

LIVE_DIR = settings.READ_ALONG_DIR
MIN_WORD_SCORE = .15            # same floor the word job uses
SURE_SCORE = .5                 # a word this well matched needs no second opinion
NEAR = .6                       # seconds: how far Whisper's time for a word may be from the aligned interval
MAX_GAP = 150                   # longest window (s) aligned in one piece


def log(**values): print(json.dumps(values, ensure_ascii=False), flush=True)


def atomic(path, value):
    fd, name = tempfile.mkstemp(prefix='.gaps-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, ensure_ascii=False, separators=(',', ':')); f.flush(); os.fsync(f.fileno())
        os.chmod(name, 0o600); os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def spoken_tokens(value):
    """Same normalisation word_validation.py uses to compare book text with recognised speech."""
    from num2words import num2words
    value = str(value).replace('’', "'").replace('‘', "'")
    def expand(match):
        text = match[0]
        try: return num2words(text[:-2].replace(',', ''), to='ordinal') if re.search(r'(st|nd|rd|th)$', text) else num2words(text.replace(',', ''))
        except (ValueError, TypeError, NotImplementedError): return text
    value = re.sub(r'\b\d+(?:,\d{3})*(?:\.\d+)?(?:st|nd|rd|th)?\b', expand, value.lower())
    return re.findall(r'[a-z0-9]+', value)


def has_letters(p): return any(c.isalpha() for c in p['text'])
def timed(p): return bool(p.get('words'))


def runs_of(paragraphs):
    """Consecutive paragraphs with no words (ignoring ones that contain no letters, e.g. '* * *')."""
    result = []; i = 0
    while i < len(paragraphs):
        if not timed(paragraphs[i]) and has_letters(paragraphs[i]):
            j = i
            while j + 1 < len(paragraphs) and not timed(paragraphs[j + 1]): j += 1
            while j > i and not has_letters(paragraphs[j]): j -= 1
            result.append((i, j)); i = j + 1
        else: i += 1
    return result


def gap_of(chapter, i, j):
    ps = chapter['paragraphs']
    prev = next((k for k in range(i - 1, -1, -1) if timed(ps[k])), None)
    nxt = next((k for k in range(j + 1, len(ps)) if timed(ps[k])), None)
    a = ps[prev]['words'][-1][3] if prev is not None else chapter['start']
    b = ps[nxt]['words'][0][2] if nxt is not None else chapter['end']
    return a, b


def source_tokens(text):
    """[(token, charStart, charEnd)] per \\S+ word, in the same UTF-16 offsets the sidecar uses."""
    out = []
    for m in re.finditer(r'\S+', text):
        a = len(text[:m.start()].encode('utf-16-le')) // 2; b = len(text[:m.end()].encode('utf-16-le')) // 2
        for t in spoken_tokens(m[0]): out.append((t, a, b))
    return out


def verify(paragraph, rows, heard):
    """Compare aligned words with what Whisper heard. Returns {(a, b): distance} for matched source words."""
    src = source_tokens(paragraph['text'])
    interval = {(a, b): (lo, hi) for a, b, lo, hi, *_ in rows}
    hear_tokens, hear_times = [], []
    for s, e, w in heard:
        for t in spoken_tokens(w): hear_tokens.append(t); hear_times.append((s + e) / 2)
    distances = {}
    matcher = difflib.SequenceMatcher(a=[t for t, _, _ in src], b=hear_tokens, autojunk=False)
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            _, a, b = src[block.a + k]
            if (a, b) in interval:
                lo, hi = interval[(a, b)]; t = hear_times[block.b + k]
                distances[(a, b)] = max(lo - t, t - hi, 0)
    return distances


def settle(rows, paragraph):
    """Make word times monotonic and inside the paragraph, as the word job does (midpoint between neighbours)."""
    out = []
    for r in rows:
        a, b, lo, hi = r[0], r[1], r[2], r[3]
        lo = max(lo, paragraph['start'], out[-1][3] if out else paragraph['start']); hi = min(hi, paragraph['end'])
        if hi - lo >= .025 and hi - lo <= max(3, (b - a) * .3): out.append([a, b, round(lo, 3), round(hi, 3)])
    return out


def recover_chapter(n, doc, chapter, audio, acoustic, whisper, quality_words):
    candidate = copy.deepcopy(chapter); ps = candidate['paragraphs']
    report = []; vocab = acoustic.vocab
    for (i, j) in runs_of(ps):
        a, b = gap_of(candidate, i, j)
        if b - a > MAX_GAP:
            for k in range(i, j + 1): report.append({'index': k, 'status': 'withheld', 'reason': f'gap longer than {MAX_GAP}s'})
            continue
        w0, w1 = max(chapter['start'], a - .25), min(chapter['end'], b + .25)
        try: emission = acoustic.window(audio, w0, w1)
        except Exception as error:
            for k in range(i, j + 1): report.append({'index': k, 'status': 'withheld', 'reason': f'audio: {str(error)[:60]}'})
            continue
        ids, maps = [], []
        for k in range(i, j + 1):
            t_ids, mapping = g.tokens(ps[k]['text'], vocab)
            if len(t_ids) == 0: continue
            if ids: ids.append(vocab['|'])
            offset = len(ids); ids.extend(t_ids.tolist())
            maps.append((k, [(x, y, bg + offset, en + offset, w) for x, y, bg, en, w in mapping]))
        if not maps: continue
        ids = np.array(ids, dtype=np.int32)
        try: frames = g.align_ctc(emission, ids)
        except ValueError as error:
            for k, _ in maps: report.append({'index': k, 'status': 'withheld', 'reason': f'alignment: {str(error)[:60]}'})
            continue
        for k, mapping in maps:
            p = ps[k]
            rows = g.paragraph_words(p['text'], emission, frames, mapping, ids, vocab, w0, chapter['start'], chapter['end'])
            # same midpoint rule the word job uses where neighbouring words overlap
            for q in range(len(rows) - 1):
                if rows[q][3] > rows[q + 1][2]:
                    mid = max(rows[q][2], (rows[q][3] + rows[q + 1][2]) / 2); rows[q][3] = round(mid, 3); rows[q + 1][2] = round(mid, 3)
            scores = [r[4] for r in rows]
            # Whisper listens only around where this paragraph was placed: a wide window containing long silences
            # makes its word times drift by a second or more, and "do you hear these words *here*?" is the real question.
            claimed = [r for r in rows if r[4] >= MIN_WORD_SCORE] or rows
            lo_t = max(chapter['start'], min(r[2] for r in claimed) - .6); hi_t = min(chapter['end'], max(r[3] for r in claimed) + .6)
            try: heard = whisper.words(audio, lo_t, hi_t)
            except Exception: heard = []
            distances = verify(p, rows, heard)
            kept_rows = []
            for r in rows:
                key = (r[0], r[1]); d = distances.get(key)
                if r[4] < MIN_WORD_SCORE: continue
                if d is not None and d > 1.0: continue                  # Whisper heard this word somewhere else
                if r[4] >= SURE_SCORE or (d is not None and d <= NEAR): kept_rows.append(r)
            matched = [d for d in distances.values()]
            verified = [d for d in matched if d <= NEAR]
            info = {'index': k, 'id': p['id'], 'words': len(rows), 'medianScore': round(statistics.median(scores), 3),
                    'confident': sum(s >= SURE_SCORE for s in scores), 'kept': len(kept_rows),
                    'whisperMatched': len(matched), 'whisperNear': len(verified),
                    'medianDistance': round(statistics.median(matched), 3) if matched else None}
            enough = len(kept_rows) >= max(2, math.ceil(.4 * len(rows)))
            agreed = (not matched) or (statistics.median(matched) <= .5)
            supported = len(verified) >= 2 or sum(r[4] >= SURE_SCORE for r in kept_rows) >= max(3, math.ceil(.5 * len(rows)))
            if enough and agreed and supported:
                words = settle(kept_rows, p)
                if len(words) >= 2:
                    p['words'] = words; info['status'] = 'recovered'; info['kept'] = len(words)
                else: info['status'] = 'withheld'; info['reason'] = 'too few usable words'
            else:
                info['status'] = 'withheld'
                info['reason'] = ('few confident words' if not enough else 'recognizers disagree on timing' if not agreed else 'not independently supported')
            report.append(info)
    return candidate, report


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('job'); parser.add_argument('chapters', nargs='*', type=int)
    parser.add_argument('--force', action='store_true'); parser.add_argument('--out')
    parser.add_argument('--use-candidate', action='store_true', help='for a chapter that is not live, start from the job\'s candidate (which its own validation may have rejected) instead of its base alignment')
    args = parser.parse_args(); os.umask(0o077)
    job = Path(args.job); config = json.loads((job / 'job.json').read_text())
    audio = config['audio']; item = config['itemId']
    out = Path(args.out) if args.out else job.parent / f'gaps-{item}'
    out.mkdir(exist_ok=True, mode=0o700)
    live = json.loads((LIVE_DIR / f'{item}.json').read_text())
    acoustic = g.Acoustic(); whisper = g.Whisper()
    order = args.chapters or list(range(1, len(live['chapters']) + 1))
    for n in order:
        target = out / f'gaps-{n:02}.json'
        if target.exists() and not args.force: log(chapter=n, phase='cached'); continue
        chapter = live['chapters'][n - 1]
        if not any(timed(p) for p in chapter['paragraphs']):
            # a chapter held back by chapter-level validation: start from the job's own best (candidate, else base) result
            for name in ((f'candidate-{n:02}.json', f'words-{n:02}.json') if args.use_candidate else (f'words-{n:02}.json',)):
                if (job / name).exists(): chapter = json.loads((job / name).read_text()); break
        quality = json.loads((job / f'quality-{n:02}.json').read_text())
        began = time.monotonic()
        before = sum(len(p.get('words', [])) for p in chapter['paragraphs'])
        candidate, report = recover_chapter(n, live, chapter, audio, acoustic, whisper, sum(q['words'] for q in quality))
        after = sum(len(p.get('words', [])) for p in candidate['paragraphs'])
        total = sum(q['words'] for q in quality)
        # nothing already timed may change
        for old, new in zip(chapter['paragraphs'], candidate['paragraphs']):
            assert all(w in new.get('words', []) for w in old.get('words', [])), 'a confirmed timing changed'
        atomic(target, {'chapter': n, 'before': before, 'after': after, 'sourceWords': total,
                        'coverageBefore': round(before / max(1, total), 4), 'coverageAfter': round(after / max(1, total), 4),
                        'report': report, 'candidate': candidate})
        log(chapter=n, phase='recovered', wordsBefore=before, wordsAfter=after, coverageBefore=round(before / max(1, total), 3),
            coverageAfter=round(after / max(1, total), 3), recovered=sum(r.get('status') == 'recovered' for r in report),
            withheld=sum(r.get('status') == 'withheld' for r in report), seconds=round(time.monotonic() - began))


if __name__ == '__main__': main()
