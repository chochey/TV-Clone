"""An OMDb outage must make the organizer wait, not give up.

Before: a failed request looked like "no match". The movie lookup retried every spelling
(10 s timeout each), remembered the title as unmatched for 24 h and put the release on
the do-not-look-again list until the next restart, so a short outage parked good
releases (Scream 7 sat skipped across the whole 04-28 .. 05-02 outage). Episode titles
were fetched one request per file, and a failed fetch filed the episode without a title.
"""
import io
import logging
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import requests

import config
import movie_renamer as m
import omdb_support
from omdb_support import OMDbUnavailableError
from organizer_testing import OrganizerTestCase


def reply(payload, status=200):
    response = MagicMock(status_code=status)
    response.json.return_value = payload
    if status >= 400:
        response.raise_for_status.side_effect = requests.HTTPError(
            f"{status} Error for url: https://www.omdbapi.com/?apikey=SECRET123&t=x", response=response)
    return response


def movie_found(url, params=None, timeout=None):
    if params.get("t") == "Example" and params.get("y") == "2022":
        return reply({"Response": "True", "Title": "Example", "Year": "2022", "Type": "movie",
                      "imdbID": "tt0000001", "Runtime": "100 min"})
    return reply({"Response": "False", "Error": "Movie not found!"})


def season_reply(count, **over):
    rows = [{"Title": f"Title {n}", "Released": "2020-01-01", "Episode": str(n), "imdbRating": "8", "imdbID": f"tt9{n}"}
            for n in range(1, count + 1)]
    return reply({"Response": "True", "Title": "Example", "Season": "1", "totalSeasons": "3", "Episodes": rows, **over})


class Harness(OrganizerTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for name, value in [("get_movie_dest", self.root / "movies"), ("get_tv_dest", self.root / "tv"), ("check_movie", None)]:
            fixture = patch.object(m, name, return_value=value)
            fixture.start()
            self.addCleanup(fixture.stop)
        m._watch_skip_logged.clear()
        self.addCleanup(m._watch_skip_logged.clear)
        self.addCleanup(m.reset_omdb_state)
        self.now = [0.0]
        m._omdb_backoff = omdb_support.Backoff(clock=lambda: self.now[0])
        self.info = {"title": "Example", "year": "2022", "type": "series", "imdbID": "tt12345"}

    def movie(self, name="Example (2022) [1080p]"):
        folder = self.root / "share" / name
        folder.mkdir(parents=True)
        video = folder / "Example.2022.1080p.mkv"
        video.write_bytes(b"x" * 2048)
        return {"type": "folder", "path": folder, "video_files": [video], "subtitle_files": [], "parse_name": name}

    def pack(self, episodes, name="Example.S01.1080p"):
        folder = self.root / "share" / name
        folder.mkdir(parents=True)
        for number in episodes:
            (folder / f"Example.S01E{number:02d}.mkv").write_bytes(b"e" * 1024)
        return {"type": "folder", "path": folder, "video_files": sorted(folder.glob("*.mkv")),
                "subtitle_files": [], "parse_name": name, "tv_info": m.parse_tv_info(name)}

    def library_files(self):
        return sorted(str(p.relative_to(self.root)) for p in (self.root / "tv").rglob("*.mkv")) \
            + sorted(str(p.relative_to(self.root)) for p in (self.root / "movies").rglob("*.mkv"))


class MoviesWaitOutAnOutage(Harness):
    def test_an_outage_leaves_the_release_waiting_instead_of_skipping_it(self):
        item = self.movie()
        down = Mock(side_effect=requests.Timeout("https://www.omdbapi.com/?apikey=SECRET123&t=x"))
        with patch("movie_renamer.requests.get", down), self.assertLogs("movie_renamer", level="INFO") as logs:
            first = m.process_movies_list([item])
            second = m.process_movies_list([item])
        self.assertEqual((first, second), ((0, 1), (0, 1)))
        self.assertTrue(item["video_files"][0].exists(), "nothing is touched")
        self.assertNotIn(item["parse_name"], m._watch_skip_logged, "no do-not-look-again mark")
        self.assertEqual(m._omdb_no_match_cache, {}, "no 24 h 'no match' memory")
        text = "\n".join(logs.output)
        self.assertNotIn("SKIP", text)
        self.assertNotIn("No confident", text)
        self.assertNotIn("SECRET123", text)
        self.assertEqual(text.count("WAIT:"), 1, "one notice per release, not one per poll")
        self.assertEqual(down.call_count, 1, "fail fast: one request, not one per spelling per scan")

    def test_when_omdb_returns_the_release_is_imported_without_a_restart(self):
        item = self.movie()
        with patch("movie_renamer.requests.get", Mock(side_effect=requests.ConnectionError("down"))):
            m.process_movies_list([item])
        self.now[0] = 25                       # past the 20 s hold
        with patch("movie_renamer.requests.get", side_effect=movie_found):
            result = m.process_movies_list([item])
        self.assertEqual(result, (1, 0))
        self.assertEqual(self.library_files(), ["movies/Example (2022)/Example (2022).mkv"])
        self.assertFalse(item["video_files"][0].exists())

    def test_a_genuine_no_match_is_still_skipped_and_remembered(self):
        item = self.movie("Nothing Like It (2031) [1080p]")
        absent = Mock(side_effect=lambda url, params=None, timeout=None: reply({"Response": "False", "Error": "Movie not found!"}))
        with patch("movie_renamer.requests.get", absent), self.assertLogs("movie_renamer", level="INFO") as logs:
            self.assertEqual(m.process_movies_list([item]), (0, 1))
            asked = absent.call_count
            self.assertEqual(m.process_movies_list([item]), (0, 1))
        self.assertIn("SKIP: No confident OMDb match", "\n".join(logs.output))
        self.assertIn(item["parse_name"], m._watch_skip_logged)
        self.assertGreater(asked, 1, "a real miss still tries the other spellings")
        self.assertEqual(absent.call_count, asked, "and is not asked about again")

    def test_a_failure_while_checking_for_a_series_also_waits(self):
        # The movie lookup (always sent with type=movie) answers "not found". OMDb then dies on the
        # follow-up "is it really a series?" check, the only request sent without a type filter.
        item = self.movie("Band of Brothers (1080p x265)")
        asked = []

        def dies_on_the_series_check(url, params=None, timeout=None):
            asked.append(dict(params))
            if "type" in params:
                return reply({"Response": "False", "Error": "Movie not found!"})
            raise requests.Timeout("down")

        with patch("movie_renamer.requests.get", side_effect=dies_on_the_series_check), \
                self.assertLogs("movie_renamer", level="INFO") as logs:
            result = m.process_movies_list([item])
        self.assertTrue(any("type" not in params for params in asked), "the series check was reached")
        self.assertEqual(result, (0, 1))
        self.assertNotIn(item["parse_name"], m._watch_skip_logged)
        self.assertNotIn("SKIP:", "\n".join(logs.output))
        self.assertIn("WAIT:", "\n".join(logs.output))

        # Once OMDb is back the release gets the answer it should always have had.
        self.now[0] = 25

        def recovered(url, params=None, timeout=None):
            if "type" in params:
                return reply({"Response": "False", "Error": "Movie not found!"})
            return reply({"Response": "True", "Title": "Band of Brothers", "Year": "2001", "Type": "series",
                          "imdbID": "tt0185906"})

        with patch("movie_renamer.requests.get", side_effect=recovered), \
                self.assertLogs("movie_renamer", level="INFO") as later:
            self.assertEqual(m.process_movies_list([item]), (0, 1))
        self.assertIn("is a TV series in OMDb", "\n".join(later.output))
        self.assertIn(item["parse_name"], m._watch_skip_logged)


class TvPacksWaitForTitles(Harness):
    def test_a_pack_waits_for_episode_titles_instead_of_being_filed_without_them(self):
        pack = self.pack([1, 2])
        with patch.object(m, "query_omdb_series", return_value=self.info), \
                patch("movie_renamer.requests.get", Mock(side_effect=requests.Timeout("down"))):
            self.assertEqual(m.process_tv_shows_list([pack]), (0, 1))
        self.assertEqual(self.library_files(), [], "nothing was filed title-less")
        self.assertEqual(len(list(pack["path"].glob("*.mkv"))), 2)
        self.assertNotIn(pack["parse_name"], m._watch_skip_logged)

        self.now[0] = 25
        with patch.object(m, "query_omdb_series", return_value=self.info), \
                patch("movie_renamer.requests.get", return_value=season_reply(2)):
            self.assertEqual(m.process_tv_shows_list([pack]), (1, 0))
        self.assertEqual(self.library_files(),
                         ["tv/Example (2022)/Season 01/Example - S01E01 - Title 1.mkv",
                          "tv/Example (2022)/Season 01/Example - S01E02 - Title 2.mkv"])

    def test_a_waiting_pack_does_not_repeat_its_review_notes_on_every_scan(self):
        # "Bonus.mkv" sorts first and cannot be placed, so it is reported for review. The episodes
        # after it need titles. While OMDb is down the pack is planned again on every scan, so the
        # note must wait until the plan is complete or it would be repeated every 30 seconds.
        pack = self.pack([1, 2])
        (pack["path"] / "Bonus.mkv").write_bytes(b"b" * 1024)
        pack["video_files"] = sorted(pack["path"].glob("*.mkv"))
        down = Mock(side_effect=requests.Timeout("down"))
        with patch.object(m, "query_omdb_series", return_value=self.info), patch("movie_renamer.requests.get", down), \
                self.assertLogs("movie_renamer", level="INFO") as waiting:
            for scan in range(3):
                self.now[0] += 30
                self.assertEqual(m.process_tv_shows_list([pack]), (0, 1))
        self.assertEqual([line for line in waiting.output if "REVIEW:" in line], [])

        self.now[0] += 600
        with patch.object(m, "query_omdb_series", return_value=self.info), \
                patch("movie_renamer.requests.get", return_value=season_reply(2)), \
                self.assertLogs("movie_renamer", level="INFO") as recovered:
            self.assertEqual(m.process_tv_shows_list([pack]), (1, 0))
        reviews = [line for line in recovered.output if "REVIEW:" in line]
        self.assertEqual(len(reviews), 1)
        self.assertIn("Bonus.mkv", reviews[0])
        self.assertTrue((pack["path"] / "Bonus.mkv").exists(), "the file nobody could place stays where it was")

    def test_a_twelve_episode_pack_costs_one_request_not_twelve(self):
        pack = self.pack(range(1, 13))
        get = Mock(return_value=season_reply(12))
        with patch.object(m, "query_omdb_series", return_value=self.info), patch("movie_renamer.requests.get", get):
            self.assertEqual(m.process_tv_shows_list([pack]), (1, 0))
            later = m.query_omdb_episode("Example", 1, 3, "tt12345")      # another file, later
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args.kwargs["params"]["Season"], 1)
        self.assertNotIn("Episode", get.call_args.kwargs["params"], "the whole season, not one episode")
        self.assertEqual(later, {"episode_title": "Title 3"})
        self.assertEqual(len(self.library_files()), 12)
        self.assertTrue(all(" - Title " in name for name in self.library_files()))

    def test_an_episode_openly_missing_from_omdb_is_filed_without_a_title_and_not_retried(self):
        pack = self.pack([1, 5])
        get = Mock(return_value=season_reply(2))                           # OMDb knows two episodes
        with patch.object(m, "query_omdb_series", return_value=self.info), patch("movie_renamer.requests.get", get):
            self.assertEqual(m.process_tv_shows_list([pack]), (1, 0))
        self.assertEqual(self.library_files(), ["tv/Example (2022)/Season 01/Example - S01E01 - Title 1.mkv",
                                                "tv/Example (2022)/Season 01/Example - S01E05.mkv"])
        self.assertEqual(get.call_count, 1)

    def test_the_series_id_is_what_is_asked_about(self):
        get = Mock(return_value=season_reply(1))
        with patch("movie_renamer.requests.get", get):
            m.query_omdb_episode("Example", 1, 1, "tt12345")
            m.query_omdb_episode("Other Show", 2, 1)
        first, second = (call.kwargs["params"] for call in get.call_args_list)
        self.assertEqual((first["i"], "t" in first), ("tt12345", False))
        self.assertEqual((second["t"], "i" in second, second["Season"]), ("Other Show", False, 2))


class FailureKinds(Harness):
    def test_every_way_of_not_getting_an_answer_is_unavailable_and_never_leaks_the_key(self):
        def not_json():
            response = reply({})
            response.json.side_effect = requests.JSONDecodeError("Expecting value", "<html>", 0)
            return response
        # (what OMDb does, the plain-English reason that ends up in the "WAIT:" log line)
        cases = {
            "timeout": (Mock(side_effect=requests.Timeout("https://www.omdbapi.com/?apikey=SECRET123")), "timed out"),
            "no connection": (Mock(side_effect=requests.ConnectionError("https://www.omdbapi.com/?apikey=SECRET123")),
                              "connection failed"),
            "server error": (Mock(return_value=reply({}, status=503)), "HTTP 503"),
            "an HTML page instead of JSON": (Mock(return_value=not_json()), "unreadable reply"),
            "limit message with a 200": (Mock(return_value=reply({"Response": "False", "Error": "Request limit reached!"})),
                                         "Request limit reached"),
            "invalid key with a 200": (Mock(return_value=reply({"Response": "False", "Error": "Invalid API key!"})),
                                       "Invalid API key"),
            "a 401 below the rate-limit threshold": (Mock(return_value=reply({}, status=401)), "HTTP 401"),
        }
        for label, (get, wording) in cases.items():
            m.reset_omdb_state()
            with self.subTest(label), patch("movie_renamer.requests.get", get):
                with self.assertRaises(OMDbUnavailableError) as raised:
                    m._omdb_get({"apikey": "SECRET123", "t": "x"})
                reason = str(raised.exception)
                self.assertIn(wording, reason)
                self.assertNotIn("SECRET123", reason)
                self.assertNotIn("://", reason, "no URL, so no key, can reach the log")

    def test_odd_but_readable_replies_fail_closed_without_starting_a_back_off(self):
        for payload in (None, [], "text", 7):
            with self.subTest(payload=payload), patch("movie_renamer.requests.get", return_value=reply(payload)):
                self.assertEqual(m._omdb_get({"t": "x"}), {})
                self.assertFalse(m._omdb_backoff.blocked())

    def test_an_unknown_title_is_an_answer_not_a_failure(self):
        with patch("movie_renamer.requests.get", return_value=reply({"Response": "False", "Error": "Movie not found!"})):
            self.assertEqual(m._omdb_get({"t": "x"})["Response"], "False")
        self.assertFalse(m._omdb_backoff.blocked())

    def test_repeated_401s_still_raise_the_rate_limit_error_and_then_hold_off_for_half_an_hour(self):
        get = Mock(return_value=reply({}, status=401))
        with patch("movie_renamer.requests.get", get):
            for attempt in range(1, 5):
                self.now[0] += 400
                with self.assertRaises(OMDbUnavailableError):
                    m._omdb_get({"t": "x"})
            self.now[0] += 400
            with self.assertRaises(m.OMDbRateLimitError):
                m._omdb_get({"t": "x"})
            asked = get.call_count
            self.now[0] += 60
            with self.assertRaisesRegex(OMDbUnavailableError, "holding off"):
                m._omdb_get({"t": "x"})
            self.assertEqual(get.call_count, asked, "no request while the day's allowance is gone")
            self.now[0] += 31 * 60
            with self.assertRaises(m.OMDbRateLimitError):                 # still exhausted: one probe
                m._omdb_get({"t": "x"})
            self.assertEqual(get.call_count, asked + 1)

    def test_a_success_ends_the_outage_and_says_so(self):
        with patch("movie_renamer.requests.get", Mock(side_effect=requests.Timeout("down"))), \
                self.assertLogs("movie_renamer", level="INFO") as logs:
            with self.assertRaises(OMDbUnavailableError):
                m._omdb_get({"t": "x"})
            self.now[0] = 21
        with patch("movie_renamer.requests.get", return_value=reply({"Response": "True"})), \
                self.assertLogs("movie_renamer", level="INFO") as back:
            m._omdb_get({"t": "x"})
        self.assertIn("not responding", "\n".join(logs.output))
        self.assertIn("responding again", "\n".join(back.output))
        self.assertEqual(m._omdb_backoff.failures, 0)


class KeySafety(Harness):
    def test_requests_use_https(self):
        with patch("movie_renamer.requests.get", return_value=reply({"Response": "True"})) as get:
            m._omdb_get({"t": "x"})
        self.assertTrue(get.call_args.args[0].startswith("https://"), get.call_args.args[0])
        if "OMDB_BASE_URL" not in os.environ:
            self.assertTrue(config.OMDB_BASE_URL.startswith("https://"))

    def test_the_key_never_reaches_a_log_file_or_the_console_whatever_the_message(self):
        console = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, patch("sys.stderr", console):
            m.setup_logging(log_dir=directory, preview=False)
            self.addCleanup(lambda: [logging.getLogger().removeHandler(h) or h.close() for h in list(logging.getLogger().handlers)
                                     if getattr(h, m._OWN_HANDLER, False)])
            m.log.error("OMDb API error: 401 Client Error for url: http://www.omdbapi.com/?apikey=SECRET123&t=Under+the+Dome")
            m.log.warning("odd: %s", "https://x/?apikey=SECRET456")
            for handler in logging.getLogger().handlers:
                handler.flush()
            written = (Path(directory) / "media-organizer.log").read_text()
        for where, text in (("log file", written), ("console", console.getvalue())):
            with self.subTest(where):
                self.assertNotIn("SECRET123", text)
                self.assertNotIn("SECRET456", text)
                self.assertEqual(text.count("apikey=<hidden>"), 2)


class Persistence(Harness):
    def test_titles_and_the_daily_count_survive_a_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            seasons, usage = Path(directory) / "seasons.json", Path(directory) / "usage.json"
            with patch.object(config, "OMDB_SEASON_CACHE", str(seasons)), patch.object(config, "OMDB_USAGE_FILE", str(usage)):
                m.start_omdb_state()
                with patch("movie_renamer.requests.get", return_value=season_reply(3)) as get:
                    m.query_omdb_episode("Example", 1, 2, "tt12345")
                self.assertEqual(get.call_count, 1)
                m.start_omdb_state()                                       # "restart"
                with patch("movie_renamer.requests.get", side_effect=AssertionError("asked again after a restart")):
                    self.assertEqual(m.query_omdb_episode("Example", 1, 3, "tt12345"), {"episode_title": "Title 3"})
                self.assertEqual(m._omdb_usage.today(), 1)


if __name__ == "__main__":
    unittest.main()
