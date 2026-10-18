# Publishes held-back chapters whose independent timing check passed (see check_chapters.py), one book at a time,
# with the same safety checks as publish_gaps.py: text unchanged, server's own parser, size limit, audio unchanged,
# live file unchanged meanwhile, backup kept, atomic replace.
import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))
import settings  # noqa: E402  (tools/readalong/settings.py)
import json, os, shutil, subprocess, sys, time
REPO = str(settings.APP_DIR); W = str(settings.GAPS_WORK)
ok = lambda r: 'error' not in r and r['matched'] >= 100 and r['within'] >= .97 and r['median'] <= .1 and (r['coverage'] or 0) >= .65
results = [json.loads(line) for line in open(sys.argv[1])]
dry = '--dry-run' in sys.argv
by_item = {}
for r in results: by_item.setdefault(r['item'], []).append(r)
report = []
for item, rows in by_item.items():
    passing = [r for r in rows if ok(r)]
    report.append({'book': rows[0]['book'], 'passing': [r['chapter'] for r in passing], 'notPassing': [(r['chapter'], r.get('error') or {k: r[k] for k in ('coverage', 'matched', 'within', 'median')}) for r in rows if not ok(r)]})
    if not passing or dry: continue
    live_path = f'{settings.READ_ALONG_DIR}/{item}.json'; raw = open(live_path, 'rb').read(); live = json.loads(raw)
    for r in passing:
        n = r['chapter']; cand = json.load(open(f'{W}/out-{item}/gaps-{n:02}.json'))['candidate']; old = live['chapters'][n - 1]
        assert old['id'] == cand['id'] and not any(p.get('words') for p in old['paragraphs'])
        assert [(p['id'], p['text'], p['start'], p['end']) for p in old['paragraphs']] == [(p['id'], p['text'], p['start'], p['end']) for p in cand['paragraphs']], f'chapter {n} text differs'
        live['chapters'][n - 1] = dict(old, paragraphs=[dict(o, **({'words': c['words']} if c.get('words') else {})) for o, c in zip(old['paragraphs'], cand['paragraphs'])])
    wa = live.get('wordAlignment')
    if isinstance(wa, dict):
        chosen = {r['chapter'] for r in passing}
        wa['completedChapters'] = sorted(set(wa.get('completedChapters', [])) | chosen)
        wa['reviewChapters'] = [n for n in wa.get('reviewChapters', []) if n not in chosen]
        wa['manualApprovals'] = wa.get('manualApprovals', []) + [{'chapter': r['chapter'], 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'reason': f"independent {r['windows']}-window check: {r['within']:.1%} of {r['matched']} words within 0.6 s, median {r['median']} s; coverage {r['coverage']}"} for r in passing]
    out = f'{W}/approved-{item}'; os.makedirs(out, exist_ok=True)
    prepared = f'{out}/prepared.json'; open(prepared, 'w').write(json.dumps(live, ensure_ascii=False, separators=(',', ':')))
    audio = json.load(open(rows[0]['job'] + '/job.json'))['audio']
    check = ("const fs=require('fs'),r=require(process.argv[1]+'/lib/audio-read-along');const d=JSON.parse(fs.readFileSync(process.argv[2]));"
      "const p=r.parseDocument(d,d.itemId);const n=x=>x.chapters.reduce((a,c)=>a+c.paragraphs.reduce((b,q)=>b+(q.words?.length||0),0),0);"
      "if(n(p)!==n(d)||fs.statSync(process.argv[2]).size>r.MAX_FILE_BYTES||!r.sameSource(d.source,fs.statSync(process.argv[3])))throw Error('rejected');console.log(n(p))")
    words = int(subprocess.check_output(['node', '-e', check, REPO, prepared, audio], text=True).strip())
    assert open(live_path, 'rb').read() == raw, 'live document changed meanwhile'
    shutil.copy2(live_path, f'{out}/before-approval.json')
    tmp = live_path + '.approve.tmp'; shutil.copyfile(prepared, tmp); os.chmod(tmp, 0o600); os.replace(tmp, live_path)
    report[-1].update(published=True, words=words, chaptersWithWords=sum(1 for c in live['chapters'] if any(p.get('words') for p in c['paragraphs'])), chapters=len(live['chapters']))
print(json.dumps(report, indent=1))
