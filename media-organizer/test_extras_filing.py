"""move_tv_show files a pack's bonus videos under <Series>/Extras and leaves doubtful files alone."""
import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import movie_renamer as m
from organizer_testing import OrganizerTestCase


class Captured(logging.Handler):
    def __init__(self):
        super().__init__(logging.INFO)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())

    def reviews(self):
        return [json.loads(line.split("REVIEW: ", 1)[1]) for line in self.lines if line.startswith("REVIEW: ")]


class Packs(OrganizerTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.series = {"title": "Narcos", "year": "2015", "imdbID": "tt2707788"}
        self.episode_titles = Mock(return_value=None)
        for name, value in [("get_tv_dest", self.root / "tv"), ("check_movie", None)]:
            fixture = patch.object(m, name, return_value=value)
            fixture.start()
            self.addCleanup(fixture.stop)
        fixture = patch.object(m, "query_omdb_episode", self.episode_titles)
        fixture.start()
        self.addCleanup(fixture.stop)

    # -- building and inspecting trees
    def pack(self, files, name="Narcos.S01-S03", tv=None):
        folder = self.root / "share" / name
        for relative, size in files.items():
            path = folder / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x" * size)
        return {"type": "folder", "path": folder, "parse_name": name,
                "video_files": sorted(folder.rglob("*.mkv")), "subtitle_files": sorted(folder.rglob("*.srt")),
                "tv_info": m.parse_tv_info(tv or name)}

    def tree(self, under):
        base = self.root / under
        return sorted(str(p.relative_to(base)) for p in base.rglob("*") if p.is_file()) if base.exists() else []

    def library(self):
        return self.tree("tv/Narcos (2015)")

    def run_pack(self, show, dry_run=False, series=None):
        capture = Captured()
        previous = m.log.level
        m.log.setLevel(logging.INFO)
        m.log.addHandler(capture)
        try:
            result = m.move_tv_show(show, series or self.series, dry_run=dry_run)
        finally:
            m.log.removeHandler(capture)
            m.log.setLevel(previous)
        return result, capture


class FilingExtras(Packs):
    def test_a_realistic_pack_is_sorted_into_episodes_extras_and_what_stays(self):
        show = self.pack({
            "Season 1/Narcos.S01E01.mkv": 1000, "Season 1/Narcos.S01E02.mkv": 1000, "Season 2/Narcos.S02E01.mkv": 1000,
            "Season 1/Behind the Scenes.mkv": 200, "Season 2/Behind the Scenes.mkv": 200,
            "Deleted Scenes.mkv": 300, "Featurettes/Making Of.mkv": 300, "Featurettes/Making Of.eng.srt": 10,
            "Sample/sample.mkv": 50, "Some Movie 2008.mkv": 400, "notes.nfo": 5,
        })
        result, capture = self.run_pack(show)
        self.assertTrue(result)
        self.assertEqual(self.library(), [
            "Extras/Deleted Scenes.mkv",
            "Extras/Featurettes/Making Of.eng.srt",
            "Extras/Featurettes/Making Of.mkv",
            "Extras/Season 01 - Behind the Scenes.mkv",
            "Extras/Season 02 - Behind the Scenes.mkv",
            "Season 01/Narcos - S01E01.mkv",
            "Season 01/Narcos - S01E02.mkv",
            "Season 02/Narcos - S02E01.mkv",
        ])
        self.assertEqual(self.tree("share/Narcos.S01-S03"), ["Sample/sample.mkv", "Some Movie 2008.mkv", "notes.nfo"])
        self.assertEqual(sorted(r["reason"] for r in capture.reviews()), sorted([
            "Not filed as an extra (its name mentions 2008, from before the series began): Some Movie 2008.mkv; source retained",
            "Not filed as an extra (it looks like a sample): sample.mkv; source retained",
        ]))
        self.assertIn("Filing 4 extras from Narcos.S01-S03 under Narcos (2015)/Extras", capture.lines)   # videos; the subtitle rides along
        self.assertEqual(sorted(r["file"] for r in capture.reviews()), ["Some Movie 2008.mkv", "sample.mkv"],
                         "each note names the file it is about, so the page can clear it once that file is imported")

    def test_extras_never_cost_an_omdb_request(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Deleted Scenes.mkv": 100, "Behind the Scenes.mkv": 100})
        self.run_pack(show)
        self.assertEqual(self.episode_titles.call_count, 1, "only the episode asked for a title")

    def test_the_bytes_are_unchanged_and_the_download_folder_goes_when_nothing_is_left(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Deleted Scenes.mkv": 300})
        (show["path"] / "Deleted Scenes.mkv").write_bytes(b"precious" * 40)
        self.run_pack(show)
        self.assertEqual((self.root / "tv/Narcos (2015)/Extras/Deleted Scenes.mkv").read_bytes(), b"precious" * 40)
        self.assertFalse(show["path"].exists(), "nothing left, so the empty folder is removed")

    def test_a_single_season_pack_prefixes_the_season(self):
        show = self.pack({"Narcos.S02E01.mkv": 1000, "Trivia.mkv": 100}, name="Narcos.S02.1080p")
        self.run_pack(show)
        self.assertIn("Extras/Season 02 - Trivia.mkv", self.library())

    def test_the_same_title_in_two_seasons_does_not_collide(self):
        show = self.pack({"Season 1/Narcos.S01E01.mkv": 1000, "Season 1/Trailer.mkv": 100, "Season 2/Trailer.mkv": 100})
        _, capture = self.run_pack(show)
        self.assertEqual([n for n in self.library() if n.startswith("Extras/")],
                         ["Extras/Season 01 - Trailer.mkv", "Extras/Season 02 - Trailer.mkv"])
        self.assertEqual(capture.reviews(), [])

    def test_an_existing_extra_is_never_overwritten(self):
        existing = self.root / "tv/Narcos (2015)/Extras/Deleted Scenes.mkv"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"already here")
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Deleted Scenes.mkv": 300, "Trivia.mkv": 100})
        _, capture = self.run_pack(show)
        self.assertEqual(existing.read_bytes(), b"already here")
        self.assertTrue((show["path"] / "Deleted Scenes.mkv").exists(), "the new copy is kept for a human to compare")
        self.assertIn("Extras/Trivia.mkv", self.library())
        self.assertEqual([r["reason"].split(":")[0] for r in capture.reviews()], ["Destination conflict"])
        self.assertEqual(capture.reviews()[0]["file"], "Deleted Scenes.mkv")


class WhenNotToFile(Packs):
    def test_a_pack_with_no_episode_and_nothing_in_the_library_is_left_alone(self):
        show = self.pack({"Deleted Scenes.mkv": 300}, name="Narcos.S02E03")
        before = self.tree("share")
        result, capture = self.run_pack(show)
        self.assertFalse(result)
        self.assertEqual(self.tree("share"), before)
        self.assertEqual(self.library(), [])
        self.assertEqual([r["reason"] for r in capture.reviews()],
                         ["Missing or ambiguous season/episode: Deleted Scenes.mkv; source retained"])

    def test_switched_off_everything_stays_and_is_reported_as_before(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Deleted Scenes.mkv": 300})
        with patch.object(m.config, "FILE_EXTRAS", False):
            _, capture = self.run_pack(show)
        self.assertEqual(self.tree("share/Narcos.S01-S03"), ["Deleted Scenes.mkv"])
        self.assertEqual([n for n in self.library() if "Extras" in n], [])
        self.assertEqual([r["reason"] for r in capture.reviews()],
                         ["Missing or ambiguous season/episode: Deleted Scenes.mkv; source retained"])

    def test_a_series_without_an_imdb_id_is_not_a_confident_match(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Deleted Scenes.mkv": 300})
        self.run_pack(show, series={"title": "Narcos", "year": "2015"})
        self.assertEqual(self.tree("share/Narcos.S01-S03"), ["Deleted Scenes.mkv"])

    def test_a_loose_file_is_never_filed_as_an_extra(self):
        folder = self.root / "share"
        folder.mkdir(parents=True)
        loose = folder / "Narcos.Documentary.mkv"
        loose.write_bytes(b"x" * 100)
        show = {"type": "loose", "path": loose, "parse_name": loose.stem, "tv_info": {"title": "Narcos", "season": 1}}
        result, capture = self.run_pack(show)
        self.assertFalse(result)
        self.assertTrue(loose.exists())
        self.assertEqual(self.library(), [])
        self.assertEqual([r["reason"] for r in capture.reviews()],
                         ["Missing or ambiguous season/episode: Narcos.Documentary.mkv; source retained"])

    def test_an_episode_whose_season_cannot_be_worked_out_is_reviewed_not_filed_as_an_extra(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Narcos.E04.mkv": 1000, "Deleted Scenes.mkv": 300},
                         name="Narcos.Complete", tv="Narcos.E01")   # the pack gives no season of its own
        _, capture = self.run_pack(show)
        self.assertEqual(self.tree("share/Narcos.Complete"), ["Narcos.E04.mkv"])
        self.assertIn("Extras/Deleted Scenes.mkv", self.library())
        self.assertEqual([r["reason"] for r in capture.reviews()],
                         ["Missing or ambiguous season/episode: Narcos.E04.mkv; source retained"])

    def test_something_much_larger_than_the_episodes_may_be_a_film_and_stays(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Fits.mkv": 1500, "Big.mkv": 1600})
        _, capture = self.run_pack(show)
        self.assertIn("Extras/Fits.mkv", self.library())
        self.assertEqual(self.tree("share/Narcos.S01-S03"), ["Big.mkv"])
        self.assertIn("much larger than the episodes", capture.reviews()[0]["reason"])

    def test_a_subtitle_that_belongs_to_nothing_stays_and_is_reported(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Deleted Scenes.mkv": 300, "Deleted Scenes.eng.srt": 5, "Orphan.eng.srt": 5})
        _, capture = self.run_pack(show)
        self.assertIn("Extras/Deleted Scenes.eng.srt", self.library())
        self.assertEqual(self.tree("share/Narcos.S01-S03"), ["Orphan.eng.srt"])
        self.assertEqual([r["reason"] for r in capture.reviews()],
                         ["Missing or ambiguous season/episode: Orphan.eng.srt; source retained"])


class BonusLeftBehindByAnEarlierImport(Packs):
    """The episodes were imported long ago and only the extras are still in Share."""

    def test_extras_are_filed_when_the_library_already_has_the_series(self):
        episode = self.root / "tv/Narcos (2015)/Season 01/Narcos - S01E01.mkv"
        episode.parent.mkdir(parents=True)
        episode.write_bytes(b"x" * 1000)
        show = self.pack({"Deleted Scenes.mkv": 300, "Behind the Scenes.mkv": 200})
        result, _ = self.run_pack(show)
        self.assertTrue(result)
        self.assertEqual([n for n in self.library() if n.startswith("Extras/")],
                         ["Extras/Behind the Scenes.mkv", "Extras/Deleted Scenes.mkv"])
        self.assertFalse(show["path"].exists())

    def test_a_series_folder_holding_only_extras_does_not_count_as_having_episodes(self):
        extra = self.root / "tv/Narcos (2015)/Extras/Trailer.mkv"
        extra.parent.mkdir(parents=True)
        extra.write_bytes(b"x")
        show = self.pack({"Deleted Scenes.mkv": 300})
        result, _ = self.run_pack(show)
        self.assertFalse(result)
        self.assertEqual(self.tree("share/Narcos.S01-S03"), ["Deleted Scenes.mkv"])


class ReviewRecords(Packs):
    def test_a_note_about_a_whole_release_names_no_file(self):
        capture = Captured()
        previous = m.log.level
        m.log.setLevel(logging.INFO)
        m.log.addHandler(capture)
        try:
            m.review_item({"path": Path("/share/Some.Film.2020"), "video_files": []}, "Some Film", "Multiple videos need individual identification; all source files retained")
            m.review_item({"path": Path("/share/Pack"), "tv_info": {}}, "Show", "Missing or ambiguous season/episode: a.mkv; source retained", "a.mkv")
        finally:
            m.log.removeHandler(capture)
            m.log.setLevel(previous)
        whole, single = capture.reviews()
        self.assertEqual(whole, {"type": "movie", "title": "Some Film", "source": "Some.Film.2020",
                                 "reason": "Multiple videos need individual identification; all source files retained"})
        self.assertEqual(single["file"], "a.mkv")
        self.assertEqual(single["type"], "show")


class Previews(Packs):
    def test_a_dry_run_changes_nothing_and_says_what_would_happen(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Deleted Scenes.mkv": 300})
        before = self.tree("share")
        result, capture = self.run_pack(show, dry_run=True)
        self.assertTrue(result)
        self.assertEqual(self.tree("share"), before)
        self.assertEqual(self.library(), [])
        moves = [line for line in capture.lines if line.startswith("[DRY RUN] Would move")]
        self.assertEqual(len(moves), 2)
        self.assertTrue(any(line.endswith("Narcos (2015)/Extras/Deleted Scenes.mkv") for line in moves))


class Scanning(Packs):
    def test_a_whole_scan_counts_the_pack_as_done_and_skips_nothing(self):
        show = self.pack({"Narcos.S01E01.mkv": 1000, "Deleted Scenes.mkv": 300})
        with patch.object(m, "query_omdb_series", return_value=self.series):
            self.assertEqual(m.process_tv_shows_list([show]), (1, 0))
        self.assertNotIn(show["parse_name"], m._watch_skip_logged)
        self.assertEqual(self.library(), ["Extras/Deleted Scenes.mkv", "Season 01/Narcos - S01E01.mkv"])


if __name__ == "__main__":
    unittest.main()
