"""run_queue.py end to end on a made-up library: a fake transcriber stands in for Whisper, and the server's own
parser (lib/audio-read-along.js) judges the result, as on the live box. The case is the Dungeon Crawler Carl redo
(2026-11-09): ebook-made read-along replaced by a transcript, the old file kept, names taken from the ebook text."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN_QUEUE = HERE.parent / 'transcript' / 'run_queue.py'
REPO = HERE.parent.parent.parent
EBOOK_ID, DONE_ID, OTHER_ID = 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'

FAKE_TRANSCRIBER = textwrap.dedent('''
    import json, os, sys
    job = json.load(open(sys.argv[1]))
    st = os.stat(job['audio'])
    doc = {'version': 1, 'itemId': job['itemId'], 'title': job['title'], 'origin': 'transcript',
           'source': {'size': st.st_size, 'mtimeMs': st.st_mtime_ns / 1e6, 'ctimeMs': st.st_ctime_ns / 1e6, 'dev': st.st_dev, 'ino': st.st_ino},
           'duration': 10, 'chapters': [{'id': 'chapter-01', 'title': 'Chapter 1', 'start': 0, 'end': 10, 'paragraphs': [
               {'id': 'c01-p001', 'text': 'Hello Donut', 'start': 0, 'end': 1, 'words': [[0, 5, 0, 0.5], [6, 11, 0.5, 1]]}]}]}
    json.dump(doc, open(os.path.join(job['out'], 'prepared.json'), 'w'))
''')


class RunQueueTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        root = Path(self.dir.name)
        self.data, self.work, self.audio = root / 'data', root / 'work', root / 'audio'
        for d in (self.data / 'read-along', self.work, self.audio):
            d.mkdir(parents=True)
        items = []
        for item_id, title in [(EBOOK_ID, 'The Gate of the Feral Gods: Dungeon Crawler Carl, Book 4'),
                               (DONE_ID, 'Dungeon Crawler Carl: Dungeon Crawler Carl, Book 1'), (OTHER_ID, "Old Man's War")]:
            path = self.audio / f'{item_id}.m4b'
            path.write_bytes(b'audio' * 10)
            items.append({'id': item_id, 'title': title, 'mediaKind': 'audio', '_filePath': str(path), 'filename': path.name})
        (self.data / 'library_cache.json').write_text(json.dumps(items))
        self.ebook = {'version': 1, 'itemId': EBOOK_ID, 'chapters': [{'paragraphs': [
            {'text': 'Then she looked at Donut and Mordecai, and said Donut was right.'}] * 5}]}
        (self.data / 'read-along' / f'{EBOOK_ID}.json').write_text(json.dumps(self.ebook))
        (self.data / 'read-along' / f'{DONE_ID}.json').write_text(json.dumps({'origin': 'transcript', 'title': 'already done'}))
        self.fake = root / 'fake_transcribe.py'
        self.fake.write_text(FAKE_TRANSCRIBER)

    def run_queue(self, *extra):
        env = dict(os.environ, TVCLONE_DATA_DIR=str(self.data), READALONG_TRANSCRIBE_WORK=str(self.work),
                   TVCLONE_REPO_DIR=str(REPO), READALONG_TRANSCRIBE=str(self.fake))
        out = subprocess.run([sys.executable, str(RUN_QUEUE), '--match', 'Dungeon Crawler Carl', *extra],
                             env=env, capture_output=True, text=True, check=True).stdout
        return [json.loads(line) for line in out.splitlines()]

    def test_an_ebook_read_along_is_replaced_by_the_transcript_and_kept(self):
        lines = self.run_queue('--replace', '--names-from-existing')
        by_book = {line.get('book'): line for line in lines if line.get('phase') in ('published', 'skipped')}
        self.assertEqual(by_book['The Gate of the Feral Gods: Dungeon Crawler Carl, Book 4']['phase'], 'published')
        self.assertEqual(by_book['Dungeon Crawler Carl: Dungeon Crawler Carl, Book 1'],
                         {**by_book['Dungeon Crawler Carl: Dungeon Crawler Carl, Book 1'], 'phase': 'skipped', 'reason': 'already made from the audio'})
        self.assertNotIn("Old Man's War", by_book)
        live = json.loads((self.data / 'read-along' / f'{EBOOK_ID}.json').read_text())
        self.assertEqual(live['origin'], 'transcript')
        kept = list((self.work / 'replaced').glob(f'{EBOOK_ID}.*.json'))
        self.assertEqual(len(kept), 1)
        self.assertEqual(json.loads(kept[0].read_text()), self.ebook, 'the ebook version is kept')
        job = json.loads((self.work / 'books' / EBOOK_ID / 'job.json').read_text())
        self.assertEqual(job['names'], ['Donut', 'Mordecai'], 'names from the ebook text')
        again = self.run_queue('--replace', '--names-from-existing')
        self.assertEqual([l['reason'] for l in again if l.get('phase') == 'skipped'], ['already made from the audio'] * 2)

    def test_without_replace_existing_read_along_is_left_alone_and_a_dry_run_changes_nothing(self):
        lines = self.run_queue()
        self.assertEqual(sorted(l['reason'] for l in lines if l.get('phase') == 'skipped'),
                         ['already has read-along', 'already made from the audio'])
        planned = self.run_queue('--replace', '--names-from-existing', '--dry-run')
        self.assertEqual([(l['book'], l['replaces'], l['names']) for l in planned if l.get('phase') == 'would transcribe'],
                         [('The Gate of the Feral Gods: Dungeon Crawler Carl, Book 4', True, ['Donut', 'Mordecai'])])
        self.assertFalse((self.work / 'books').exists())
        self.assertNotIn('origin', json.loads((self.data / 'read-along' / f'{EBOOK_ID}.json').read_text()))


if __name__ == '__main__':
    unittest.main()
