"""The status file the Organizer page reads: written atomically, kept fresh by its own thread."""
import json
import os
import stat
import tempfile
import threading
import time
import unittest
from pathlib import Path

from organizer_status import StatusFile, VERSION


class Clock:
    def __init__(self, now=1_000.0):
        self.now = now

    def __call__(self):
        return self.now


class StatusFileTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.path = self.dir / "organizer-status.json"
        self.clock = Clock()

    def status(self, **kwargs):
        made = StatusFile(self.path, clock=self.clock, **kwargs)
        self.addCleanup(made.stop)
        return made

    def read(self):
        return json.loads(self.path.read_text())

    def test_the_file_says_who_wrote_it_and_when(self):
        made = self.status()
        self.assertTrue(made.write())
        doc = self.read()
        self.assertEqual(doc["version"], VERSION)
        self.assertEqual(doc["pid"], os.getpid())
        self.assertEqual(doc["startedAt"], 1_000_000)
        self.assertEqual(doc["updatedAt"], 1_000_000)
        self.assertEqual(doc["activity"], {"state": "starting", "detail": "", "since": 1_000_000})

    def test_what_the_loop_is_doing_is_recorded_with_when_it_started(self):
        made = self.status()
        self.clock.now = 1_060.0
        made.activity("importing", "Some Release")
        self.clock.now = 1_090.0
        made.write()
        doc = self.read()
        self.assertEqual(doc["activity"], {"state": "importing", "detail": "Some Release", "since": 1_060_000})
        self.assertEqual(doc["updatedAt"], 1_090_000, "updatedAt is when it was written, not when the activity began")

    def test_fields_can_be_merged_and_providers_are_asked_at_write_time(self):
        made = self.status()
        made.update(scans=3, lastImport={"at": 5, "release": "R"})
        counter = {"n": 0}

        def provider():
            counter["n"] += 1
            return {"omdb": {"requestsToday": counter["n"]}}

        made.add_provider(provider)
        made.write()
        made.write()
        doc = self.read()
        self.assertEqual((doc["scans"], doc["lastImport"]), (3, {"at": 5, "release": "R"}))
        self.assertEqual(doc["omdb"], {"requestsToday": 2}, "fresh numbers on every write")

    def test_a_provider_that_fails_costs_nothing_but_its_own_fields(self):
        made = self.status()
        made.add_provider(lambda: 1 / 0)
        made.add_provider(lambda: {"ok": True})
        self.assertTrue(made.write())
        self.assertEqual(self.read()["ok"], True)

    def test_the_replacement_is_atomic_and_leaves_no_temporary_file(self):
        made = self.status()
        made.write()
        made.update(scans=1)
        made.write()
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["organizer-status.json"])
        self.assertEqual(self.read()["scans"], 1)

    def test_a_reader_never_sees_a_half_written_file(self):
        made = self.status()
        made.update(blob="x" * 200_000)
        made.write()
        stop = threading.Event()
        bad = []

        def reader():
            while not stop.is_set():
                try:
                    json.loads(self.path.read_text())
                except ValueError as error:
                    bad.append(str(error))
                except FileNotFoundError:
                    bad.append("missing")

        thread = threading.Thread(target=reader)
        thread.start()
        for number in range(60):
            made.update(scans=number)
            made.write()
        stop.set()
        thread.join()
        self.assertEqual(bad, [])

    def test_an_unwritable_place_degrades_quietly_and_says_so_once(self):
        blocker = self.dir / "file"
        blocker.write_text("x")                      # a file where the folder should be
        made = StatusFile(blocker / "status.json", clock=self.clock)
        messages = []
        made._warn = messages.append
        self.assertFalse(made.write())
        self.assertFalse(made.write())
        self.assertEqual(len(messages), 1, "one warning, not one per write")
        self.assertFalse(made.healthy)

    def test_a_status_with_no_path_is_inert(self):
        made = StatusFile(None, clock=self.clock)
        self.assertFalse(made.write())
        made.start()
        made.stop()

    def test_the_heartbeat_thread_keeps_the_file_fresh_while_the_main_thread_is_busy(self):
        clock = time.time
        made = StatusFile(self.path, clock=clock, interval=0.05)
        self.addCleanup(made.stop)
        made.start()
        first = self.read()["updatedAt"]
        deadline = time.time() + 5
        while time.time() < deadline and self.read()["updatedAt"] == first:
            time.sleep(0.02)
        self.assertGreater(self.read()["updatedAt"], first)

    def test_stopping_records_that_the_organizer_stopped(self):
        made = StatusFile(self.path, clock=self.clock, interval=0.05)
        made.start()
        made.stop(final="stopped")
        self.assertEqual(self.read()["activity"]["state"], "stopped")
        made.stop(final="stopped")   # a second stop is harmless

    def test_a_strict_umask_does_not_hide_the_file_from_the_media_server(self):
        """The server runs as another user and reads this through the data folder's default ACL; a file created
        with mode 0600 would get an empty ACL mask there and be unreadable."""
        previous = os.umask(0o077)
        self.addCleanup(os.umask, previous)
        made = self.status()
        made.write()
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o644)


if __name__ == "__main__":
    unittest.main()
