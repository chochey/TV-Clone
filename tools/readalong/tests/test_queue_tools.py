import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'transcript'))
from queue_tools import library_queue, names_from_document, plan  # noqa: E402


def book(id_, title, kind='audio'):
    return {'id': id_, 'title': title, 'mediaKind': kind, '_filePath': f'/books/{id_}.m4b', 'filename': f'{id_}.m4b'}


class LibraryQueueTests(unittest.TestCase):
    # 2026-11-09: the eight Dungeon Crawler Carl books, the one being listened to (book 4) first.
    LIBRARY = [book('b2', "Carl's Doomsday Scenario: Dungeon Crawler Carl, Book 2"), book('b1', 'Dungeon Crawler Carl: Dungeon Crawler Carl, Book 1'),
               book('b4', 'The Gate of the Feral Gods: Dungeon Crawler Carl, Book 4'), book('b7', 'This Inevitable Ruin : Dungeon Crawler Carl, Book 7'),
               book('x', 'Old Man\'s War'), book('film', 'Dungeon Crawler Carl: The Movie', kind='movie'), 'not a dict']

    def test_matching_audiobooks_in_book_order_with_the_chosen_ones_first(self):
        queue = library_queue(self.LIBRARY, 'dungeon crawler carl', first=['b4'])
        self.assertEqual([b['id'] for b in queue], ['b4', 'b1', 'b2', 'b7'])
        self.assertEqual(queue[0], {'id': 'b4', 'path': '/books/b4.m4b', 'title': 'The Gate of the Feral Gods: Dungeon Crawler Carl, Book 4'})

    def test_nothing_matches_nothing(self):
        self.assertEqual(library_queue(self.LIBRARY, 'Expanse'), [])


class PlanTests(unittest.TestCase):
    def test_a_book_is_redone_only_when_asked_and_never_over_a_transcript(self):
        self.assertEqual(plan(None, replace=False), 'transcribe')
        self.assertEqual(plan({'origin': 'ebook'}, replace=False), 'skip: already has read-along')
        self.assertEqual(plan({}, replace=True), 'transcribe', 'a document from the ebook has no origin')
        self.assertEqual(plan({'origin': 'transcript'}, replace=True), 'skip: already made from the audio')


class NamesTests(unittest.TestCase):
    def doc(self, *texts):
        return {'chapters': [{'paragraphs': [{'text': t} for t in texts]}]}

    def test_the_book_s_own_names_come_from_mid_sentence_capitals_most_frequent_first(self):
        texts = ['Carl looked at Donut. "Hello," said Donut to Mordecai and Katia.'] * 6 + \
                ['Then Mordecai said Katia was fine.'] * 3 + ['He went to the Desperado Club with Donut on Monday.'] * 5
        names = names_from_document(self.doc(*texts), limit=10, min_count=5)
        self.assertEqual(names[:3], ['Donut', 'Mordecai', 'Katia'])
        self.assertIn('Desperado', names)
        for word in ['Then', 'He', 'Hello', 'Monday', 'Carl']:
            # sentence starts, common words and days are not names; Carl here only starts sentences
            self.assertNotIn(word, names)

    def test_possessives_count_as_the_name_and_rare_words_are_left_out(self):
        texts = ["It was Donut's turn, and Donut's cat."] * 3 + ['a quiet Zev said hi'] * 2
        self.assertEqual(names_from_document(self.doc(*texts), min_count=5), ['Donut'])
        self.assertEqual(names_from_document({}, min_count=1), [])


if __name__ == '__main__':
    unittest.main()
