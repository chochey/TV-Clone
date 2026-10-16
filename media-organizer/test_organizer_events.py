"""What the Organizer page learns from the organizer: typed events and the live status file."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import requests

import config
import movie_renamer as m
from organizer_testing import OrganizerTestCase


class Sandbox(OrganizerTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.share = self.root / "Share"
        self.share.mkdir()
        self.status_path = self.root / "data" / "organizer-status.json"
        for name, value in [("SOURCE_DIR", str(self.share)), ("STATUS_FILE", str(self.status_path)), ("STATUS_INTERVAL", 3600.0)]:
            fixture = patch.object(config, name, value)
            fixture.start()
            self.addCleanup(fixture.stop)
        self.addCleanup(m.stop_status)

    def status(self):
        return json.loads(self.status_path.read_text())

    def release_file(self, relative, data=b"video"):
        path = self.share / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path


class MovedEvent(Sandbox):
    def moved_events(self, logs):
        return [json.loads(line.split("EVENT: ", 1)[1]) for line in logs.output if "EVENT: " in line]

    def test_the_event_names_the_release_the_file_came_from(self):
        source = self.release_file("Some.Pack.S01/Season 1/Show.S01E01.mkv")
        destination = self.root / "tv" / "Show (2020)" / "Season 01" / "Show - S01E01.mkv"
        with self.assertLogs("movie_renamer", level="INFO") as logs:
            m.move_without_overwrite(source, destination)
        self.assertEqual(self.moved_events(logs), [
            {"event": "moved", "release": "Some.Pack.S01", "source": str(source), "destination": str(destination)}])

    def test_a_loose_file_is_its_own_release(self):
        source = self.release_file("Loose.Movie.2020.mkv")
        with self.assertLogs("movie_renamer", level="INFO") as logs:
            m.move_without_overwrite(source, self.root / "movies" / "Loose Movie (2020)" / "Loose Movie (2020).mkv")
        self.assertEqual(self.moved_events(logs)[0]["release"], "Loose.Movie.2020.mkv")

    def test_a_file_from_outside_the_download_folder_falls_back_to_its_name(self):
        source = self.root / "elsewhere.mkv"
        source.write_bytes(b"x")
        with self.assertLogs("movie_renamer", level="INFO") as logs:
            m.move_without_overwrite(source, self.root / "movies" / "x" / "x.mkv")
        self.assertEqual(self.moved_events(logs)[0]["release"], "elsewhere.mkv")

    def test_a_refused_import_records_no_event(self):
        source = self.release_file("Pack/a.mkv")
        destination = self.root / "movies" / "a.mkv"
        destination.parent.mkdir()
        destination.write_bytes(b"already")
        with self.assertLogs("movie_renamer", level="INFO") as logs, self.assertRaises(FileExistsError):
            m.log.info("start")
            m.move_without_overwrite(source, destination)
        self.assertEqual(self.moved_events(logs), [])

    def test_the_status_remembers_the_last_import_and_what_is_being_imported(self):
        m.start_status()
        source = self.release_file("Pack/a.mkv")
        m.move_without_overwrite(source, self.root / "movies" / "A (2020)" / "A (2020).mkv")
        m._status.write()
        doc = self.status()
        self.assertEqual(doc["lastImport"]["release"], "Pack")
        self.assertEqual(doc["lastImport"]["name"], "A (2020).mkv")
        self.assertEqual(doc["activity"]["state"], "importing")
        self.assertEqual(doc["activity"]["detail"], "Pack")

    def test_nothing_is_written_unless_watch_mode_started_the_status(self):
        source = self.release_file("Pack/a.mkv")
        m.move_without_overwrite(source, self.root / "movies" / "A (2020)" / "A (2020).mkv")
        self.assertFalse(self.status_path.exists())
        self.assertIsNone(m._status)


class OmdbSnapshot(Sandbox):
    def test_a_healthy_start(self):
        self.assertEqual(m.omdb_snapshot(), {"omdb": {"failing": False, "since": None, "reason": None,
                                                      "retryInSeconds": 0, "waiting": 0, "requestsToday": 0}})

    def test_an_outage_shows_why_since_when_and_how_many_releases_wait(self):
        with patch("movie_renamer.requests.get", Mock(side_effect=requests.Timeout("down"))):
            with self.assertRaises(m.OMDbUnavailableError) as raised:
                m._omdb_get({"t": "x"})
        m._wait_for_omdb("Release A", raised.exception)
        m._wait_for_omdb("Release B", raised.exception)
        omdb = m.omdb_snapshot()["omdb"]
        self.assertTrue(omdb["failing"])
        self.assertEqual(omdb["reason"], "timed out")
        self.assertEqual(omdb["waiting"], 2)
        self.assertGreater(omdb["retryInSeconds"], 0)
        self.assertGreater(omdb["since"], 0)
        self.assertEqual(omdb["requestsToday"], 1)

    def test_recovery_clears_it(self):
        with patch("movie_renamer.requests.get", Mock(side_effect=requests.Timeout("down"))):
            with self.assertRaises(m.OMDbUnavailableError):
                m._omdb_get({"t": "x"})
        m._omdb_backoff.until = 0     # the hold-off has passed
        good = MagicMock(status_code=200)
        good.json.return_value = {"Response": "True"}
        with patch("movie_renamer.requests.get", return_value=good):
            m._omdb_get({"t": "x"})
        omdb = m.omdb_snapshot()["omdb"]
        self.assertEqual((omdb["failing"], omdb["since"], omdb["reason"], omdb["waiting"]), (False, None, None, 0))

    def test_the_first_reason_stands_until_a_different_one_replaces_it(self):
        with patch("movie_renamer.requests.get", Mock(side_effect=requests.Timeout("down"))):
            with self.assertRaises(m.OMDbUnavailableError):
                m._omdb_get({"t": "x"})
        since = m.omdb_snapshot()["omdb"]["since"]
        m._omdb_backoff.until = 0
        with patch("movie_renamer.requests.get", Mock(side_effect=requests.ConnectionError("down"))):
            with self.assertRaises(m.OMDbUnavailableError):
                m._omdb_get({"t": "x"})
        omdb = m.omdb_snapshot()["omdb"]
        self.assertEqual((omdb["since"], omdb["reason"]), (since, "connection failed"), "same outage, latest reason")

    def test_the_status_file_carries_the_omdb_block(self):
        m.start_status()
        m._status.write()
        self.assertIn("omdb", self.status())
        self.assertFalse(self.status()["omdb"]["failing"])


class WatchLoop(Sandbox):
    def run_loop(self, scans=3, step=100.0, results=((1, 0, 0, 0),)):
        """Run run_watch for `scans` passes with a fake clock that moves `step` seconds per reading."""
        sleeps = {"n": 0}
        clock = {"t": 1_000_000.0}

        def now():
            clock["t"] += step
            return clock["t"]

        def sleep(_seconds):
            sleeps["n"] += 1
            if sleeps["n"] >= scans:
                raise KeyboardInterrupt

        outcomes = iter(list(results) + [(0, 0, 0, 0)] * scans)
        retries = self.root / "retries"
        with patch.object(m, "process_all", side_effect=lambda **kw: next(outcomes)), \
                patch.object(m.time, "sleep", sleep), patch.object(m.time, "time", now), \
                patch.dict(os.environ, {"ORGANIZER_RETRY_DIR": str(retries)}), \
                self.assertLogs("movie_renamer", level="INFO") as logs:
            m.run_watch()
        return logs.output

    def test_the_loop_reports_each_scan_and_says_stopped_when_it_ends(self):
        output = self.run_loop(scans=3)
        doc = self.status()
        self.assertEqual(doc["scans"], 3)
        self.assertEqual(doc["activity"]["state"], "stopped")
        self.assertEqual(doc["lastScan"]["imported"], 0, "the last pass imported nothing")
        self.assertIn("Watch mode stopped.", "".join(output))
        self.assertIsNone(m._status, "the status is released for the next run")

    def test_with_a_working_status_file_the_log_heartbeat_is_hourly(self):
        output = self.run_loop(scans=3, step=100.0)
        self.assertEqual([line for line in output if "Still watching" in line], [])

    def test_the_log_heartbeat_is_the_fallback_when_the_status_file_cannot_be_written(self):
        blocker = self.root / "blocker"
        blocker.write_text("x")                      # a file where the data folder should be
        with patch.object(config, "STATUS_FILE", str(blocker / "organizer-status.json")):
            output = self.run_loop(scans=3, step=100.0)
        beats = [line for line in output if "Still watching" in line]
        self.assertTrue(beats, "every five minutes while the status file is unavailable")
        self.assertIn("cannot write the status file", "".join(output))

    def test_the_heartbeat_line_counts_what_happened(self):
        blocker = self.root / "blocker"
        blocker.write_text("x")
        with patch.object(config, "STATUS_FILE", str(blocker / "organizer-status.json")):
            output = self.run_loop(scans=3, step=100.0, results=((2, 0, 1, 0),))
        beat = next(line for line in output if "Still watching" in line)
        self.assertRegex(beat, r"Still watching\.\.\. \d+ scans?, 3 imports? since start")


if __name__ == "__main__":
    unittest.main()
