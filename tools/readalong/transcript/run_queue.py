# Transcribes and publishes read-along for each audiobook in queue.json, one at a time (shortest first). Resumable:
# finished chapters are cached and a book that already has a read-along file is skipped, never overwritten.
import json, os, subprocess, sys, time
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent.parent))
import settings  # noqa: E402  (tools/readalong/settings.py)
T = str(settings.TRANSCRIBE_WORK); REPO = str(settings.APP_DIR)
PY = sys.executable
TRANSCRIBE = str(__import__('pathlib').Path(__file__).resolve().parent / 'transcribe_book.py')
log = lambda **k: print(json.dumps({'at': time.strftime('%Y-%m-%d %H:%M:%S'), **k}), flush=True)
check = ("const fs=require('fs'),r=require(process.argv[1]+'/lib/audio-read-along');const d=JSON.parse(fs.readFileSync(process.argv[2]));"
  "const p=r.parseDocument(d,d.itemId);if(fs.statSync(process.argv[2]).size>r.MAX_FILE_BYTES||!r.sameSource(d.source,fs.statSync(process.argv[3])))throw Error('rejected');"
  "console.log(p.chapters.length)")
for book in json.load(open(f'{T}/queue.json')):
    dest = f"{settings.READ_ALONG_DIR}/{book['id']}.json"
    if os.path.exists(dest): log(book=book['title'], phase='skipped', reason='already has read-along'); continue
    names_file = f"{T}/names/{book['id']}.json"
    names = json.load(open(names_file)).get('names', []) if os.path.exists(names_file) else []
    out = f"{T}/books/{book['id']}"; os.makedirs(out, exist_ok=True)
    job = {'itemId': book['id'], 'audio': book['path'], 'title': book['title'], 'names': names, 'out': out, 'threads': 2}
    json.dump(job, open(f'{out}/job.json', 'w'), indent=1)
    log(book=book['title'], phase='start', hours=book['hours'], names=len(names))
    began = time.time()
    result = subprocess.run([PY, TRANSCRIBE, f'{out}/job.json'], stdout=open(f'{out}/run.log', 'a'), stderr=subprocess.STDOUT)
    if result.returncode != 0: log(book=book['title'], phase='failed', code=result.returncode, see=f'{out}/run.log'); continue
    try:
        chapters = subprocess.check_output(['node', '-e', check, REPO, f'{out}/prepared.json', book['path']], text=True).strip()
    except subprocess.CalledProcessError as error:
        log(book=book['title'], phase='rejected', detail=str(error)); continue
    if os.path.exists(dest): log(book=book['title'], phase='skipped', reason='read-along appeared meanwhile'); continue
    tmp = dest + '.transcript.tmp'
    subprocess.check_call(['cp', f'{out}/prepared.json', tmp]); os.chmod(tmp, 0o600); os.replace(tmp, dest)
    log(book=book['title'], phase='published', chapters=int(chapters), hours=book['hours'], minutes=round((time.time() - began) / 60))
log(phase='queue finished')
