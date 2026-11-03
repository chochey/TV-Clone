"""A series name OMDb knows several shows by, with no year in the release, is settled by the episode.

Real case (2026-11-03): "Nocturne.S01E01.Lazarus.Come.Forth.1080p.WEBRip..." (Apple TV's Nocturne, 2026).
OMDb has three series called exactly "Nocturne": a 2019 Twitch show whose S1E1 is "What's Real To You?",
the 2026 show whose episodes are still "Episode #1.1" placeholders, and a 1949 music show with no episode
list. "Exactly one candidate" failed, so both episodes sat in review although the episode title already
ruled the others out.
"""
import unittest
from unittest.mock import patch

import movie_renamer as m
from organizer_testing import OrganizerTestCase


def row(title, year, imdb):
    return {"Title": title, "Year": year, "Type": "series", "imdbID": imdb}


NOCTURNE_SEARCH = [
    row("Castlevania: Nocturne", "2023–", "tt14833612"),
    row("Nocturne", "2019–", "tt10486144"),
    row("Nocturne", "2026–", "tt26598805"),
    row("Nocturne", "1949–1950", "tt38479384"),
]
SEASONS = {
    ("tt10486144", "1"): ["What's Real To You?", "There Came A Knocking"],
    ("tt26598805", "1"): ["Episode #1.1", "Episode #1.2"],
}


class SeriesByEpisodeTests(OrganizerTestCase):
    def setUp(self):
        self.asked = []
        for target, value in (("movie_renamer.existing_series", None), ("movie_renamer._current_year", 2026),
                              ("movie_renamer.get_pinned_imdb_id", None)):
            p = patch(target, return_value=value)
            p.start()
            self.addCleanup(p.stop)

    def omdb(self, search=NOCTURNE_SEARCH, seasons=SEASONS):
        def answer(params):
            self.asked.append({k: v for k, v in params.items() if k != "apikey"})
            if "Season" in params:
                titles = seasons.get((params.get("i"), str(params["Season"])))
                if titles is None:
                    return {"Response": "False", "Error": "Series or season not found!"}
                return {"Response": "True", "Episodes": [
                    {"Title": t, "Episode": str(n), "Released": "2026-10-30"} for n, t in enumerate(titles, 1)]}
            if "s" in params:
                return {"Response": "True", "Search": search, "totalResults": str(len(search))}
            return {"Response": "False", "Error": "Series not found!"}
        return patch("movie_renamer._omdb_get", side_effect=answer)

    def find(self, title, season, episode, episode_title):
        hint = {"season": season, "episode": episode, "episode_title": episode_title}
        return m.query_omdb_series(title, None, episode_hint=hint)

    def test_the_new_show_is_chosen_when_the_others_have_a_different_episode_or_none(self):
        with self.omdb():
            found = self.find("Nocturne", 1, 1, "Lazarus Come Forth")
        self.assertEqual((found["title"], found["year"], found["imdbID"]), ("Nocturne", "2026", "tt26598805"))

    def test_an_episode_title_omdb_knows_picks_that_show_even_beside_a_new_one(self):
        with self.omdb():
            found = self.find("Nocturne", 1, 2, "There Came a Knocking")
        self.assertEqual(found["imdbID"], "tt10486144")

    def test_without_an_episode_title_in_the_name_it_still_asks(self):
        with self.omdb():
            self.assertIsNone(self.find("Nocturne", 1, 3, None))
        self.assertFalse(any("Season" in q for q in self.asked), "no episode lists are fetched for nothing")

    def test_an_old_show_with_placeholder_episodes_is_not_taken_for_a_new_one(self):
        seasons = {("tt10486144", "1"): ["What's Real To You?"], ("tt26598805", "1"): ["Episode #1.1"]}
        with self.omdb(seasons=seasons), patch("movie_renamer._current_year", return_value=2031):
            self.assertIsNone(self.find("Nocturne", 1, 1, "Lazarus Come Forth"))

    def test_two_new_shows_of_the_same_name_stay_in_review(self):
        search = [row("Nocturne", "2026–", "tt26598805"), row("Nocturne", "2025–", "tt99999999")]
        seasons = {("tt26598805", "1"): ["Episode #1.1"], ("tt99999999", "1"): ["Episode #1.1"]}
        with self.omdb(search=search, seasons=seasons):
            self.assertIsNone(self.find("Nocturne", 1, 1, "Lazarus Come Forth"))

    def test_a_show_whose_list_lacks_the_episode_is_not_chosen(self):
        seasons = {("tt10486144", "1"): ["What's Real To You?"], ("tt26598805", "1"): ["Episode #1.1"]}
        with self.omdb(seasons=seasons):
            self.assertIsNone(self.find("Nocturne", 1, 2, "For Such a Time as This"))

    def test_a_remembered_no_match_for_one_episode_does_not_hide_the_next(self):
        with self.omdb():
            self.assertIsNone(self.find("Nocturne", 1, 3, None))
            self.assertEqual(self.find("Nocturne", 1, 1, "Lazarus Come Forth")["imdbID"], "tt26598805")

    def test_one_exact_match_needs_no_episode_lists(self):
        search = [row("Castlevania: Nocturne", "2023–", "tt14833612"), row("Nocturne", "2026–", "tt26598805")]
        with self.omdb(search=search):
            self.assertEqual(self.find("Nocturne", 1, 1, "Lazarus Come Forth")["imdbID"], "tt26598805")
        self.assertFalse(any("Season" in q for q in self.asked))


if __name__ == "__main__":
    unittest.main()
