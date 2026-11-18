"""An edition word at the end of a release name is not part of the film's title.

Real case (2026-11-17): "Underworld EXTENDED (2003) [1080p]" sat in review. OMDb has the film as
"Underworld"; "Underworld EXTENDED" matches nothing.
"""
import unittest
from unittest.mock import patch

import movie_renamer as m
from organizer_testing import OrganizerTestCase
from titles import strip_edition

FILMS = {
    ("Underworld", "2003"): {"Title": "Underworld", "Year": "2003", "Type": "movie", "imdbID": "tt0320691"},
    ("Uncut Gems", "2019"): {"Title": "Uncut Gems", "Year": "2019", "Type": "movie", "imdbID": "tt5727208"},
    ("The Final Cut", "2004"): {"Title": "The Final Cut", "Year": "2004", "Type": "movie", "imdbID": "tt0364343"},
}


class EditionWordTests(OrganizerTestCase):
    def setUp(self):
        for target in ("movie_renamer.time.sleep", "movie_renamer.get_pinned_imdb_id"):
            p = patch(target, return_value=None)
            p.start()
            self.addCleanup(p.stop)
        m._omdb_no_match_cache.clear()

        def answer(params):
            film = FILMS.get((params.get("t"), params.get("y")))
            return {"Response": "True", **film} if film else {"Response": "False", "Error": "Movie not found!"}
        p = patch("movie_renamer._omdb_get", side_effect=answer)
        p.start()
        self.addCleanup(p.stop)

    def test_names_lose_their_trailing_edition_words(self):
        for name, base in [
            ("Underworld EXTENDED", "Underworld"), ("Aliens Special Edition", "Aliens"),
            ("Blade Runner The Final Cut", "Blade Runner"), ("Kingdom of Heaven Directors Cut", "Kingdom of Heaven"),
            ("Das Boot Director's Cut", "Das Boot"), ("Bad Santa Unrated Extended Cut", "Bad Santa"),
            ("Akira Remastered", "Akira"), ("Alien Theatrical", "Alien"), ("Underworld - Extended", "Underworld"),
        ]:
            self.assertEqual(strip_edition(name), base, name)

    def test_titles_made_of_those_words_are_left_alone(self):
        for name in ("Uncut Gems", "The Final Cut", "Final Cut", "Extended", "Underworld", "Unrated"):
            self.assertEqual(strip_edition(name), name)

    def test_underworld_extended_is_underworld(self):
        found = m.query_omdb("Underworld EXTENDED", "2003")
        self.assertEqual((found or {}).get("imdbID"), "tt0320691")
        self.assertEqual(found["title"], "Underworld")

    def test_a_film_really_called_that_is_still_found(self):
        self.assertEqual((m.query_omdb("The Final Cut", "2004") or {}).get("imdbID"), "tt0364343")
        self.assertEqual((m.query_omdb("Uncut Gems", "2019") or {}).get("imdbID"), "tt5727208")


if __name__ == "__main__":
    unittest.main()
