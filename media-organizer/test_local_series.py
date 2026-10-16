"""A series already in the library keeps its folder's name, but gets OMDb's id so episode titles can be looked up.

Before, the local match carried no id, so every episode of an existing series was filed without a title
(and the title lookup by name fails for folders like "Da Vincis Demons", which lack OMDb's apostrophe)."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import config
import movie_renamer as m
from organizer_testing import OrganizerTestCase

OMDB_SERIES = {"title": "Da Vinci's Demons", "year": "2013", "type": "series", "imdbID": "tt2094262"}


class Local(OrganizerTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.tv = self.root / "tv"
        library = self.tv / "Da Vincis Demons (2013)" / "Season 01"
        library.mkdir(parents=True)
        (library / "Da Vincis Demons - S01E01 - The Hanged Man.mkv").write_bytes(b"x")
        fixture = patch.object(config, "TV_DEST_DIRS", [str(self.tv)])
        fixture.start()
        self.addCleanup(fixture.stop)
        self.single = patch.object(m, "_query_omdb_series_single", return_value=dict(OMDB_SERIES))
        self.lookup = self.single.start()
        self.addCleanup(self.single.stop)

    def test_the_folders_name_and_year_are_kept_and_omdbs_id_is_added(self):
        found = m.query_omdb_series("Da Vincis Demons", "2013")
        self.assertEqual(found, {"title": "Da Vincis Demons", "year": "2013", "type": "series", "imdbID": "tt2094262"})

    def test_the_id_is_looked_up_once_per_series_not_once_per_release(self):
        for _ in range(3):
            m.query_omdb_series("Da Vincis Demons", "2013")
        self.assertEqual(self.lookup.call_count, 1)

    def test_a_series_omdb_does_not_know_still_imports_without_titles_and_is_not_asked_again(self):
        self.lookup.return_value = None
        for _ in range(2):
            found = m.query_omdb_series("Da Vincis Demons", "2013")
        self.assertEqual((found["title"], found["imdbID"]), ("Da Vincis Demons", None))
        self.assertEqual(self.lookup.call_count, len(m.get_series_title_variations("Da Vincis Demons")),
                         "every spelling was tried once; the 'not found' is remembered")

    def test_a_dissimilar_omdb_answer_is_not_trusted_as_this_series(self):
        self.lookup.return_value = {"title": "Totally Different Show", "year": "2013", "type": "series", "imdbID": "tt0000001"}
        self.assertIsNone(m.query_omdb_series("Da Vincis Demons", "2013")["imdbID"])

    def test_when_omdb_cannot_be_asked_the_import_waits_instead_of_filing_without_titles(self):
        self.lookup.side_effect = m.OMDbUnavailableError("timed out")
        release = self.root / "share" / "Da.Vincis.Demons.S01E02.1080p"
        release.mkdir(parents=True)
        (release / "Da.Vincis.Demons.S01E02.1080p.mkv").write_bytes(b"x")
        show = {"type": "folder", "path": release, "parse_name": release.name, "video_files": [release / "Da.Vincis.Demons.S01E02.1080p.mkv"],
                "subtitle_files": [], "tv_info": m.parse_tv_info(release.name)}
        with self.assertLogs("movie_renamer", level="INFO"):
            self.assertEqual(m.process_tv_shows_list([show]), (0, 1))
        self.assertTrue((release / "Da.Vincis.Demons.S01E02.1080p.mkv").exists())
        self.assertNotIn(release.name, m._watch_skip_logged)

    def test_the_whole_import_names_the_episode_after_omdb_and_the_folder_after_the_library(self):
        release = self.root / "share" / "Da.Vincis.Demons.S01E02.1080p"
        release.mkdir(parents=True)
        video = release / "Da.Vincis.Demons.S01E02.1080p.mkv"
        video.write_bytes(b"x")
        subtitle = release / "Da.Vincis.Demons.S01E02.1080p.eng.srt"
        subtitle.write_bytes(b"s")
        show = {"type": "folder", "path": release, "parse_name": release.name, "video_files": [video], "subtitle_files": [subtitle],
                "tv_info": m.parse_tv_info(release.name)}
        with patch.object(m, "query_omdb_episode", return_value={"episode_title": "The Prisoner"}) as episode, \
                patch.object(m, "get_tv_dest", return_value=self.tv):
            self.assertEqual(m.process_tv_shows_list([show]), (1, 0))
        episode.assert_called_once_with("Da Vincis Demons", 1, 2, "tt2094262")
        season = self.tv / "Da Vincis Demons (2013)" / "Season 01"
        self.assertTrue((season / "Da Vincis Demons - S01E02 - The Prisoner.mkv").exists())
        self.assertTrue((season / "Da Vincis Demons - S01E02 - The Prisoner.eng.srt").exists())


if __name__ == "__main__":
    unittest.main()
