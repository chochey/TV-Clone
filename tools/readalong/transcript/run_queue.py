# Transcribes and publishes read-along for each audiobook in the queue, one at a time. Resumable: finished chapters
# are cached. A book that already has read-along is skipped and never overwritten, unless --replace is given and its
# read-along was made from an ebook: then the transcript replaces it once it is ready, and the old file is kept in
# <work>/replaced. The queue is <work>/queue.json (shortest first), or --match builds it from the library, with
# --first naming the books to do first (the Dungeon Crawler Carl books, 2026-11-09, whose ebook text drifted from the
# full-cast performance). Names come from <work>/names/<id>.json, or with --names-from-existing from the current
# read-along's own text. --dry-run prints what would happen and changes nothing.
import argparse, json, os, shutil, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import settings  # noqa: E402  (tools/readalong/settings.py)
from queue_tools import library_queue, names_from_document, plan  # noqa: E402
T = str(settings.TRANSCRIBE_WORK); REPO = str(settings.APP_DIR)
PY = sys.executable
TRANSCRIBE = os.environ.get('READALONG_TRANSCRIBE') or str(Path(__file__).resolve().parent / 'transcribe_book.py')
log = lambda **k: print(json.dumps({'at': time.strftime('%Y-%m-%d %H:%M:%S'), **k}), flush=True)
check = ("const fs=require('fs'),r=require(process.argv[1]+'/lib/audio-read-along');const d=JSON.parse(fs.readFileSync(process.argv[2]));"
  "const p=r.parseDocument(d,d.itemId);if(fs.statSync(process.argv[2]).size>r.MAX_FILE_BYTES||!r.sameSource(d.source,fs.statSync(process.argv[3])))throw Error('rejected');"
  "console.log(p.chapters.length)")


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


parser = argparse.ArgumentParser(description='Transcribe audiobooks into read-along documents.')
parser.add_argument('--queue', default=f'{T}/queue.json')
parser.add_argument('--match', help='build the queue from the library: audiobooks whose title contains this')
parser.add_argument('--first', default='', help='comma-separated item ids to do first')
parser.add_argument('--replace', action='store_true', help='replace read-along made from an ebook, keeping the old file')
parser.add_argument('--names-from-existing', action='store_true', help='name hints from the current read-along when there is no names file')
parser.add_argument('--dry-run', action='store_true')
args = parser.parse_args()

if args.match:
    library = read_json(settings.DATA_DIR / 'library_cache.json') or []
    items = library if isinstance(library, list) else library.get('items', [])
    queue = library_queue(items, args.match, [i for i in args.first.split(',') if i])
else:
    queue = json.load(open(args.queue))
for book in queue:
    dest = f"{settings.READ_ALONG_DIR}/{book['id']}.json"
    existing = read_json(dest) if os.path.exists(dest) else None
    decision = plan(existing, args.replace)
    if decision != 'transcribe':
        log(book=book['title'], phase='skipped', reason=decision.split(': ', 1)[1]); continue
    names_file = f"{T}/names/{book['id']}.json"
    if os.path.exists(names_file): names = json.load(open(names_file)).get('names', [])
    elif args.names_from_existing and existing: names = names_from_document(existing)
    else: names = []
    if args.dry_run:
        log(book=book['title'], phase='would transcribe', replaces=existing is not None, names=names); continue
    out = f"{T}/books/{book['id']}"; os.makedirs(out, exist_ok=True)
    job = {'itemId': book['id'], 'audio': book['path'], 'title': book['title'], 'names': names, 'out': out, 'threads': 2}
    json.dump(job, open(f'{out}/job.json', 'w'), indent=1)
    log(book=book['title'], phase='start', hours=book.get('hours'), names=len(names), replaces=existing is not None)
    began = time.time()
    result = subprocess.run([PY, TRANSCRIBE, f'{out}/job.json'], stdout=open(f'{out}/run.log', 'a'), stderr=subprocess.STDOUT)
    if result.returncode != 0: log(book=book['title'], phase='failed', code=result.returncode, see=f'{out}/run.log'); continue
    try:
        chapters = subprocess.check_output(['node', '-e', check, REPO, f'{out}/prepared.json', book['path']], text=True).strip()
    except subprocess.CalledProcessError as error:
        log(book=book['title'], phase='rejected', detail=str(error)); continue
    current = read_json(dest) if os.path.exists(dest) else None
    if os.path.exists(dest) and plan(current, args.replace) != 'transcribe':
        log(book=book['title'], phase='skipped', reason='read-along changed meanwhile'); continue
    kept = None
    if os.path.exists(dest):
        os.makedirs(f'{T}/replaced', exist_ok=True)
        kept = f"{T}/replaced/{book['id']}.{time.strftime('%Y%m%d-%H%M%S')}.json"
        shutil.copy2(dest, kept); os.chmod(kept, 0o600)
    tmp = dest + '.transcript.tmp'
    subprocess.check_call(['cp', f'{out}/prepared.json', tmp]); os.chmod(tmp, 0o600); os.replace(tmp, dest)
    log(book=book['title'], phase='published', chapters=int(chapters), hours=book.get('hours'), kept=kept,
        minutes=round((time.time() - began) / 60))
log(phase='queue finished')
