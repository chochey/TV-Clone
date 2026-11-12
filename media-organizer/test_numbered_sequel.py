"""A sequel filed under its number is found by the franchise name and the year.

Real case (2026-11-11): "Die Hard 3 (1995)" sat in review. OMDb knows the film only as "Die Hard with a
Vengeance"; a search for "Die Hard 3" returns three featurettes about it. A search for "Die Hard" in 1995
lists the film first, and it is the only 1995 title starting with "Die Hard" that is not named after the
nickname, and the only one of feature length.
"""
import unittest
from unittest.mock import patch

import movie_renamer as m
from organizer_testing import OrganizerTestCase


def row(title, year, imdb):
    return {"Title": title, "Year": year, "Type": "movie", "imdbID": imdb}


DIE_HARD_1995 = [
    row("Die Hard with a Vengeance", "1995", "tt0112864"),
    row("Behind the Scenes: Die Hard - With a Vengeance", "1995", "tt0352201"),
    row("Die Hard 3: Villains with a Vengeance", "1995", "tt5247302"),
    row("The Making of 'Die Hard: With a Vengeance'", "1995", "tt1249304"),
    row("The Making of 'Die Hard 3'", "1995", "tt5247288"),
    row("Die Hard 3: Bruce Willis Interview", "1995", "tt5247306"),
]
ROCKY_1990 = [row("Rocky Interlude", "1990", "tt0464588"), row("Rocky Dada", "1990", "tt14245502")]
RUNTIMES = {"tt0112864": "128 min", "tt0464588": "95 min", "tt14245502": "140 min", "tt9": "7 min"}


class NumberedSequelTests(OrganizerTestCase):
    def setUp(self):
        self.asked = []
        for target in ("movie_renamer.time.sleep", "movie_renamer.get_pinned_imdb_id"):
            p = patch(target, return_value=None)
            p.start()
            self.addCleanup(p.stop)
        m._omdb_no_match_cache.clear()

    def omdb(self, searches):
        def answer(params):
            self.asked.append({k: v for k, v in params.items() if k != "apikey"})
            if "i" in params:
                found = next((r for rows in searches.values() for r in rows if r["imdbID"] == params["i"]), None)
                return {"Response": "True", **found, "Runtime": RUNTIMES.get(params["i"], "N/A")} if found else {"Response": "False"}
            rows = searches.get((params.get("s"), params.get("y")))
            if "s" in params and rows:
                return {"Response": "True", "Search": rows, "totalResults": str(len(rows))}
            return {"Response": "False", "Error": "Movie not found!"}
        return patch("movie_renamer._omdb_get", side_effect=answer)

    def test_die_hard_3_is_die_hard_with_a_vengeance(self):
        with self.omdb({("Die Hard", "1995"): DIE_HARD_1995, ("Die Hard 3", "1995"): DIE_HARD_1995[2:3] + DIE_HARD_1995[4:]}):
            found = m.query_omdb("Die Hard 3", "1995")
        self.assertEqual((found or {}).get("imdbID"), "tt0112864")
        self.assertEqual(found["title"], "Die Hard with a Vengeance")

    def test_two_films_of_that_name_and_year_stay_in_review(self):
        with self.omdb({("Rocky", "1990"): ROCKY_1990}):
            self.assertIsNone(m.query_omdb("Rocky 5", "1990"))

    def test_a_short_film_is_not_the_sequel(self):
        with self.omdb({("Die Hard", "1995"): [row("Die Hard: The Short", "1995", "tt9")]}):
            self.assertIsNone(m.query_omdb("Die Hard 3", "1995"))

    def test_a_title_without_a_sequel_number_asks_nothing_more(self):
        with self.omdb({}):
            self.assertIsNone(m.query_omdb("Heat", "1995"))
        self.assertFalse([q for q in self.asked if q.get("s") == "Heat" and "i" in q])
        with self.omdb({}):
            m._omdb_no_match_cache.clear()
            self.assertIsNone(m.query_omdb("Apollo 13", "1995"))
        self.assertFalse([q for q in self.asked if q.get("s") == "Apollo"], "13 is not a sequel number")


if __name__ == "__main__":
    unittest.main()
