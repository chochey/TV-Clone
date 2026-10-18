# Independent timing check of held-back chapters: Whisper listens to up to 6 windows of 30 s spread across each chapter,
# and we measure how far each word it hears falls from where the repaired candidate would highlight it.
import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))
import settings  # noqa: E402  (tools/readalong/settings.py)
import json, sys, difflib, statistics
sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent))
import gapalign as g
plan = json.load(open(sys.argv[1]))
whisper = g.Whisper()
for entry in plan:
    result = dict(entry)
    try:
        if not entry['gaps']: raise ValueError('no repaired candidate')
        gaps = json.load(open(f"{settings.GAPS_WORK}/out-{entry['item']}/gaps-{entry['chapter']:02}.json"))
        chapter, audio = gaps['candidate'], json.load(open(entry['job'] + '/job.json'))['audio']
        timed = [(tok, s, e) for p in chapter['paragraphs'] for a, b, s, e in p.get('words', []) for tok in g.normalize(p['text'][a:b]).split()]
        if not timed: raise ValueError('no timed words')
        start, end = chapter['start'], chapter['end']
        count = max(1, min(6, int((end - start - 30) // 60)))
        dists, heard_total = [], 0
        for k in range(count):
            w0 = start + 15 + (k * (end - start - 45) / (count - 1) if count > 1 else 0)
            heard = [(tok, s, e) for s, e, word in whisper.words(audio, w0, min(end, w0 + 30)) for tok in g.normalize(word).split()]
            heard_total += len(heard)
            ref = [t for t in timed if w0 - 5 <= t[1] <= w0 + 35]
            sm = difflib.SequenceMatcher(None, [t[0] for t in heard], [t[0] for t in ref], autojunk=False)
            for blk in sm.get_matching_blocks():
                for i in range(blk.size):
                    h, r = heard[blk.a + i], ref[blk.b + i]; mid = (h[1] + h[2]) / 2
                    dists.append(max(r[1] - mid, mid - r[2], 0))
        result.update(coverage=gaps.get('coverageAfter'), windows=count, heard=heard_total, matched=len(dists),
            within=round(sum(d <= .6 for d in dists) / len(dists), 3) if dists else 0,
            median=round(statistics.median(dists), 3) if dists else None, p95=round(sorted(dists)[int(len(dists) * .95)], 3) if dists else None)
    except Exception as error:
        result['error'] = str(error)
    print(json.dumps(result), flush=True)
