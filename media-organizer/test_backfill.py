"""Backfilling episode titles into library file names, and keeping subtitles attached."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

import backfill
from backfill import Rename


def titles(mapping):
    """A title_of() that knows these (season, episode) pairs and counts how often it was asked."""
    asked = []

    def title_of(season, episode):
        asked.append((season, episode))
        return mapping.get((season, episode))

    title_of.asked = asked
    return title_of


class Folder(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.season = self.root / "Show (2020)" / "Season 01"
        self.season.mkdir(parents=True)

    def make(self, *names):
        for name in names:
            (self.season / name).write_bytes(b"x")

    def plan(self, title_of, show="Show"):
        renames, notes = backfill.plan_folder(self.season, show, title_of)
        return {(r.source.name, r.destination.name, r.why) for r in renames}, notes


class AddingTitles(Folder):
    def test_a_titleless_video_gets_its_title_and_its_subtitles_follow_it(self):
        self.make("Show - S01E02.mkv", "Show - S01E02.eng.srt", "Show - S01E02.srt", "Show - S01E02.es.forced.srt",
                  "Show - S01E02.idx", "Show - S01E02.sub")
        got, notes = self.plan(titles({(1, 2): "The Pilot"}))
        self.assertEqual(got, {
            ("Show - S01E02.mkv", "Show - S01E02 - The Pilot.mkv", "title"),
            ("Show - S01E02.eng.srt", "Show - S01E02 - The Pilot.eng.srt", "subtitle"),
            ("Show - S01E02.srt", "Show - S01E02 - The Pilot.srt", "subtitle"),
            ("Show - S01E02.es.forced.srt", "Show - S01E02 - The Pilot.es.forced.srt", "subtitle"),
            ("Show - S01E02.idx", "Show - S01E02 - The Pilot.idx", "subtitle"),
            ("Show - S01E02.sub", "Show - S01E02 - The Pilot.sub", "subtitle"),
        })
        self.assertEqual(notes, [])

    def test_the_title_is_cleaned_exactly_as_the_importer_cleans_it(self):
        self.make("Show - S01E01.mp4")
        got, _ = self.plan(titles({(1, 1): "Q&amp;A: Who/What? <Now>"}))
        self.assertEqual(got, {("Show - S01E01.mp4", "Show - S01E01 - Q&A Who-What Now.mp4", "title")})

    def test_only_the_episode_that_has_a_known_title_changes(self):
        self.make("Show - S01E01.mkv", "Show - S01E01.srt", "Show - S01E02.mkv", "Show - S01E02.srt")
        got, _ = self.plan(titles({(1, 2): "Two"}))
        self.assertEqual({(a, b) for a, b, _ in got}, {("Show - S01E02.mkv", "Show - S01E02 - Two.mkv"), ("Show - S01E02.srt", "Show - S01E02 - Two.srt")})

    def test_an_unknown_title_leaves_the_video_and_its_subtitles_alone(self):
        self.make("Show - S01E01.mkv", "Show - S01E01.srt")
        self.assertEqual(self.plan(titles({}))[0], set())

    def test_episodes_that_could_not_be_titled_are_reported_for_the_summary(self):
        self.make("Show - S01E01.mkv", "Show - S01E02.mkv", "Show - S01E03 - Known.mkv", "Show - S01E04E05.mkv")
        missing = []
        backfill.plan_folder(self.season, "Show", titles({(1, 1): "One"}), missing)
        self.assertEqual(missing, ["S01E02"], "a titled episode and a combined one are not 'missing a title'")

    def test_a_title_that_cleans_to_nothing_is_not_used(self):
        self.make("Show - S01E01.mkv")
        self.assertEqual(self.plan(titles({(1, 1): "???"}))[0], set())

    def test_a_combined_episode_has_no_single_title_and_is_not_looked_up(self):
        self.make("Show - S01E01E02.mkv", "Show - S01E01E02.srt")
        lookup = titles({(1, 1): "One", (1, 2): "Two"})
        self.assertEqual(self.plan(lookup)[0], set())
        self.assertEqual(lookup.asked, [])

    def test_a_titled_video_is_never_asked_about(self):
        self.make("Show - S01E01 - Pilot.mkv")
        lookup = titles({(1, 1): "Something Else"})
        self.assertEqual(self.plan(lookup)[0], set())
        self.assertEqual(lookup.asked, [])

    def test_the_code_may_be_in_lower_case(self):
        self.make("Show - s01e01.mkv", "Show - s01e01.eng.srt")
        got, _ = self.plan(titles({(1, 1): "Pilot"}))
        self.assertEqual({(a, b) for a, b, _ in got}, {("Show - s01e01.mkv", "Show - s01e01 - Pilot.mkv"), ("Show - s01e01.eng.srt", "Show - s01e01 - Pilot.eng.srt")})


class RepairingSubtitles(Folder):
    def test_subtitles_that_cannot_attach_to_a_titled_video_are_renamed_to_match_it(self):
        self.make("Show - S01E01 - Episode #1.1.mp4", "Show - S01E01.srt", "Show - S01E01.eng.srt")
        lookup = titles({})
        got, _ = self.plan(lookup)
        self.assertEqual(got, {("Show - S01E01.srt", "Show - S01E01 - Episode #1.1.srt", "subtitle"),
                               ("Show - S01E01.eng.srt", "Show - S01E01 - Episode #1.1.eng.srt", "subtitle")})
        self.assertEqual(lookup.asked, [], "the video's own title is used: no OMDb request")

    def test_subtitles_that_already_attach_are_left_alone(self):
        self.make("Show - S01E01 - Pilot.mkv", "Show - S01E01 - Pilot.eng.srt", "Show - S01E01 - Pilot.srt")
        self.assertEqual(self.plan(titles({}))[0], set())

    def test_a_title_containing_dots_is_not_mistaken_for_language_tags(self):
        self.make("Show - S01E01 - Mr. Robot.mkv", "Show - S01E01.eng.srt")
        got, _ = self.plan(titles({}))
        self.assertEqual(got, {("Show - S01E01.eng.srt", "Show - S01E01 - Mr. Robot.eng.srt", "subtitle")})

    def test_a_subtitle_name_that_is_already_taken_is_reported_not_overwritten(self):
        self.make("Show - S01E01 - Mr. Robot.mkv", "Show - S01E01.eng.srt", "Show - S01E01 - Mr. Robot.eng.srt")
        got, notes = self.plan(titles({}))
        self.assertEqual(got, set())
        self.assertTrue(any("already exists" in note for note in notes), notes)

    def test_subtitles_of_another_episode_or_another_title_are_not_touched(self):
        self.make("Show - S01E01 - Pilot.mkv", "Show - S01E02.srt", "Show - S01E01 - Other.eng.srt", "Show - S01E011.srt")
        self.assertEqual(self.plan(titles({}))[0], set())


class Refusing(Folder):
    def test_a_name_that_is_already_taken_blocks_the_whole_episode(self):
        self.make("Show - S01E01.mkv", "Show - S01E01.srt", "Show - S01E01 - Pilot.srt")
        got, notes = self.plan(titles({(1, 1): "Pilot"}))
        self.assertEqual(got, set(), "nothing is renamed for that episode, so a video and its subtitles cannot end up apart")
        self.assertTrue(any("already exists" in note and "S01E01" in note for note in notes), notes)

    def test_two_videos_for_one_episode_are_ambiguous_and_skipped(self):
        self.make("Show - S01E01.mkv", "Show - S01E01.mp4", "Show - S01E01.srt")
        got, notes = self.plan(titles({(1, 1): "Pilot"}))
        self.assertEqual(got, set())
        self.assertTrue(any("more than one video" in note for note in notes), notes)

    def test_files_of_another_show_are_not_touched(self):
        self.make("Other Show - S01E01.mkv", "Other Show - S01E01.srt")
        self.assertEqual(self.plan(titles({(1, 1): "Pilot"}))[0], set())

    def test_files_that_do_not_look_like_episodes_are_not_touched(self):
        self.make("Show.S01E01.1080p.mkv", "Season Finale.mkv", "notes.txt", ".hidden.mkv", "Show - S01E01.nfo")
        self.assertEqual(self.plan(titles({(1, 1): "Pilot"}))[0], set())

    def test_two_episodes_that_would_get_the_same_name_do_not_collide(self):
        self.make("Show - S01E01.mkv", "Show - S01E02.mkv")
        got, notes = self.plan(titles({(1, 1): "Same", (1, 2): "Same"}))
        self.assertEqual(len(got), 2, "different codes keep the names different")


class Applying(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.journal = self.root / "journal.jsonl"
        self.folder = self.root / "Show (2020)" / "Season 01"
        self.folder.mkdir(parents=True)

    def file(self, name, data=b"x"):
        path = self.folder / name
        path.write_bytes(data)
        return path

    def test_renames_are_done_and_journaled_as_they_happen(self):
        a, b = self.file("a.mkv", b"A"), self.file("a.srt", b"S")
        result = backfill.apply([Rename(a, self.folder / "a - T.mkv", "title"), Rename(b, self.folder / "a - T.srt", "subtitle")], self.journal)
        self.assertEqual((result.done, result.skipped), (2, []))
        self.assertEqual((self.folder / "a - T.mkv").read_bytes(), b"A")
        self.assertEqual([json.loads(line) for line in self.journal.read_text().splitlines()],
                         [{"from": str(a), "to": str(self.folder / "a - T.mkv")}, {"from": str(b), "to": str(self.folder / "a - T.srt")}])

    def test_nothing_is_overwritten_even_if_the_name_appeared_after_planning(self):
        a = self.file("a.mkv", b"A")
        taken = self.file("a - T.mkv", b"OTHER")
        result = backfill.apply([Rename(a, taken, "title")], self.journal)
        self.assertEqual(result.done, 0)
        self.assertEqual(taken.read_bytes(), b"OTHER")
        self.assertTrue(a.exists())
        self.assertIn("already exists", result.skipped[0][1])

    def test_a_source_that_vanished_is_skipped(self):
        result = backfill.apply([Rename(self.folder / "gone.mkv", self.folder / "gone - T.mkv", "title")], self.journal)
        self.assertEqual(result.done, 0)
        self.assertIn("no longer", result.skipped[0][1])

    def test_a_rename_into_another_folder_is_refused(self):
        a = self.file("a.mkv")
        other = self.root / "elsewhere"
        other.mkdir()
        result = backfill.apply([Rename(a, other / "a.mkv", "title")], self.journal)
        self.assertEqual(result.done, 0)
        self.assertTrue(a.exists())
        self.assertIn("same folder", result.skipped[0][1])

    def test_a_failing_rename_does_not_stop_the_rest(self):
        a, b = self.file("a.mkv"), self.file("b.mkv")
        calls = []

        def flaky(source, destination):
            calls.append(source.name)
            if source.name == "a.mkv":
                raise PermissionError("denied")
            os.rename(source, destination)

        result = backfill.apply([Rename(a, self.folder / "a - T.mkv", "title"), Rename(b, self.folder / "b - T.mkv", "title")],
                                self.journal, rename=flaky)
        self.assertEqual(result.done, 1)
        self.assertIn("denied", result.skipped[0][1])
        self.assertTrue((self.folder / "b - T.mkv").exists())
        self.assertEqual(len(self.journal.read_text().splitlines()), 1, "only what really happened is journaled")

    def test_undo_puts_every_name_back_newest_first_and_never_overwrites(self):
        a, b = self.file("a.mkv", b"A"), self.file("a.srt", b"S")
        backfill.apply([Rename(a, self.folder / "a - T.mkv", "title"), Rename(b, self.folder / "a - T.srt", "subtitle")], self.journal)
        result = backfill.undo(self.journal)
        self.assertEqual((result.done, result.skipped), (2, []))
        self.assertEqual(a.read_bytes(), b"A")
        self.assertEqual(b.read_bytes(), b"S")
        self.assertFalse((self.folder / "a - T.mkv").exists())

    def test_undo_skips_what_has_changed_since(self):
        a = self.file("a.mkv")
        backfill.apply([Rename(a, self.folder / "a - T.mkv", "title")], self.journal)
        self.file("a.mkv", b"a different file has taken the old name")
        result = backfill.undo(self.journal)
        self.assertEqual(result.done, 0)
        self.assertIn("already exists", result.skipped[0][1])
        self.assertTrue((self.folder / "a - T.mkv").exists())
        (self.folder / "a - T.mkv").unlink()
        self.assertIn("no longer", backfill.undo(self.journal).skipped[0][1])

    def test_a_damaged_journal_line_is_ignored(self):
        self.journal.write_text('{"from": "/x/a", "to": "/x/b"}\nnot json\n{"from": 1}\n')
        result = backfill.undo(self.journal)
        self.assertEqual(result.done, 0)


class Discovery(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_only_series_folders_and_their_season_folders_are_visited(self):
        for relative in ["Show (2020)/Season 01/x.mkv", "Show (2020)/Season 10/y.mkv", "Show (2020)/Extras/z.mkv",
                         "Show (2020)/Subs/s.srt", "Odd name/Season 01/q.mkv", "Show (2020)/Season Finale/f.mkv", "loose.mkv"]:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")
        visited = sorted((series.name, title, season.name) for series, title, season in backfill.season_folders([self.root]))
        self.assertEqual(visited, [("Show (2020)", "Show", "Season 01"), ("Show (2020)", "Show", "Season 10")])

    def test_the_series_title_and_year_come_from_the_folder_name(self):
        (self.root / "Mr Robot (2015)" / "Season 02").mkdir(parents=True)
        (folder,) = list(backfill.season_folders([self.root]))
        self.assertEqual((folder[0].name, folder[1], folder[2].name), ("Mr Robot (2015)", "Mr Robot", "Season 02"))
        self.assertEqual(backfill.series_identity("Mr Robot (2015)"), ("Mr Robot", "2015"))
        self.assertIsNone(backfill.series_identity("Ash Vs Evil Dead ( (2015)"))
        self.assertIsNone(backfill.series_identity("No year"))


class Running(unittest.TestCase):
    """The whole walk, with OMDb replaced by two small stand-ins."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "TV"
        self.journal = Path(tmp.name) / "journal.jsonl"
        for relative in ["Alpha (2020)/Season 01/Alpha - S01E01.mkv", "Alpha (2020)/Season 01/Alpha - S01E01.eng.srt",
                         "Alpha (2020)/Season 01/Alpha - S01E02.mkv", "Alpha (2020)/Season 02/Alpha - S02E01.mkv",
                         "Beta (2019)/Season 01/Beta - S01E01 - Known.mp4", "Beta (2019)/Season 01/Beta - S01E01.srt",
                         "Gamma (2018)/Season 01/Gamma - S01E01.mkv"]:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")
        self.series_asked = []
        self.episodes_asked = []

    def series(self, title, year):
        self.series_asked.append(title)
        return None if title == "Gamma" else {"title": title, "year": year, "imdbID": f"tt-{title}"}

    def episode(self, series, season, episode):
        self.episodes_asked.append((series["title"], season, episode))
        return {("Alpha", 1, 1): "First", ("Alpha", 1, 2): "Second"}.get((series["title"], season, episode))

    def go(self, apply_changes):
        return backfill.run([self.root], find_series=self.series, episode_title=self.episode,
                            apply_changes=apply_changes, journal=self.journal)

    def names(self):
        return sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*") if p.is_file())

    def test_a_preview_changes_nothing_and_says_what_it_would_do(self):
        before = self.names()
        summary = self.go(False)
        self.assertEqual(self.names(), before)
        self.assertFalse(self.journal.exists())
        self.assertEqual((summary.titled, summary.subtitles), (2, 2), "two videos titled; Alpha's subtitle and Beta's orphan follow")
        self.assertEqual(len(summary.planned), 4)

    def test_applying_does_the_renames_and_journals_them(self):
        summary = self.go(True)
        self.assertEqual((summary.titled, summary.subtitles), (2, 2))
        self.assertEqual(self.names(), [
            "Alpha (2020)/Season 01/Alpha - S01E01 - First.eng.srt", "Alpha (2020)/Season 01/Alpha - S01E01 - First.mkv",
            "Alpha (2020)/Season 01/Alpha - S01E02 - Second.mkv", "Alpha (2020)/Season 02/Alpha - S02E01.mkv",
            "Beta (2019)/Season 01/Beta - S01E01 - Known.mp4", "Beta (2019)/Season 01/Beta - S01E01 - Known.srt",
            "Gamma (2018)/Season 01/Gamma - S01E01.mkv"])
        self.assertEqual(len(self.journal.read_text().splitlines()), 4)

    def test_it_asks_only_what_it_needs(self):
        self.go(False)
        self.assertEqual(sorted(set(self.series_asked)), ["Alpha", "Gamma"], "Beta needed no lookup: its subtitle was repaired from its own name")
        self.assertEqual(self.series_asked.count("Alpha"), 1, "one series lookup however many episodes need a title")
        self.assertEqual(sorted(self.episodes_asked), [("Alpha", 1, 1), ("Alpha", 1, 2), ("Alpha", 2, 1)])

    def test_the_summary_counts_episodes_still_without_a_title_by_series(self):
        summary = self.go(False)
        self.assertEqual(dict(summary.untitled), {"Alpha (2020)": 1, "Gamma (2018)": 1})   # Alpha S02E01 has no title in OMDb; Gamma is unknown

    def test_a_series_omdb_does_not_know_is_reported_and_left_alone(self):
        summary = self.go(True)
        self.assertEqual(summary.unmatched, ["Gamma (2018)"])
        self.assertTrue((self.root / "Gamma (2018)/Season 01/Gamma - S01E01.mkv").exists())

    def test_running_it_twice_finds_nothing_more_to_do(self):
        self.go(True)
        self.series_asked.clear()
        second = self.go(True)
        self.assertEqual((second.titled, second.subtitles), (0, 0))

    def test_when_omdb_gives_up_midway_what_was_done_stays_done_and_is_journaled(self):
        calls = {"n": 0}

        def failing(series, season, episode):
            calls["n"] += 1
            if calls["n"] == 3:
                raise RuntimeError("OMDb went away")
            return f"T{calls['n']}"

        with self.assertRaises(RuntimeError):
            backfill.run([self.root], find_series=self.series, episode_title=failing, apply_changes=True, journal=self.journal)
        # Alpha Season 01 was finished before the failure, and its renames were journaled as they happened.
        self.assertIn("Alpha (2020)/Season 01/Alpha - S01E01 - T1.mkv", self.names())
        self.assertGreaterEqual(len(self.journal.read_text().splitlines()), 3)
        undone = backfill.undo(self.journal)
        self.assertEqual(undone.skipped, [])
        self.assertIn("Alpha (2020)/Season 01/Alpha - S01E01.mkv", self.names())


if __name__ == "__main__":
    unittest.main()
