"""titles.py holds the organizer's pure name logic; movie_renamer.py must keep offering every name."""
import ast
import unittest
from pathlib import Path

import movie_renamer as m
import titles

MOVED = ["clean_title", "create_clean_filename", "create_tv_filename", "extract_language_suffix", "get_acronym_variations",
         "get_file_parts", "get_possessive_variations", "get_separator_variations", "is_tv_show", "movie_folder_identity",
         "normalize_for_match", "parse_filename", "parse_tv_info", "strip_foreign_release_prefix", "title_match_ratio"]


class Moved(unittest.TestCase):
    def test_movie_renamer_still_offers_every_function_that_moved_the_same_ones(self):
        for name in MOVED:
            with self.subTest(name):
                self.assertIs(getattr(m, name), getattr(titles, name))

    def test_nothing_that_moved_is_defined_twice(self):
        defined_here = {node.name for node in ast.parse(Path(m.__file__).read_text()).body if isinstance(node, ast.FunctionDef)}
        self.assertEqual(defined_here & set(MOVED), set())

    def test_the_module_stays_pure(self):
        """Only text tools and the filename parser may be imported: no network, files, logging or settings."""
        imported = set()
        for node in ast.walk(ast.parse(Path(titles.__file__).read_text())):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(imported, {"html", "re", "difflib", "pathlib", "PTN"})

    def test_a_few_real_names_behave_as_before(self):
        self.assertEqual(titles.parse_filename("Iron.Man.2008.1080p.BluRay.x264-GRP"), ("Iron Man", "2008"))
        self.assertEqual(titles.parse_tv_info("Narcos.S02E03.1080p")["episode"], 3)
        self.assertEqual(titles.create_tv_filename("Show", 1, 2, "A &amp; B", ".mkv"), "Show - S01E02 - A & B.mkv")
        self.assertEqual(titles.create_clean_filename("Movie: Part 2", "2020", ".mkv"), "Movie Part 2 (2020).mkv")
        self.assertEqual(titles.extract_language_suffix("Forced.eng"), ".forced.eng")
        self.assertEqual(titles.get_file_parts(Path("/x/.srt")), ("", ".srt"))


if __name__ == "__main__":
    unittest.main()
