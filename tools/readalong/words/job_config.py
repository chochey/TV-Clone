"""Immutable configuration and cache identity for a private offline timing job."""
from pathlib import Path
import hashlib, json, os, stat

ROOT = Path(os.environ.get('READALONG_JOB_ROOT', Path(__file__).resolve().parent)).resolve()
CONFIG = json.loads((ROOT / 'job.json').read_text())
AUDIO = Path(CONFIG['audio'])
MODEL = Path(CONFIG['modelPath'])
WHISPER = Path(CONFIG['whisperPath'])
DEST = Path(CONFIG['destination'])
REPO = Path(CONFIG['repository'])
ITEM_ID = CONFIG['itemId']

def assert_job():
    from align_words import identity, same, atomic
    raw = (ROOT / 'input.json').read_bytes()
    document = json.loads(raw)
    assert document['itemId'] == ITEM_ID, 'Wrong audiobook ID'
    assert same(identity(), document['source']), 'Audiobook changed'
    assert len(document['chapters']) == CONFIG['chapterCount'], 'Incomplete book text'
    assert all('words' not in p for c in document['chapters'] for p in c['paragraphs']), 'Input must be the paragraph-only original'
    fingerprint = {'inputSha256': hashlib.sha256(raw).hexdigest(), 'source': document['source'], 'itemId': ITEM_ID,
                   'modelSha256': hashlib.sha256((MODEL / 'model_quantized.onnx').read_bytes()).hexdigest()}
    path = ROOT / 'cache-identity.json'
    if path.exists():
        assert json.loads(path.read_text()) == fingerprint, 'Cached job input changed; use a new job directory'
    else:
        assert not list(ROOT.glob('words-*.json')) and not list(ROOT.glob('emissions-*.npy')), 'Unbound previous caches exist'
        atomic(path, fingerprint)
    return document
