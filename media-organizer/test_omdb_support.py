"""omdb_support: back-off, season cache, usage counter and key redaction (no network)."""
import io
import json
import logging
import tempfile
import unittest
from datetime import date
from pathlib import Path

import omdb_support as o

TODAY = date(2026, 10, 16)


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


class Redaction(unittest.TestCase):
    def test_removes_the_key_wherever_it_appears(self):
        raw = "401 Client Error: Unauthorized for url: http://www.omdbapi.com/?apikey=abc123XYZ&t=Under+the+Dome&type=series"
        cleaned = o.redact(raw)
        self.assertNotIn("abc123XYZ", cleaned)
        self.assertIn("apikey=<hidden>&t=Under+the+Dome", cleaned, "the rest of the line stays readable")
        self.assertEqual(o.redact("apikey=&t=x"), "apikey=<hidden>&t=x", "an empty key is hidden too")
        self.assertEqual(o.redact("APIKEY=Secret9"), "APIKEY=<hidden>")
        self.assertEqual(o.redact("nothing to hide"), "nothing to hide")

    def test_the_log_filter_cleans_messages_and_their_arguments(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(o.RedactingFilter())
        logger = logging.getLogger("test_omdb_support.redaction")
        logger.propagate = False
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        logger.error("plain https://x/?apikey=KEY1&t=a")
        logger.error("with args: %s", "https://x/?apikey=KEY2&t=b")
        text = stream.getvalue()
        self.assertNotIn("KEY1", text)
        self.assertNotIn("KEY2", text)
        self.assertEqual(text.count("apikey=<hidden>"), 2)

    def test_request_errors_are_described_without_a_url(self):
        import requests
        self.assertEqual(o.describe_request_error(requests.Timeout("https://x/?apikey=K")), "timed out")
        self.assertEqual(o.describe_request_error(requests.ConnectionError("https://x/?apikey=K")), "connection failed")
        response = type("R", (), {"status_code": 503})()
        self.assertEqual(o.describe_request_error(requests.HTTPError("https://x/?apikey=K", response=response)), "HTTP 503")


class BackoffTests(unittest.TestCase):
    def test_delays_double_up_to_a_cap_and_a_success_forgets_them(self):
        clock = Clock(0)
        backoff = o.Backoff(base=20, cap=300, clock=clock)
        self.assertFalse(backoff.blocked())
        waits = []
        for _ in range(7):
            backoff.failed()
            waits.append(round(backoff.remaining()))
        self.assertEqual(waits, [20, 40, 80, 160, 300, 300, 300])
        clock.now = 299
        self.assertTrue(backoff.blocked())
        clock.now = 301
        self.assertFalse(backoff.blocked())
        backoff.succeeded()
        backoff.failed()
        self.assertEqual(round(backoff.remaining()), 20, "a success starts the delays over")

    def test_hold_keeps_away_for_a_fixed_time_and_never_shortens_an_existing_wait(self):
        clock = Clock(0)
        backoff = o.Backoff(clock=clock)
        backoff.hold(1800)
        self.assertEqual(round(backoff.remaining()), 1800)
        backoff.hold(60)
        self.assertEqual(round(backoff.remaining()), 1800)


class SeasonParsing(unittest.TestCase):
    def reply(self, *rows):
        return {"Response": "True", "Episodes": [dict(Title=t, Released=r, Episode=str(n)) for n, t, r in rows]}

    def test_a_finished_season_has_every_title_and_only_past_air_dates(self):
        episodes, finished = o.parse_season(self.reply((1, "Pilot", "2020-01-01"), (2, "Second", "2020-01-08")), TODAY)
        self.assertEqual(episodes, {1: "Pilot", 2: "Second"})
        self.assertTrue(finished)

    def test_a_running_season_is_not_finished(self):
        _, finished = o.parse_season(self.reply((1, "Pilot", "2026-10-01"), (2, "Next", "2026-10-23")), TODAY)
        self.assertFalse(finished, "an unaired episode means the season will still change")

    def test_missing_or_placeholder_titles_are_left_out_and_keep_the_season_open(self):
        episodes, finished = o.parse_season(self.reply((1, "Pilot", "2020-01-01"), (2, "N/A", "2020-01-08"),
                                                       (3, "Episode #1.3", "2020-01-15")), TODAY)
        self.assertEqual(episodes, {1: "Pilot"})
        self.assertFalse(finished)

    def test_unknown_air_date_keeps_the_season_open_and_junk_is_survivable(self):
        _, finished = o.parse_season(self.reply((1, "Pilot", "N/A")), TODAY)
        self.assertFalse(finished)
        for junk in (None, {}, {"Episodes": "x"}, {"Episodes": [None, 3, {"Title": 1}]}, "text"):
            self.assertEqual(o.parse_season(junk, TODAY)[0], {})


class SeasonCacheTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "seasons.json"
        self.clock = Clock(1_000_000)

    def cache(self):
        return o.SeasonCache(self.path, clock=self.clock)

    def test_finished_seasons_last_months_and_running_ones_a_day(self):
        cache = self.cache()
        cache.put("tt1|1", {1: "Pilot"}, finished=True)
        cache.put("tt2|1", {1: "Pilot"}, finished=False)
        self.clock.now += 2 * 86400
        self.assertEqual(cache.get("tt1|1"), {1: "Pilot"})
        self.assertIsNone(cache.get("tt2|1"), "a running season is asked about again after a day")
        self.clock.now += 89 * 86400
        self.assertIsNone(cache.get("tt1|1"), "and even a finished one eventually")

    def test_survives_a_restart(self):
        self.cache().put("tt1|2", {1: "A", 2: "B"}, finished=True)
        self.assertEqual(self.cache().get("tt1|2"), {1: "A", 2: "B"})

    def test_an_empty_season_is_remembered_so_it_is_not_asked_for_per_file(self):
        cache = self.cache()
        cache.put("tt1|9", {}, finished=False)
        self.assertEqual(cache.get("tt1|9"), {})

    def test_a_damaged_or_unwritable_cache_never_breaks_anything(self):
        self.path.write_text("{ nope")
        self.assertIsNone(self.cache().get("x"))
        cache = o.SeasonCache("/proc/not/writable/seasons.json", clock=self.clock)
        cache.put("tt1|1", {1: "A"}, finished=True)           # must not raise
        self.assertEqual(cache.get("tt1|1"), {1: "A"}, "it still works from memory")

    def test_memory_only_cache_writes_nothing(self):
        cache = o.SeasonCache(None, clock=self.clock)
        cache.put("tt1|1", {1: "A"}, finished=True)
        self.assertFalse(self.path.exists())

    def test_it_stays_bounded(self):
        cache = self.cache()
        cache.MAX_SEASONS = 5
        for number in range(8):
            self.clock.now += 1
            cache.put(f"tt{number}|1", {1: "x"}, finished=True)
        self.assertEqual(len(cache.seasons), 5)
        self.assertIsNone(cache.get("tt0|1"), "the oldest are dropped first")
        self.assertIsNotNone(cache.get("tt7|1"))


class UsageCounterTests(unittest.TestCase):
    def test_counts_per_utc_day_and_keeps_a_week(self):
        clock = Clock(1_760_000_000)
        usage = o.UsageCounter(None, clock=clock)
        for _ in range(3):
            usage.hit()
        self.assertEqual(usage.today(), 3)
        for day in range(1, 10):
            clock.now += 86400
            usage.hit()
        self.assertEqual(usage.today(), 1)
        self.assertLessEqual(len(usage.days), 7)

    def test_persists_and_tolerates_a_bad_location(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "usage.json"
            clock = Clock(1_760_000_000)
            o.UsageCounter(path, clock=clock).hit()
            self.assertEqual(o.UsageCounter(path, clock=clock).today(), 1)
            self.assertEqual(json.loads(path.read_text())["version"], 1)
        o.UsageCounter("/proc/not/writable/u.json", clock=Clock(1_760_000_000)).hit()   # must not raise


if __name__ == "__main__":
    unittest.main()
