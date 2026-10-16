"""python3 movie_renamer.py --backfill-titles: the command around backfill.py."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import config
import movie_renamer as m
from organizer_testing import OrganizerTestCase


class Backfill(OrganizerTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.tv = self.base / "TV"
        for relative in ["Alpha (2020)/Season 01/Alpha - S01E01.mkv", "Alpha (2020)/Season 01/Alpha - S01E01.eng.srt",
                         "Alpha (2020)/Season 01/Alpha - S01E02.mkv"]:
            path = self.tv / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")
        for name, value in [("TV_DEST_DIRS", [str(self.tv)]), ("BACKFILL_DIR", str(self.base / "journals")),
                            ("OMDB_SEASON_CACHE", str(self.base / "seasons.json")), ("OMDB_USAGE_FILE", str(self.base / "usage.json"))]:
            fixture = patch.object(config, name, value)
            fixture.start()
            self.addCleanup(fixture.stop)
        self.titles = {1: "First", 2: "Episode #1.2"}
        series = patch.object(m, "query_omdb_series", side_effect=lambda title, year: {"title": title, "year": year, "imdbID": "tt1"})
        episode = patch.object(m, "query_omdb_episode", side_effect=lambda title, season, number, imdb: {"episode_title": self.titles[number]})
        series.start(); episode.start()
        self.addCleanup(series.stop); self.addCleanup(episode.stop)

    def names(self):
        return sorted(p.name for p in (self.tv / "Alpha (2020)" / "Season 01").iterdir())

    def journals(self):
        folder = self.base / "journals"
        return sorted(folder.glob("organizer-backfill-*.jsonl")) if folder.exists() else []

    def test_a_preview_lists_the_renames_and_changes_nothing(self):
        before = self.names()
        with self.assertLogs("movie_renamer", level="INFO") as logs:
            m.run_backfill(dry_run=True)
        self.assertEqual(self.names(), before)
        self.assertEqual(self.journals(), [])
        text = "\n".join(logs.output)
        self.assertIn("[DRY RUN] Would rename:", text)
        self.assertIn("Alpha - S01E01 - First.mkv", text)
        self.assertIn("[DRY RUN] [BACKFILL] 1 video would get a title, 1 subtitle renamed to match, in 1 season folder.", text)

    def test_applying_renames_journals_and_says_how_to_undo(self):
        with self.assertLogs("movie_renamer", level="INFO") as logs:
            m.run_backfill(dry_run=False)
        self.assertEqual(self.names(), ["Alpha - S01E01 - First.eng.srt", "Alpha - S01E01 - First.mkv", "Alpha - S01E02.mkv"])
        (journal,) = self.journals()
        self.assertIn(f"--undo-backfill {journal}", "\n".join(logs.output))

    def test_a_placeholder_title_is_not_written_into_a_file_name(self):
        m.run_backfill(dry_run=False)
        self.assertIn("Alpha - S01E02.mkv", self.names(), "OMDb called it 'Episode #1.2', which says nothing")

    def test_undo_puts_the_names_back(self):
        before = self.names()
        m.run_backfill(dry_run=False)
        (journal,) = self.journals()
        with self.assertLogs("movie_renamer", level="INFO") as logs:
            m.run_undo_backfill(journal)
        self.assertEqual(self.names(), before)
        self.assertIn("Put back 2 names", "\n".join(logs.output))

    def test_omdb_being_down_is_reported_and_nothing_is_lost(self):
        with patch.object(m, "query_omdb_episode", side_effect=m.OMDbUnavailableError("timed out")), \
                self.assertLogs("movie_renamer", level="INFO") as logs:
            m.run_backfill(dry_run=False)
        self.assertIn("Stopped: OMDb is not available (timed out)", "\n".join(logs.output))
        self.assertEqual(self.names(), ["Alpha - S01E01.eng.srt", "Alpha - S01E01.mkv", "Alpha - S01E02.mkv"])

    def test_the_summary_says_which_series_still_have_untitled_episodes(self):
        with self.assertLogs("movie_renamer", level="INFO") as logs:
            m.run_backfill(dry_run=True)
        self.assertIn("[BACKFILL] Still without a title (OMDb has none, or only a placeholder): Alpha (2020): 1", "\n".join(logs.output))

    def test_a_second_run_has_nothing_left_to_do(self):
        m.run_backfill(dry_run=False)
        with self.assertLogs("movie_renamer", level="INFO") as logs:
            m.run_backfill(dry_run=False)
        self.assertIn("0 videos got a title, 0 subtitles renamed to match", "\n".join(logs.output))


class Flags(OrganizerTestCase):
    def run_main(self, *args):
        with patch.object(sys, "argv", ["movie_renamer.py", *args]), patch.object(m, "setup_logging"), \
                patch.object(m, "run_backfill") as backfill_run, patch.object(m, "run_undo_backfill") as undo_run, \
                patch.object(m, "run_watch") as watch_run, patch.object(m, "run_once") as once_run:
            m.main()
        return backfill_run, undo_run, watch_run, once_run

    def test_backfill_titles_runs_the_backfill_and_nothing_else(self):
        backfill_run, undo_run, watch_run, once_run = self.run_main("--backfill-titles")
        backfill_run.assert_called_once_with(dry_run=False)
        for other in (undo_run, watch_run, once_run):
            other.assert_not_called()

    def test_dry_run_is_passed_on(self):
        backfill_run, *_ = self.run_main("--backfill-titles", "--dry-run")
        backfill_run.assert_called_once_with(dry_run=True)

    def test_undo_takes_a_journal_path(self):
        backfill_run, undo_run, *_ = self.run_main("--undo-backfill", "/some/journal.jsonl")
        undo_run.assert_called_once_with(Path("/some/journal.jsonl"))
        backfill_run.assert_not_called()

    def test_watch_mode_cannot_be_combined_with_it(self):
        backfill_run, _, watch_run, _ = self.run_main("--watch", "--backfill-titles")
        backfill_run.assert_not_called()
        watch_run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
