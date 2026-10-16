"""Bonus videos in a TV pack are filed under <Series>/Extras instead of being stranded in Share."""
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import config
import extras
import movie_renamer as m
from organizer_testing import OrganizerTestCase


class Folder:
    """A throwaway directory tree: files are given as {relative path: size in bytes}."""

    def __init__(self, test):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def make(self, files, under=None):
        base = self.root / under if under else self.root
        for name, size in files.items():
            path = base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x" * size if isinstance(size, int) else size)
        return base


class Naming(unittest.TestCase):
    def setUp(self):
        self.pack = Path("/share/Pack")

    def parts(self, relative, pack_season=None):
        return extras.destination_parts(self.pack / relative, self.pack, pack_season)

    def test_a_file_at_the_top_of_the_pack_keeps_its_name(self):
        self.assertEqual(self.parts("Deleted Scenes.mkv"), ("Deleted Scenes.mkv",))

    def test_folders_in_the_pack_are_kept_below_extras(self):
        self.assertEqual(self.parts("Featurettes/Making Of.mkv"), ("Featurettes", "Making Of.mkv"))
        self.assertEqual(self.parts("Bonus/Cast/Interview.mkv"), ("Bonus", "Cast", "Interview.mkv"))

    def test_a_folder_that_is_itself_called_extras_is_not_repeated(self):
        self.assertEqual(self.parts("extras/Trailer.mkv"), ("Trailer.mkv",))

    def test_a_season_folder_becomes_a_prefix_so_two_seasons_cannot_collide(self):
        self.assertEqual(self.parts("Season 2/Behind the Scenes.mkv"), ("Season 02 - Behind the Scenes.mkv",))
        self.assertEqual(self.parts("S01/Behind the Scenes.mkv"), ("Season 01 - Behind the Scenes.mkv",))
        self.assertEqual(self.parts("Season 2/Featurettes/Making Of.mkv"), ("Featurettes", "Season 02 - Making Of.mkv"))

    def test_a_single_season_pack_prefixes_the_season_it_is_for(self):
        self.assertEqual(self.parts("Trivia.mkv", pack_season=3), ("Season 03 - Trivia.mkv",))

    def test_a_pack_spanning_several_seasons_adds_no_prefix_it_cannot_justify(self):
        self.assertEqual(self.parts("Trivia.mkv", pack_season=[1, 2, 3]), ("Trivia.mkv",))
        self.assertEqual(self.parts("Trivia.mkv", pack_season=None), ("Trivia.mkv",))

    def test_the_folder_wins_over_the_pack_season(self):
        self.assertEqual(self.parts("Season 2/Trivia.mkv", pack_season=1), ("Season 02 - Trivia.mkv",))

    def test_a_name_that_already_says_the_season_is_not_prefixed_twice(self):
        self.assertEqual(self.parts("Season 2 Gag Reel.mkv", pack_season=2), ("Season 2 Gag Reel.mkv",))
        self.assertEqual(self.parts("Season 02 - Gag Reel.mkv", pack_season=2), ("Season 02 - Gag Reel.mkv",))
        # ...but "Season 20" is not "Season 2".
        self.assertEqual(self.parts("Season 20 Gag Reel.mkv", pack_season=2), ("Season 02 - Season 20 Gag Reel.mkv",))

    def test_characters_a_filesystem_dislikes_are_removed(self):
        self.assertEqual(self.parts('What? "Really": Yes.mkv'), ("What Really Yes.mkv",))
        self.assertEqual(self.parts("Featurettes/Q&A: Cast?.mkv"), ("Featurettes", "Q&A Cast.mkv"))

    def test_the_extension_is_kept_and_lowercased(self):
        self.assertEqual(self.parts("Trailer.MKV"), ("Trailer.mkv",))

    def test_a_name_with_nothing_usable_in_it_gives_no_destination(self):
        self.assertEqual(self.parts("???.mkv"), (), "not a file called 'mkv'")
        self.assertEqual(self.parts("Featurettes/ . .mkv"), ())
        self.assertEqual(self.parts("???.mkv", pack_season=1), (), "no 'Season 01 -' stub of a name")
        self.assertEqual(self.parts("??/Trailer.mkv"), (), "a folder that cleans to nothing")

    def test_a_very_long_name_is_shortened_but_keeps_its_extension(self):
        long_name = "A" * 300 + ".mkv"
        (name,) = self.parts(long_name)
        self.assertTrue(name.endswith(".mkv"))
        self.assertLessEqual(len(name.encode()), 240)

    def test_multibyte_names_are_measured_in_bytes(self):
        (name,) = self.parts("é" * 200 + ".mkv")
        self.assertLessEqual(len(name.encode()), 240)
        self.assertTrue(name.endswith(".mkv"))


class SeriesStart(unittest.TestCase):
    def test_the_year_a_series_began(self):
        self.assertEqual(extras.series_start("2022"), 2022)
        self.assertEqual(extras.series_start("2015–2017"), 2015, "in case a whole run is ever passed")
        self.assertIsNone(extras.series_start(None))
        self.assertIsNone(extras.series_start("N/A"))


class Declining(unittest.TestCase):
    def setUp(self):
        self.pack = Path("/share/Pack")
        self.size = {}

    def reason(self, relative, start=2015, largest=1000):
        source = self.pack / relative
        self.size.setdefault(source, 100)
        return extras.decline_reason(source, self.pack, start, largest, self.size.__getitem__)

    def test_ordinary_bonus_material_is_accepted(self):
        for name in ("Deleted Scenes.mkv", "The Final Scene.mkv", "340 Tons Trivia.mkv", "Featurettes/Making Of.mkv"):
            with self.subTest(name):
                self.assertIsNone(self.reason(name))

    def test_samples_are_declined_by_name_or_folder(self):
        for name in ("Sample.mkv", "sample-clip.mkv", "Show.S01E01.SAMPLE.mkv", "Sample/clip.mkv", "Samples/a.mkv"):
            with self.subTest(name):
                self.assertEqual(self.reason(name), "it looks like a sample")

    def test_words_that_merely_contain_sample_are_not_samples(self):
        self.assertIsNone(self.reason("Resampled.mkv"))
        self.assertIsNone(self.reason("Examples of Chaos.mkv"))

    def test_a_much_bigger_file_may_be_a_film_and_is_declined(self):
        self.size[self.pack / "Big.mkv"] = 1600
        self.assertIn("separate film", self.reason("Big.mkv", largest=1000))
        self.size[self.pack / "Fits.mkv"] = 1500
        self.assertIsNone(self.reason("Fits.mkv", largest=1000))

    def test_without_episodes_to_compare_with_size_is_not_judged(self):
        self.size[self.pack / "Big.mkv"] = 10 ** 12
        self.assertIsNone(self.reason("Big.mkv", largest=None))

    def test_an_empty_or_unreadable_file_is_declined(self):
        self.size[self.pack / "Empty.mkv"] = 0
        self.assertEqual(self.reason("Empty.mkv"), "it is empty")
        def unreadable(path): raise OSError("gone")
        self.assertEqual(extras.decline_reason(self.pack / "x.mkv", self.pack, None, None, unreadable), "it could not be read")

    def test_a_year_from_before_the_series_began_suggests_a_different_title(self):
        self.assertEqual(self.reason("Some Movie 2008.mkv"), "its name mentions 2008, from before the series began")
        self.assertIn("2013", self.reason("Old 2013.mkv"))
        self.assertIn("1999, 2008", self.reason("Two Films 1999 2008.mkv"))

    def test_the_year_before_the_start_and_any_later_year_are_fine(self):
        self.assertIsNone(self.reason("Premiere 2014.mkv"), "one year before is allowed")
        self.assertIsNone(self.reason("Panel 2016.mkv"))
        self.assertIsNone(self.reason("Reunion 2023.mkv"), "a reunion long after the run is a normal extra")

    def test_when_the_start_year_is_unknown_any_year_in_the_name_is_declined(self):
        self.assertIn("2016", self.reason("Panel 2016.mkv", start=None))
        self.assertIsNone(self.reason("Deleted Scenes.mkv", start=None))


class Choosing(unittest.TestCase):
    def test_files_are_split_into_filed_and_declined_with_reasons(self):
        folder = Path("/p")
        sizes = {folder / "a.mkv": 10, folder / "Sample.mkv": 10, folder / "Film 1999.mkv": 10, folder / "???.mkv": 10}
        filed, declined = extras.choose_extras(folder, list(sizes), series_year="2015", largest_episode=100,
                                               pack_season=1, size_of=sizes.__getitem__)
        self.assertEqual(filed, [(folder / "a.mkv", ("Season 01 - a.mkv",))])
        self.assertEqual(declined, [
            (folder / "Sample.mkv", "it looks like a sample"),
            (folder / "Film 1999.mkv", "its name mentions 1999, from before the series began"),
            (folder / "???.mkv", "no usable file name could be made from it"),
        ])


class PairingSubtitles(unittest.TestCase):
    def test_a_subtitle_follows_the_extra_it_belongs_to_with_its_language(self):
        pack = Path("/p")
        video = pack / "Deleted Scenes.mkv"
        filed = [(video, ("Season 01 - Deleted Scenes.mkv",))]
        subs = [pack / "Deleted Scenes.eng.srt", pack / "Deleted Scenes.srt", pack / "Other.eng.srt",
                pack / "Sub" / "Deleted Scenes.eng.srt"]
        paired = extras.pair_subtitles(filed, subs, m.extract_language_suffix)
        self.assertEqual(paired, [(subs[0], ("Season 01 - Deleted Scenes.eng.srt",)),
                                  (subs[1], ("Season 01 - Deleted Scenes.srt",))])

    def test_the_match_ignores_case(self):
        pack = Path("/p")
        filed = [(pack / "Trivia.MKV", ("Trivia.MKV",))]
        paired = extras.pair_subtitles(filed, [pack / "trivia.ENG.SRT"], m.extract_language_suffix)
        self.assertEqual([parts for _, parts in paired], [("Trivia.eng.srt",)])


class LibraryCheck(unittest.TestCase):
    def test_a_series_with_an_episode_in_a_season_folder_counts(self):
        folder = Folder(self)
        base = folder.make({"Season 01/Show - S01E01.mkv": 5}, under="Show (2020)")
        self.assertTrue(extras.series_has_episodes(base))

    def test_missing_empty_and_extras_only_series_do_not(self):
        folder = Folder(self)
        self.assertFalse(extras.series_has_episodes(folder.root / "Nothing (2020)"))
        base = folder.make({"Season 01/.hidden": 1}, under="Empty (2020)")
        self.assertFalse(extras.series_has_episodes(base))
        base = folder.make({"Extras/Trailer.mkv": 5}, under="OnlyExtras (2020)")
        self.assertFalse(extras.series_has_episodes(base), "extras are not episodes")


class LibraryScannerSkipsExtras(unittest.TestCase):
    def test_the_media_server_ignores_the_folder_extras_are_filed_in(self):
        """Extras must stay out of the library listing: server.js has to skip this folder name."""
        server = (Path(__file__).resolve().parent.parent / "server.js").read_text()
        block = re.search(r"const SKIP_DIRS = new Set\(\[(.*?)\]\)", server, re.S)
        self.assertIsNotNone(block, "SKIP_DIRS not found in server.js")
        self.assertIn(extras.EXTRAS_DIR.lower(), re.findall(r"'([^']+)'", block.group(1)))


if __name__ == "__main__":
    unittest.main()
