"""Fix & retry with an IMDb number: the person chose the exact film, so no title search or year rule
can overrule them. Real case (2026-10-26): "The Weight (2026)" (Ethan Hawke, Sundance 2026) is in OMDb
only as tt10794054 with Year 2020 and no cast, a placeholder from when it was announced. Every title
search either missed it or rejected it as six years off, so the release sat in review.
"""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import movie_renamer as m
from organizer_testing import OrganizerTestCase

WEIGHT = {"Response": "True", "Title": "The Weight", "Year": "2020", "Type": "movie",
          "imdbID": "tt10794054", "Runtime": "N/A"}


class PinnedImdbTests(OrganizerTestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.alias_file = os.path.join(self.dir.name, "organizer_aliases.json")
        env = patch.dict(os.environ, {"ORGANIZER_ALIAS_FILE": self.alias_file})
        env.start()
        self.addCleanup(env.stop)
        self.asked = []
        sleep = patch("movie_renamer.time.sleep")
        sleep.start()
        self.addCleanup(sleep.stop)

    def aliases(self, *rows):
        with open(self.alias_file, "w") as f:
            json.dump({"aliases": list(rows)}, f)

    def omdb(self, by_id):
        def answer(params):
            self.asked.append({k: v for k, v in params.items() if k != "apikey"})
            if "i" in params:
                return by_id.get(params["i"], {"Response": "False", "Error": "Incorrect IMDb ID."})
            return {"Response": "False", "Error": "Movie not found!"}
        return patch("movie_renamer._omdb_get", side_effect=answer)

    def test_the_chosen_film_is_used_with_the_release_year_when_omdb_still_has_a_placeholder(self):
        self.aliases({"id": "a", "from": "The Weight", "to": "tt10794054", "type": "movie", "year": "2026"})
        with self.omdb({"tt10794054": WEIGHT}):
            found = m.query_omdb("The Weight", "2026")
        self.assertEqual((found["title"], found["year"], found["imdbID"]), ("The Weight", "2026", "tt10794054"))
        self.assertEqual(self.asked, [{"i": "tt10794054"}], "one lookup by number, no title searches")

    def test_omdb_year_is_kept_when_it_is_within_a_year_of_the_release(self):
        self.aliases({"id": "a", "from": "Some Film", "to": "tt1234567", "type": "movie"})
        with self.omdb({"tt1234567": {**WEIGHT, "Title": "Some Film", "Year": "2020", "imdbID": "tt1234567"}}):
            self.assertEqual(m.query_omdb("Some Film", "2021")["year"], "2020")

    def test_a_number_chosen_for_one_year_does_not_capture_another_film_of_the_same_name(self):
        self.aliases({"id": "a", "from": "The Weight", "to": "tt10794054", "type": "movie", "year": "2026"})
        with self.omdb({"tt10794054": WEIGHT}):
            self.assertIsNone(m.query_omdb("The Weight", "2012"))
        self.assertFalse(any("i" in q for q in self.asked))
        self.assertFalse(any("tt10794054" in str(q.values()) for q in self.asked), "never searched as a title")

    def test_a_number_that_is_not_a_film_falls_back_to_the_normal_search(self):
        self.aliases({"id": "a", "from": "The Weight", "to": "tt0000001", "type": "movie", "year": "2026"})
        with self.omdb({"tt0000001": {**WEIGHT, "Type": "series", "imdbID": "tt0000001"}}):
            self.assertIsNone(m.query_omdb("The Weight", "2026"))
        self.assertGreater(len(self.asked), 1, "title searches still ran")

    def test_a_remembered_no_match_does_not_hide_a_new_choice(self):
        m._omdb_no_match_cache[("the weight", "2026")] = m.time.time()
        self.aliases({"id": "a", "from": "The Weight", "to": "tt10794054", "type": "movie", "year": "2026"})
        with self.omdb({"tt10794054": WEIGHT}):
            self.assertEqual(m.query_omdb("The Weight", "2026")["imdbID"], "tt10794054")

    def test_numbers_are_never_used_as_title_spellings(self):
        self.aliases({"id": "a", "from": "The Weight", "to": "tt10794054", "type": "movie"},
                     {"id": "b", "from": "The Weight", "to": "The Weight 2", "type": "movie"})
        self.assertEqual(m.get_alias_variations("The Weight", "movie"), ["The Weight 2"])

    def test_a_series_can_be_chosen_by_number_too(self):
        self.aliases({"id": "a", "from": "Rogue Heroes", "to": "tt7826276", "type": "series"})
        show = {"Response": "True", "Title": "SAS: Rogue Heroes", "Year": "2022–", "Type": "series", "imdbID": "tt7826276"}
        with self.omdb({"tt7826276": show}), patch("movie_renamer.existing_series", return_value=None):
            found = m.query_omdb_series("Rogue Heroes", None)
        self.assertEqual((found["title"], found["imdbID"]), ("SAS: Rogue Heroes", "tt7826276"))
        self.assertEqual(self.asked, [{"i": "tt7826276"}])

    def test_a_number_that_does_not_resolve_is_asked_about_once_not_every_poll(self):
        self.aliases({"id": "a", "from": "The Weight", "to": "tt0000001", "type": "movie", "year": "2026"})
        with self.omdb({"tt0000001": {**WEIGHT, "Type": "series", "imdbID": "tt0000001"}}):
            for _ in range(3):
                self.assertIsNone(m.query_omdb("The Weight", "2026"))
        self.assertEqual(sum(1 for q in self.asked if "i" in q), 1)

    def test_the_alias_file_is_read_again_only_when_it_changes(self):
        self.aliases({"id": "a", "from": "The Weight", "to": "The Weight of Water", "type": "movie"})
        from pathlib import Path
        real = Path.read_text
        with patch.object(m.Path, "read_text", autospec=True, side_effect=real) as reads:
            m.get_alias_variations("The Weight", "movie")
            m.get_alias_variations("The Weight", "movie")
            m.get_pinned_imdb_id("The Weight", "2026", "movie")
            self.assertEqual(reads.call_count, 1)
            self.aliases({"id": "a", "from": "The Weight", "to": "tt10794054", "type": "movie", "year": "2026"})
            os.utime(self.alias_file, (os.stat(self.alias_file).st_mtime + 5,) * 2)
            self.assertEqual(m.get_pinned_imdb_id("The Weight", "2026", "movie"), "tt10794054")
            self.assertEqual(reads.call_count, 2)


if __name__ == "__main__":
    unittest.main()
