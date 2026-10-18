"""Resume a private book job and retire large caches after verified publication."""
import fcntl, hashlib, json, os, subprocess, sys, time
from pathlib import Path
from align_words import atomic, log
from job_config import ROOT, DEST, assert_job

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def outputs(n):
    return {name: digest(ROOT / f'{name}-{n:02}.json') for name in ('words', 'quality', 'candidate', 'recovery', 'validation')}

def main():
    os.umask(0o077)
    lock = (ROOT / 'job.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    document = assert_job()
    scripts = Path(__file__).resolve().parent
    order = [int(x) for x in sys.argv[1:]] or range(1, len(document['chapters']) + 1)
    for n in order:
        assert 1 <= n <= len(document['chapters'])
        marker = ROOT / f'completed-step-{n:02}.json'
        if marker.exists():
            prior = json.loads(marker.read_text())
            assert prior['outputs'] == outputs(n), 'Completed chapter files changed'
            log(chapter=n, phase='confirmed chapter already completed')
            continue
        for script in ('make_checks.py', 'align_words.py', 'recover_chapter.py'):
            # The input/model fingerprint was checked above. Recovery and its
            # candidate are written atomically before publication; after a
            # restart they need no large acoustic cache to be revalidated.
            if script == 'recover_chapter.py' and (ROOT / f'candidate-{n:02}.json').exists() and (ROOT / f'recovery-{n:02}.json').exists():
                continue
            log(chapter=n, phase=script.removesuffix('.py'))
            subprocess.run([sys.executable, str(scripts / script), str(n)], check=True, timeout=7200)
        subprocess.run([sys.executable, str(scripts / 'publish_words.py')], check=True, timeout=180)
        report = json.loads((ROOT / f'validation-{n:02}.json').read_text())
        if report['ok']:
            live = json.loads(DEST.read_text())
            prepared = json.loads((ROOT / 'prepared.json').read_text())
            assert n in live['wordAlignment']['completedChapters'], 'Chapter was not published'
            assert live['chapters'][n - 1] == prepared['chapters'][n - 1], 'Published chapter changed'
            atomic(marker, {'chapter': n, 'outputs': outputs(n), 'published': True})
            # Emissions can be regenerated from the unchanged audiobook. This
            # bounds disk usage to one active chapter plus review chapters.
            cache = ROOT / f'emissions-{n:02}.npy'
            if cache.exists():
                assert cache.is_file() and not cache.is_symlink(), 'Unsafe cache path'
                cache.unlink()
            log(chapter=n, phase='published; acoustic cache released')
    subprocess.run([sys.executable, str(scripts / 'publish_words.py')], check=True, timeout=180)
    reports = {n: json.loads(p.read_text()) for n in range(1, len(document['chapters']) + 1) if (p := ROOT / f'validation-{n:02}.json').exists()}
    result = {'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'completedChapters': [n for n, r in reports.items() if r['ok']], 'reviewChapters': [n for n, r in reports.items() if not r['ok']]}
    if len(reports) == len(document['chapters']): atomic(ROOT / 'finished.json', result)
    log(phase='finished' if len(reports) == len(document['chapters']) else 'pilot finished', **result)

if __name__ == '__main__': main()
