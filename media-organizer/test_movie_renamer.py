"""Offline unit tests for title parsing/matching accuracy.

Every case here is a real failure from media-organizer.log unless noted.
No network: metadata calls are mocked and file operations use fixtures. Run with:
    python3 -m unittest test_movie_renamer -v
"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests

from PTN import parse

import config
from movie_renamer import (
    OMDbRateLimitError,
    _query_omdb_series_single,
    check_if_actually_series,
    find_media_in_source,
    get_acronym_variations,
    get_series_title_variations,
    get_possessive_variations,
    get_separator_variations,
    get_title_variations,
    infer_missing_movie_year,
    is_good_match,
    is_good_series_match,
    move_movie,
    movie_folder_identity,
    normalize_for_match,
    parse_filename,
    process_movies_list,
    process_tv_shows_list,
    query_omdb,
    query_omdb_series,
    strip_foreign_release_prefix,
    title_match_ratio,
)


class TestSeriesSearchPagination(unittest.TestCase):
    """A title is unique only after all bounded search pages are complete."""

    def setUp(self):
        # Mock configuration as well as HTTP so failed assertions cannot expose
        # a real API key or request URL.
        for target, value in (("config.OMDB_API_KEY", "fixture-key"),
                              ("config.OMDB_BASE_URL", "https://metadata.invalid/"),
                              ("movie_renamer._omdb_consecutive_401s", 0),
                              ("movie_renamer._omdb_no_match_cache", {}),
                              ("movie_renamer._watch_skip_logged", set())):
            fixture = patch(target, value)
            fixture.start()
            self.addCleanup(fixture.stop)

    @staticmethod
    def row(number, title=None, year="2026", imdb_id=None):
        return {"Title": title or f"Unrelated Example Number {number}", "Year": year,
                "Type": "series", "imdbID": imdb_id or f"tt{10000000 + number}"}

    @staticmethod
    def response(rows, total=None, status=200):
        response = MagicMock(status_code=status)
        response.json.return_value = {"Response": "True", "Search": rows,
                                      "totalResults": str(len(rows) if total is None else total)}
        if status != 200:
            response.raise_for_status.side_effect = requests.HTTPError("fixture HTTP failure")
        return response

    def pages(self, rows):
        return [self.response(rows[start:start + 10], len(rows))
                for start in range(0, len(rows), 10)]

    def test_first_page_match_waits_for_all_four_pages(self):
        rows = [self.row(i) for i in range(37)]
        rows[1] = self.row(1, "Below", imdb_id="tt35934755")
        with patch("movie_renamer.requests.get", side_effect=self.pages(rows)) as get:
            result = _query_omdb_series_single("Below")
        self.assertEqual(result, {"title": "Below", "year": "2026", "type": "series",
                                  "imdbID": "tt35934755"})
        self.assertEqual([call.kwargs["params"].get("page", 1) for call in get.call_args_list],
                         [1, 2, 3, 4])
        for call in get.call_args_list:
            self.assertEqual(call.kwargs["params"]["s"], "Below")
            self.assertEqual(call.kwargs["params"]["type"], "series")
            self.assertEqual(call.kwargs["timeout"], 10)

    def test_unique_match_on_later_page_is_accepted(self):
        rows = [self.row(i) for i in range(11)]
        rows[-1] = self.row(10, "Below")
        with patch("movie_renamer.requests.get", side_effect=self.pages(rows)):
            self.assertEqual(_query_omdb_series_single("Below")["title"], "Below")

    def test_exact_titles_in_different_years_remain_ambiguous(self):
        rows = [self.row(i) for i in range(11)]
        rows[0] = self.row(0, "Below", "2019")
        rows[-1] = self.row(10, "Below", "2026")
        with patch("movie_renamer.requests.get", side_effect=self.pages(rows)):
            self.assertIsNone(_query_omdb_series_single("Below"))

    def test_duplicate_or_conflicting_identity_cannot_displace_unseen_results(self):
        for title in ("Below", "Different Title"):
            with self.subTest(title=title):
                rows = [self.row(i) for i in range(11)]
                rows[0] = self.row(0, "Below")
                rows[-1] = self.row(10, title, imdb_id=rows[0]["imdbID"])
                with patch("movie_renamer.requests.get", side_effect=self.pages(rows)):
                    self.assertIsNone(_query_omdb_series_single("Below"))

    def test_short_first_or_later_page_fails_closed(self):
        rows = [self.row(i) for i in range(11)]
        rows[0] = self.row(0, "Below")
        cases = ([self.response(rows[:9], 11)],
                 [self.response(rows[:10], 11), self.response([], 11)])
        for responses in cases:
            with self.subTest(pages=len(responses)), \
                    patch("movie_renamer.requests.get", side_effect=responses) as get:
                self.assertIsNone(_query_omdb_series_single("Below"))
                self.assertEqual(get.call_count, len(responses))

    def test_changed_total_or_missing_followup_total_fails_closed(self):
        rows = [self.row(i) for i in range(11)]
        rows[0] = self.row(0, "Below")
        for second_total in (12, None):
            followup = self.response(rows[10:], second_total)
            if second_total is None:
                del followup.json.return_value["totalResults"]
            with self.subTest(total=second_total), \
                    patch("movie_renamer.requests.get", side_effect=[self.response(rows[:10], 11), followup]):
                self.assertIsNone(_query_omdb_series_single("Below"))

    def test_failed_followup_response_cannot_accept_first_page_match(self):
        rows = [self.row(i) for i in range(10)]
        rows[0] = self.row(0, "Below")
        rejected = self.response([])
        rejected.json.return_value = {"Response": "False", "Error": "Search failed"}
        with patch("movie_renamer.requests.get", side_effect=[self.response(rows, 11), rejected]):
            self.assertIsNone(_query_omdb_series_single("Below"))

    def test_http_failure_is_safe_and_never_logs_request_credentials(self):
        rows = [self.row(i) for i in range(10)]
        rows[0] = self.row(0, "Below")
        secret_error = requests.ConnectionError("https://metadata.invalid/?apikey=DO_NOT_LOG")
        with patch("movie_renamer.requests.get", side_effect=[self.response(rows, 11), secret_error]), \
                self.assertLogs("movie_renamer", level="ERROR") as logs:
            self.assertIsNone(_query_omdb_series_single("Below"))
        self.assertNotIn("DO_NOT_LOG", " ".join(logs.output))
        self.assertNotIn("https://", " ".join(logs.output))

    def test_over_limit_search_does_not_fetch_extra_pages(self):
        rows = [self.row(i) for i in range(10)]
        rows[0] = self.row(0, "Below")
        with patch("movie_renamer.requests.get", return_value=self.response(rows, 51)) as get:
            self.assertIsNone(_query_omdb_series_single("Below"))
        self.assertEqual(get.call_count, 1)

    def test_exact_five_page_limit_is_supported(self):
        rows = [self.row(i) for i in range(50)]
        rows[-1] = self.row(49, "Below")
        with patch("movie_renamer.requests.get", side_effect=self.pages(rows)) as get:
            self.assertEqual(_query_omdb_series_single("Below")["title"], "Below")
        self.assertEqual(get.call_count, 5)

    def test_malformed_search_data_fails_closed(self):
        valid = self.row(0, "Below")
        cases = ({"Response": "True", "Search": [valid], "totalResults": "unknown"},
                 {"Response": "True", "Search": {}, "totalResults": "1"},
                 {"Response": "True", "Search": [None], "totalResults": "1"},
                 {"Response": "True", "Search": [{**valid, "Type": "movie"}], "totalResults": "1"},
                 {"Response": "True", "Search": [{**valid, "imdbID": ""}], "totalResults": "1"},
                 {"Response": "True", "Search": [valid], "totalResults": "0"},
                 {"Response": "True", "Search": [valid], "totalResults": True},
                 {"Response": "True", "Search": [valid], "totalResults": 1.2}, None)
        for data in cases:
            response = self.response([])
            response.json.return_value = data
            with self.subTest(data=data), patch("movie_renamer.requests.get", return_value=response):
                self.assertIsNone(_query_omdb_series_single("Below"))

    def test_single_page_unique_ambiguous_and_unrelated_behavior_is_preserved(self):
        cases = (([self.row(0, "Below")], "Below"),
                 ([self.row(0, "Below", "2026"), self.row(1, "Below", "2019")], None),
                 ([self.row(0)], None))
        for rows, expected in cases:
            with self.subTest(expected=expected), \
                    patch("movie_renamer.requests.get", return_value=self.response(rows)) as get:
                result = _query_omdb_series_single("Below")
            self.assertEqual(result["title"] if result else None, expected)
            self.assertEqual(get.call_count, 1)

    def test_explicit_year_keeps_exact_single_request(self):
        response = self.response([])
        response.json.return_value = {"Response": "True", "Title": "Below", "Year": "2026–",
                                      "Type": "series", "imdbID": "tt35934755"}
        with patch("movie_renamer.requests.get", return_value=response) as get:
            self.assertEqual(_query_omdb_series_single("Below", "2026")["year"], "2026")
        get.assert_called_once_with("https://metadata.invalid/",
                                    params={"apikey": "fixture-key", "t": "Below", "type": "series", "y": "2026"},
                                    timeout=10)

    def test_unauthorized_page_rejects_and_existing_rate_limit_still_propagates(self):
        rows = [self.row(i) for i in range(10)]
        rows[0] = self.row(0, "Below")
        with patch("movie_renamer.requests.get", side_effect=[self.response(rows, 11), self.response([], status=401)]):
            self.assertIsNone(_query_omdb_series_single("Below"))
        with patch("movie_renamer._omdb_consecutive_401s", 4), \
                patch("movie_renamer.requests.get", return_value=self.response([], status=401)):
            with self.assertRaises(OMDbRateLimitError):
                _query_omdb_series_single("Below")

    def test_local_verified_series_still_avoids_network(self):
        local = {"title": "Below", "year": "2026", "type": "series", "imdbID": None}
        with patch("movie_renamer.existing_series", return_value=local), \
                patch("movie_renamer.requests.get", side_effect=AssertionError("unexpected network")):
            self.assertEqual(query_omdb_series("Below"), local)

    def test_real_release_shape_reaches_existing_import_path_without_losing_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            folder = source / "Below.S01.1080p.NF.WEB-DL.H.264-EniaHD"
            folder.mkdir()
            for number in range(1, 7):
                (folder / f"Below.S01E{number:02d}.1080p.mkv").write_bytes(b"fixture")
            with patch.object(config, "SOURCE_DIR", str(source)), \
                    patch("movie_renamer.ready_for_import", return_value=True), \
                    patch("movie_renamer.is_still_transferring", return_value=False):
                movies, shows = find_media_in_source()
            self.assertEqual(movies, [])
            self.assertEqual(len(shows), 1)
            self.assertEqual(shows[0]["tv_info"]["title"], "Below")
            self.assertIsNone(shows[0]["tv_info"]["year"])
            rows = [self.row(i) for i in range(11)]
            rows[-1] = self.row(10, "Below", imdb_id="tt35934755")
            with patch("movie_renamer.existing_series", return_value=None), \
                    patch("movie_renamer.requests.get", side_effect=self.pages(rows)), \
                    patch("movie_renamer.move_tv_show", return_value=True) as move:
                self.assertEqual(process_tv_shows_list(shows, dry_run=True), (1, 0))
            self.assertEqual(move.call_args.args[0]["parse_name"], folder.name)
            self.assertEqual(move.call_args.args[1], {"title": "Below", "year": "2026", "type": "series",
                                                    "imdbID": "tt35934755"})
            self.assertEqual(move.call_args.kwargs, {"dry_run": True})
            self.assertEqual(len(list(folder.iterdir())), 6)


class TestNormalize(unittest.TestCase):
    def test_punctuation_equivalence(self):
        self.assertEqual(
            normalize_for_match("R.I.P.D. 2: Rise of the Damned"),
            normalize_for_match("R I P D 2 Rise of the Damned"),
        )

    def test_ampersand(self):
        self.assertEqual(normalize_for_match("Law & Order"), normalize_for_match("Law and Order"))


class TestMissingMovieYear(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.source = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _movie(self, folder_name="Iron Man [1080p]", filenames=None):
        folder = self.source / folder_name
        folder.mkdir(exist_ok=True)
        filenames = filenames if filenames is not None else ["Iron.Man.2008.1080p.BrRip.x264.YIFY.mp4"]
        videos = []
        for index, name in enumerate(filenames):
            video = folder / name
            video.write_bytes(b"fixture" * (index + 1))
            videos.append(video)
        return {"type": "folder", "path": folder, "parse_name": folder.name,
                "video_files": videos, "subtitle_files": []}

    def test_actual_iron_man_filename_supplies_only_the_missing_year(self):
        movie = self._movie()
        title, year = parse_filename(movie["parse_name"])
        self.assertEqual((title, year), ("Iron Man", None))
        self.assertEqual(infer_missing_movie_year(movie, title, year), "2008")
        self.assertEqual(movie["parse_name"], "Iron Man [1080p]")

    def test_only_punctuation_whitespace_and_case_may_differ(self):
        movie = self._movie()
        self.assertEqual(infer_missing_movie_year(movie, "IRON - MAN", None), "2008")

    def test_sequel_article_and_missing_title_words_cannot_supply_a_year(self):
        for filename in ("Iron.Man.2.2010.1080p.mp4", "The.Iron.Man.2008.1080p.mp4",
                         "Man.2008.1080p.mp4", "Iron.Manual.2008.1080p.mp4"):
            with self.subTest(filename=filename):
                movie = self._movie(filenames=[filename])
                self.assertIsNone(infer_missing_movie_year(movie, "Iron Man", None))

    def test_multiple_videos_never_select_a_year_even_when_they_agree(self):
        movie = self._movie(filenames=["Iron.Man.2008.1080p.mp4", "Iron.Man.2008.720p.mkv"])
        self.assertIsNone(infer_missing_movie_year(movie, "Iron Man", None))

    def test_supplied_folder_year_is_never_overridden_or_reparsed(self):
        movie = self._movie(folder_name="Iron Man (2009) [1080p]")
        title, year = parse_filename(movie["parse_name"])
        with patch("movie_renamer.parse_filename") as parse_inner:
            self.assertEqual(infer_missing_movie_year(movie, title, year), "2009")
        parse_inner.assert_not_called()

    def test_no_video_year_or_subtitle_only_year_leaves_year_unknown(self):
        movie = self._movie(filenames=["Iron.Man.1080p.mp4"])
        subtitle = movie["path"] / "Iron.Man.2008.srt"
        subtitle.write_text("fixture")
        movie["subtitle_files"] = [subtitle]
        self.assertIsNone(infer_missing_movie_year(movie, "Iron Man", None))
        movie["video_files"] = []
        self.assertIsNone(infer_missing_movie_year(movie, "Iron Man", None))

    def test_loose_items_do_not_inherit_another_file_year(self):
        movie = self._movie()
        movie["type"] = "loose"
        self.assertIsNone(infer_missing_movie_year(movie, "Iron Man", None))

    def test_source_discovery_and_processing_keep_download_identity_with_exact_lookup(self):
        movie = self._movie()
        metadata = {"title": "Iron Man", "year": "2008", "type": "movie"}
        with patch.object(config, "SOURCE_DIR", str(self.source)), \
                patch("movie_renamer.ready_for_import", return_value=True), \
                patch("movie_renamer.is_still_transferring", return_value=False):
            movies, shows = find_media_in_source()
        self.assertEqual(shows, [])
        self.assertEqual(len(movies), 1)
        self.assertEqual(movies[0], movie)
        with patch("movie_renamer._watch_skip_logged", set()), \
                patch("movie_renamer._omdb_no_match_cache", {}), \
                patch("movie_renamer.query_omdb_exact", return_value=metadata) as lookup, \
                patch("movie_renamer.query_omdb_search") as search, \
                patch("movie_renamer.check_if_actually_series") as series, \
                patch("movie_renamer.move_movie", return_value=True) as move, \
                patch("movie_renamer.requests.get", side_effect=AssertionError("unexpected network")), \
                self.assertLogs("movie_renamer", level="INFO") as logs:
            self.assertEqual(process_movies_list(movies, dry_run=True), (1, 0))
        lookup.assert_called_once_with("Iron Man", "2008")
        search.assert_not_called(); series.assert_not_called()
        move.assert_called_once_with(movie, metadata, dry_run=True)
        self.assertEqual(movies[0], movie)
        self.assertTrue(any("[MOVIE] Found: Iron Man [1080p]" in entry for entry in logs.output))
        self.assertTrue(any("Parsed: title='Iron Man', year=2008" in entry for entry in logs.output))
        self.assertTrue(movie["video_files"][0].is_file())

    def test_processing_ambiguous_or_explicit_year_items_keeps_original_source_in_review(self):
        cases = (
            ("Iron Man [1080p]", ["Iron.Man.2.2010.1080p.mp4"], None),
            ("Iron Man [1080p]", ["Another.Movie.2008.1080p.mp4"], None),
            ("Iron Man [1080p]", ["Iron.Man.2008.1080p.mp4", "Iron.Man.2008.720p.mkv"], None),
            ("Iron Man [1080p]", ["Iron.Man.1080p.mp4"], None),
            ("Iron Man (2009) [1080p]", ["Iron.Man.2008.1080p.mp4"], "2009"),
        )
        for folder, files, expected_year in cases:
            with self.subTest(folder=folder, files=files):
                movie = self._movie(folder_name=folder, filenames=files)
                skipped = set()
                with patch("movie_renamer._watch_skip_logged", skipped), \
                        patch("movie_renamer.query_omdb", return_value=None) as lookup, \
                        patch("movie_renamer.check_if_actually_series", return_value=None), \
                        patch("movie_renamer.move_movie") as move, \
                        self.assertLogs("movie_renamer", level="INFO") as logs:
                    self.assertEqual(process_movies_list([movie], dry_run=True), (0, 1))
                lookup.assert_called_once_with("Iron Man", expected_year)
                move.assert_not_called()
                self.assertEqual(skipped, {folder})
                self.assertEqual(movie["parse_name"], folder)
                self.assertTrue(any(f"[MOVIE] Found: {folder}" in entry for entry in logs.output))
                self.assertTrue(all(video.is_file() for video in movie["video_files"]))


class TestAcronymVariations(unittest.TestCase):
    def test_spaced_acronym_run(self):
        # PTN output for R.I.P.D.2.Rise.of.the.Damned.2022 (log 2026-06-05)
        variations = get_acronym_variations("R I P D 2 Rise of the Damned")
        self.assertIn("R.I.P.D. 2 Rise of the Damned", variations)
        self.assertIn("RIPD 2 Rise of the Damned", variations)

    def test_glued_digit_on_dotted_acronym(self):
        # PTN output for "R.I.P.D.2. Rise of the Damned (2022)" (log 2026-06-05)
        variations = get_acronym_variations("R.I.P.D.2. Rise of the Damned")
        self.assertIn("R.I.P.D. 2 Rise of the Damned", variations)

    def test_swat(self):
        variations = get_acronym_variations("S W A T")
        self.assertIn("S.W.A.T.", variations)
        self.assertIn("SWAT", variations)

    def test_no_false_positives_on_plain_titles(self):
        self.assertEqual(get_acronym_variations("The Wandering Earth"), [])
        # Single stray letter is not an acronym run ("X Men" handled by PTN already)
        self.assertEqual(get_acronym_variations("Malcolm X"), [])


class TestMovieVariations(unittest.TestCase):
    def test_ripd_end_to_end_from_filename(self):
        title, year = parse("R.I.P.D.2.Rise.of.the.Damned.2022.1080p.WEBRip.x264.mp4").get("title"), "2022"
        self.assertEqual(title, "R I P D 2 Rise of the Damned")
        variations = get_title_variations(title)
        self.assertIn("R.I.P.D. 2 Rise of the Damned", variations)

    def test_original_title_always_first(self):
        self.assertEqual(get_title_variations("Heat")[0], "Heat")

    @patch("movie_renamer.get_alias_variations", return_value=[])
    def test_pirates_folder_keeps_full_title_in_early_separator_queries(self, _aliases):
        title, year = parse_filename(
            "Pirates of the Caribbean - On Stranger Tides (2011) [1080p]")
        self.assertEqual(year, "2011")
        self.assertEqual(title, "Pirates of the Caribbean - On Stranger Tides")
        self.assertEqual(get_title_variations(title)[:3], [
            title, "Pirates of the Caribbean: On Stranger Tides",
            "Pirates of the Caribbean On Stranger Tides",
        ])


class TestSeparatorVariations(unittest.TestCase):
    def test_black_pearl_full_title_without_an_alias(self):
        variants = get_separator_variations(
            "Pirates of the Caribbean - The Curse of the Black Pearl")
        self.assertIn("Pirates of the Caribbean: The Curse of the Black Pearl", variants)
        self.assertIn("Pirates of the Caribbean The Curse of the Black Pearl", variants)
        self.assertNotIn("Pirates of the Caribbean", variants)
        self.assertNotIn("The Curse of the Black Pearl", variants)

    def test_colon_and_unicode_dash_forms_preserve_every_word_and_number(self):
        for title in ("Movie 2: Chapter Three - The Return", "Movie 2 – Chapter Three — The Return"):
            with self.subTest(title=title):
                variants = get_separator_variations(title)
                self.assertIn("Movie 2 Chapter Three The Return", variants)
                for variant in variants:
                    self.assertEqual(normalize_for_match(variant), normalize_for_match(title))

    def test_internal_word_hyphens_are_preserved(self):
        self.assertEqual(get_separator_variations("Spider-Man"), [])
        self.assertEqual(get_separator_variations("One-Way Ticket"), [])
        self.assertEqual(get_separator_variations("X-Men - Days of Future Past"), [
            "X-Men: Days of Future Past", "X-Men Days of Future Past",
        ])
        self.assertIn("Spider-Man - No Way Home", get_separator_variations("Spider-Man: No Way Home"))

    def test_empty_parts_do_not_create_shortened_titles(self):
        for title in ("Movie: ", ": Subtitle", "Movie - ", "Movie: : Subtitle"):
            with self.subTest(title=title):
                self.assertEqual(get_separator_variations(title), [])


class TestSeparatorLookup(unittest.TestCase):
    def setUp(self):
        self.title = "Pirates of the Caribbean - On Stranger Tides"
        self.canonical = "Pirates of the Caribbean: On Stranger Tides"
        self.result = {"title": self.canonical, "year": "2011", "type": "movie"}

    @patch("movie_renamer._omdb_no_match_cache", {})
    @patch("movie_renamer.time.sleep")
    @patch("movie_renamer.query_omdb_search", return_value=None)
    @patch("movie_renamer.get_alias_variations", return_value=[])
    def test_exact_full_title_plus_year_matches_without_network(self, _aliases, search, _sleep):
        def exact(title, year):
            return self.result if (title, year) == (self.canonical, "2011") else None
        with patch("movie_renamer.query_omdb_exact", side_effect=exact) as lookup:
            self.assertEqual(query_omdb(self.title, "2011"), self.result)
        self.assertEqual(lookup.call_args_list, [
            unittest.mock.call(self.title, "2011"),
            unittest.mock.call(self.canonical, "2011"),
        ])
        search.assert_not_called()

    @patch("movie_renamer.time.sleep")
    @patch("movie_renamer.query_omdb_search", return_value=None)
    @patch("movie_renamer.get_alias_variations", return_value=[])
    def test_separator_query_cannot_bypass_movie_year_or_full_title_checks(self, _aliases, _search, _sleep):
        wrong_results = [
            {**self.result, "type": "series"},
            {**self.result, "year": "2003"},
            {**self.result, "title": "Pirates of the Caribbean"},
            {**self.result, "title": "Pirates of the Caribbean: Dead Man's Chest"},
        ]
        for result in wrong_results:
            with self.subTest(result=result), patch("movie_renamer._omdb_no_match_cache", {}):
                with patch("movie_renamer.query_omdb_exact", return_value=result):
                    self.assertIsNone(query_omdb(self.title, "2011"))


class TestPossessiveVariations(unittest.TestCase):
    def test_only_one_word_changes_and_the_franchise_can_stay_plural(self):
        title = "Pirates of the Caribbean - At Worlds End"
        self.assertEqual(get_possessive_variations(title), [
            "Pirate's of the Caribbean - At Worlds End",
            "Pirates of the Caribbean - At World's End",
        ])
        self.assertNotIn("Pirate's of the Caribbean - At World's End", get_title_variations(title))
        self.assertIn("Pirates of the Caribbean: At World's End", get_title_variations(title))

    def test_candidate_count_is_bounded_and_existing_word_hyphens_stay_intact(self):
        title = "Grandmas Daddys Mamas Worlds Cars Dogs Cats Birds Foxes"
        self.assertEqual(len(get_possessive_variations(title)), 6)
        self.assertEqual(len(get_possessive_variations(title, limit=2)), 2)
        self.assertEqual(get_possessive_variations(title, limit=0), [])
        self.assertIn("Spider-Man - Grandma's Boy", get_possessive_variations("Spider-Man - Grandmas Boy"))
        self.assertEqual(get_possessive_variations("World's End"), [])
        full_title = title + ": Sisters Brothers Cousins"
        with patch("movie_renamer.get_alias_variations", return_value=[]):
            candidates = [value for value in get_title_variations(full_title) if "'" in value]
        self.assertLessEqual(len(candidates), 12)
        for candidate in candidates:
            self.assertEqual(candidate.count("'"), 1)
            self.assertEqual(
                candidate.replace("'", "").replace(":", "").split(),
                full_title.replace(":", "").split(),
            )

    @patch("movie_renamer.get_alias_variations", return_value=[])
    def test_at_worlds_end_original_title_and_year_resolve_via_exact_full_title(self, _aliases):
        title, year = parse_filename("Pirates of the Caribbean - At Worlds End (2007) [1080p]")
        self.assertEqual((title, year), ("Pirates of the Caribbean - At Worlds End", "2007"))
        canonical = "Pirates of the Caribbean: At World's End"
        result = {"title": canonical, "year": "2007", "type": "movie"}
        def exact(candidate, candidate_year):
            return result if (candidate, candidate_year) == (canonical, "2007") else None
        with patch("movie_renamer._omdb_no_match_cache", {}), patch("movie_renamer.time.sleep"), \
                patch("movie_renamer.query_omdb_search", return_value=None) as search, \
                patch("movie_renamer.query_omdb_exact", side_effect=exact) as lookup:
            self.assertEqual(query_omdb(title, year), result)
        self.assertEqual(lookup.call_args_list[0], unittest.mock.call(title, "2007"))
        self.assertEqual(lookup.call_args_list[-1], unittest.mock.call(canonical, "2007"))
        self.assertTrue(all(call.args[1] == "2007" for call in lookup.call_args_list))
        search.assert_not_called()

    @patch("movie_renamer.get_alias_variations", return_value=[])
    def test_possessive_lookup_still_rejects_other_sequels_years_and_media_types(self, _aliases):
        title = "Pirates of the Caribbean - At Worlds End"
        canonical = "Pirates of the Caribbean: At World's End"
        for result in (
            {"title": "Pirates of the Caribbean: Dead Man's Chest", "year": "2007", "type": "movie"},
            {"title": canonical, "year": "2017", "type": "movie"},
            {"title": canonical, "year": "2007", "type": "series"},
        ):
            with self.subTest(result=result), patch("movie_renamer._omdb_no_match_cache", {}), \
                    patch("movie_renamer.time.sleep"), patch("movie_renamer.query_omdb_search", return_value=None), \
                    patch("movie_renamer.query_omdb_exact", return_value=result):
                self.assertIsNone(query_omdb(title, "2007"))


class TestIsGoodMatch(unittest.TestCase):
    def test_accepts_punctuation_differences(self):
        self.assertTrue(is_good_match(
            "R I P D 2 Rise of the Damned", "2022",
            {"title": "R.I.P.D. 2: Rise of the Damned", "year": "2022", "type": "movie"},
        ))

    def test_ratio_is_punctuation_insensitive(self):
        self.assertEqual(
            title_match_ratio("R I P D 2 Rise of the Damned", "R.I.P.D. 2: Rise of the Damned"), 1.0)

    def test_still_rejects_wrong_movie(self):
        self.assertFalse(is_good_match(
            "The Lord of the Rings", "2001",
            {"title": "The Lord", "year": "2001", "type": "movie"},
        ))

    def test_still_rejects_big_year_gap(self):
        self.assertFalse(is_good_match(
            "The Thing", "2025",
            {"title": "The Thing", "year": "1982", "type": "movie"},
        ))


class TestSeriesVariations(unittest.TestCase):
    def test_sas_rogue_heroes_generalized(self):
        # Log 2026-05-22: OMDb lists this series as plain "Rogue Heroes"
        variations = get_series_title_variations("SAS Rogue Heroes")
        self.assertIn("Rogue Heroes", variations)
        self.assertIn("SAS: Rogue Heroes", variations)

    def test_acronym_drop_requires_two_remaining_words(self):
        # "NCIS Sydney" must NOT generate a bare "Sydney" lookup
        self.assertNotIn("Sydney", get_series_title_variations("NCIS Sydney"))

    def test_spaced_acronym_series(self):
        variations = get_series_title_variations("S W A T")
        self.assertIn("S.W.A.T.", variations)


class TestIsGoodSeriesMatch(unittest.TestCase):
    def test_accepts_contained_title(self):
        self.assertTrue(is_good_series_match(
            "SAS Rogue Heroes", None, {"title": "Rogue Heroes", "year": "2022", "type": "series"}))

    def test_rejects_one_word_hijack(self):
        self.assertFalse(is_good_series_match(
            "Some Long Show Name Documentary", None, {"title": "Name", "year": "2010", "type": "series"}))

    def test_rejects_unrelated_series(self):
        self.assertFalse(is_good_series_match(
            "Under the Dome", "2013", {"title": "Over the Garden Wall", "year": "2014", "type": "series"}))

    def test_accepts_exact_with_year_range(self):
        self.assertTrue(is_good_series_match(
            "Under the Dome", "2013", {"title": "Under the Dome", "year": "2013", "type": "series"}))

    def test_rejects_same_name_distant_year(self):
        self.assertFalse(is_good_series_match(
            "Battlestar Galactica", "2004", {"title": "Battlestar Galactica", "year": "1978", "type": "series"}))


class TestForeignReleasePrefix(unittest.TestCase):
    """SSDSSE-style CJK prefixes must not hide the real Latin title."""

    def test_ssdsse_signs(self):
        name = "【高清影视之家发布 www.SSDSSE.com】天兆[国英多音轨].Signs.2002.BluRay.1080p.x265.2Audio-SSDSSE"
        self.assertEqual(parse_filename(name), ("Signs", "2002"))

    def test_leading_cjk_run(self):
        self.assertEqual(strip_foreign_release_prefix("天兆.Signs.2002"), "Signs.2002")

    def test_plain_english_untouched(self):
        self.assertEqual(strip_foreign_release_prefix("Kraven The Hunter (2024) [1080p]"),
                         "Kraven The Hunter (2024) [1080p]")
        self.assertEqual(parse_filename("The.Sopranos.1999.S01E02.1080p")[0], "The Sopranos")


class TestMoveMovieDestination(unittest.TestCase):
    """move_movie must never delete a download because a junk-only folder
    already sits at the destination (the Kraven the Hunter data-loss bug)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.src = root / "src"
        self.dest = root / "Movies"
        self.src.mkdir()
        self.dest.mkdir()
        self._saved = (config.MOVIE_DEST_DIR, config.MOVIE_DEST_DIRS)
        config.MOVIE_DEST_DIR = str(self.dest)
        config.MOVIE_DEST_DIRS = [str(self.dest)]

    def tearDown(self):
        config.MOVIE_DEST_DIR, config.MOVIE_DEST_DIRS = self._saved
        self._tmp.cleanup()

    def _make_download(self):
        folder = self.src / "Kraven The Hunter (2024) [1080p] [WEBRip]"
        folder.mkdir()
        (folder / "Kraven.mkv").write_bytes(b"x" * 2048)
        return folder

    @patch("movie_renamer.check_movie", return_value=None)
    def test_junk_only_destination_does_not_eat_download(self, _guard):
        # Destination folder exists but holds only a scrap .txt — no movie.
        dest_folder = self.dest / "Kraven the Hunter (2024)"
        dest_folder.mkdir()
        (dest_folder / "[TGx]Downloaded from torrentgalaxy.to .txt").write_text("junk")

        folder = self._make_download()
        ok = move_movie({"type": "folder", "path": folder, "video_files": [folder / "Kraven.mkv"],
                         "subtitle_files": []}, {"title": "Kraven the Hunter", "year": "2024"})

        self.assertTrue(ok)
        moved = dest_folder / "Kraven the Hunter (2024).mkv"
        self.assertTrue(moved.exists(), "movie should be placed, not deleted")
        self.assertFalse(folder.exists(), "source cleaned up only after a real move")

    def test_real_existing_copy_is_left_alone(self):
        # Destination already has the actual movie — source is a true duplicate.
        dest_folder = self.dest / "Kraven the Hunter (2024)"
        dest_folder.mkdir()
        (dest_folder / "Kraven the Hunter (2024).mkv").write_bytes(b"y" * 4096)

        folder = self._make_download()
        ok = move_movie({"type": "folder", "path": folder, "video_files": [folder / "Kraven.mkv"],
                         "subtitle_files": []}, {"title": "Kraven the Hunter", "year": "2024"})

        self.assertFalse(ok)
        self.assertEqual((dest_folder / "Kraven the Hunter (2024).mkv").stat().st_size, 4096,
                         "existing copy must be untouched")

    def test_separator_equivalent_movie_on_another_root_retains_source_and_subtitle(self):
        other = Path(self._tmp.name) / "OtherMovies"
        other.mkdir()
        config.MOVIE_DEST_DIRS.append(str(other))
        existing = other / "Pirates of the Caribbean - On Stranger Tides (2011)"
        existing.mkdir()
        (existing / "movie.mp4").write_bytes(b"existing video")
        source = self.src / "Pirates of the Caribbean - On Stranger Tides (2011) [1080p]"
        source.mkdir()
        video, subtitle = source / "incoming.mp4", source / "incoming.srt"
        video.write_bytes(b"incoming video"); subtitle.write_text("incoming subtitle")
        with patch("movie_renamer.check_movie") as guard, patch("movie_renamer.review_item") as review:
            ok = move_movie({"type": "folder", "path": source, "video_files": [video],
                             "subtitle_files": [subtitle]},
                            {"title": "Pirates of the Caribbean: On Stranger Tides", "year": "2011"})
        self.assertFalse(ok); guard.assert_not_called()
        self.assertIn(str(existing), review.call_args.args[2])
        self.assertEqual(video.read_bytes(), b"incoming video")
        self.assertEqual(subtitle.read_text(), "incoming subtitle")
        self.assertEqual((existing / "movie.mp4").read_bytes(), b"existing video")
        self.assertEqual(list(self.dest.iterdir()), [], "no additional canonical folder may be created")

    def test_default_destination_is_checked_even_when_omitted_from_root_list(self):
        other = Path(self._tmp.name) / "OtherMovies"
        other.mkdir()
        config.MOVIE_DEST_DIRS = [str(other)]
        existing = self.dest / "Kraven - the Hunter (2024)"
        existing.mkdir()
        (existing / "movie.mkv").write_bytes(b"existing video")
        source = self._make_download()
        with patch("movie_renamer.check_movie") as guard:
            self.assertFalse(move_movie({"type": "folder", "path": source,
                                         "video_files": [source / "Kraven.mkv"], "subtitle_files": []},
                                        {"title": "Kraven the Hunter", "year": "2024"}))
            guard.assert_not_called()
        self.assertEqual((source / "Kraven.mkv").read_bytes(), b"x" * 2048)
        self.assertEqual((existing / "movie.mkv").read_bytes(), b"existing video")

    @patch("movie_renamer.check_movie", return_value=None)
    def test_equivalent_folder_with_only_junk_or_empty_video_does_not_block_import(self, _guard):
        existing = self.dest / "Kraven - the Hunter (2024)"
        existing.mkdir()
        (existing / "poster.jpg").write_bytes(b"poster")
        (existing / "empty.mp4").touch()
        source = self._make_download()
        self.assertTrue(move_movie({"type": "folder", "path": source,
                                   "video_files": [source / "Kraven.mkv"], "subtitle_files": []},
                                  {"title": "Kraven the Hunter", "year": "2024"}))
        self.assertTrue((self.dest / "Kraven the Hunter (2024)" / "Kraven the Hunter (2024).mkv").is_file())

    def test_unreadable_root_or_matching_folder_preserves_source(self):
        source = self._make_download()
        movie = {"type": "folder", "path": source, "video_files": [source / "Kraven.mkv"],
                 "subtitle_files": []}
        metadata = {"title": "Kraven the Hunter", "year": "2024"}
        with patch("movie_renamer.os.scandir", side_effect=PermissionError("library root unreadable")), \
                patch("movie_renamer.check_movie") as guard:
            self.assertFalse(move_movie(movie, metadata)); guard.assert_not_called()
        existing = self.dest / "Kraven - the Hunter (2024)"
        existing.mkdir()
        with patch("movie_renamer._folder_has_movie_video", side_effect=PermissionError("movie folder unreadable")), \
                patch("movie_renamer.check_movie") as guard:
            self.assertFalse(move_movie(movie, metadata)); guard.assert_not_called()
        self.assertTrue((source / "Kraven.mkv").is_file())
        self.assertFalse((self.dest / "Kraven the Hunter (2024)").exists())

    def test_missing_configured_root_preserves_source(self):
        config.MOVIE_DEST_DIRS.append(str(Path(self._tmp.name) / "OfflineDrive"))
        source = self._make_download()
        with patch("movie_renamer.check_movie") as guard:
            self.assertFalse(move_movie({"type": "folder", "path": source,
                                         "video_files": [source / "Kraven.mkv"], "subtitle_files": []},
                                        {"title": "Kraven the Hunter", "year": "2024"}))
            guard.assert_not_called()
        self.assertTrue((source / "Kraven.mkv").is_file())


class TestMovieFolderIdentity(unittest.TestCase):
    def test_only_punctuation_space_and_case_differences_are_equal(self):
        self.assertEqual(movie_folder_identity("Pirates - On Stranger Tides (2011)"),
                         movie_folder_identity("PIRATES: On Stranger Tides (2011)"))
        self.assertEqual(movie_folder_identity("Movie_Name (2011)"), movie_folder_identity("Movie Name (2011)"))

    def test_articles_numbers_years_and_word_boundaries_are_not_dropped(self):
        original = movie_folder_identity("The Movie Part 2 (2011)")
        for different in ("Movie Part 2 (2011)", "The Movie Part 3 (2011)",
                          "The Movie Part 2 (2010)", "The Movie (2011)", "The Movie Part2 (2011)"):
            with self.subTest(different=different):
                self.assertNotEqual(original, movie_folder_identity(different))


class TestCheckIfActuallySeries(unittest.TestCase):
    """check_if_actually_series is the only function here that touches the
    network, so query_omdb_exact is mocked rather than adding real HTTP calls
    to an offline suite. The case is real: "Band of Brothers" (2001) is OMDb
    type 'series'. The movie matcher's &type=movie filter hides that entry and
    matches "The Making of 'Band of Brothers'" instead — an unrelated 30-min
    documentary, correctly rejected by is_good_match — leaving a "no match"
    log line for a title OMDb actually knows perfectly well.
    """

    def test_reports_a_real_series_match(self):
        with patch("movie_renamer.query_omdb_exact",
                   return_value={"title": "Band of Brothers", "year": "2001", "type": "series"}) as mock_q:
            result = check_if_actually_series("Band of Brothers", None)
        self.assertEqual(result, {"title": "Band of Brothers", "year": "2001", "type": "series"})
        # type_filter=None is the entire point of this function: the first
        # version of this code called query_omdb_search, which hardcodes
        # type=movie internally and can never see past its own filter. Assert
        # the call shape directly so that regression cannot silently return.
        mock_q.assert_called_once_with("Band of Brothers", None, type_filter=None)

    def test_a_genuine_movie_type_reports_nothing_new(self):
        with patch("movie_renamer.query_omdb_exact",
                   return_value={"title": "Some Movie", "year": "2020", "type": "movie"}):
            result = check_if_actually_series("Some Movie", "2020")
        self.assertIsNone(result)

    def test_no_omdb_result_at_all_reports_nothing(self):
        with patch("movie_renamer.query_omdb_exact", return_value=None):
            result = check_if_actually_series("Totally Unknown Title Xyz", "2020")
        self.assertIsNone(result)

    def test_a_weak_title_match_is_not_trusted(self):
        # A loosely-related series under a very different name should not be
        # reported as "this is actually that show" on a coincidental hit.
        with patch("movie_renamer.query_omdb_exact",
                   return_value={"title": "Completely Different Show", "year": "1999", "type": "series"}):
            result = check_if_actually_series("Band of Brothers", None)
        self.assertIsNone(result)

    def test_falls_back_to_a_yearless_query_when_the_first_attempt_finds_nothing(self):
        calls = []

        def fake_query(title, year, type_filter=None):
            calls.append((title, year, type_filter))
            if year is not None:
                return None  # the year-qualified attempt finds nothing
            return {"title": "Band of Brothers", "year": "2001", "type": "series"}

        with patch("movie_renamer.query_omdb_exact", side_effect=fake_query):
            result = check_if_actually_series("Band of Brothers", "2001")
        self.assertEqual(result["type"], "series")
        self.assertEqual(calls, [
            ("Band of Brothers", "2001", None),
            ("Band of Brothers", None, None),
        ])


if __name__ == "__main__":
    unittest.main()
