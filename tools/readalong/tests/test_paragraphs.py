import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'transcript'))
from paragraphs import NameFixer, build_chapter, clean, split_paragraphs  # noqa: E402


def timed(text, start=10.0, step=0.3, pause_after=None):
    words, t = [], start
    for i, w in enumerate(text.split(' ')):
        words.append([t, t + step - 0.05, (' ' if i else '') + w])
        t += step + (pause_after.get(i, 0) if pause_after else 0)
    return words


class NameFixerTests(unittest.TestCase):
    def test_near_misses_are_respelled_keeping_endings(self):
        fix = NameFixer(['Whaidians', 'BrainPal', 'Jane Sagan'])
        self.assertEqual(fix(' Waidians'), ' Whaidians')
        self.assertEqual(fix('Waidian,'), 'Whaidian,')
        self.assertEqual(fix(' Saggan.'), ' Sagan.')
        self.assertEqual(fix.fixes, {'Waidians->Whaidians': 1, 'Waidian->Whaidian': 1, 'Saggan->Sagan': 1})

    def test_names_with_their_own_endings_and_ordinary_words_are_left_alone(self):
        fix = NameFixer(['Charlie', 'BrainPal', 'Colonial Defense Forces'])
        for word in (" Charlie's", ' BrainPals', ' Force', ' Colonials', ' house', ' Kat'):
            self.assertEqual(fix(word), word, word)
        self.assertEqual(fix.fixes, {})


class ParagraphTests(unittest.TestCase):
    def test_breaks_at_a_pause_after_a_sentence_and_keeps_offsets_exact(self):
        sentence = 'This is a sentence that keeps going for quite a while so that the paragraph has comfortably more than the twenty five words it needs before a pause.'
        words = timed(sentence + ' ' + sentence, pause_after={len(sentence.split()) - 1: 1.5})
        paragraphs = build_chapter(1, 0.0, 200.0, words)
        self.assertEqual(len(paragraphs), 2)
        for p in paragraphs:
            self.assertEqual(p['text'], sentence)
            for a, b, s, e in p['words']:
                self.assertTrue(p['text'][a:b].strip())
                self.assertTrue(p['start'] <= s < e <= p['end'])
        self.assertLessEqual(paragraphs[0]['end'], paragraphs[1]['start'])

    def test_overlapping_recogniser_timings_become_monotonic(self):
        words = [[5.0, 5.4, 'Hello'], [5.2, 5.3, ' there.']]
        (p,) = build_chapter(2, 0.0, 10.0, words)
        (_, _, s1, e1), (_, _, s2, e2) = p['words']
        self.assertGreaterEqual(s2, e1)
        self.assertGreater(e2, s2)

    def test_text_cannot_carry_markup_or_control_characters(self):
        self.assertEqual(clean('a <b>\x07c'), 'a ‹b›c')

    def test_a_long_run_without_pauses_is_still_split(self):
        self.assertGreater(len(split_paragraphs(timed(' '.join(['word'] * 600)))), 1)


if __name__ == '__main__':
    unittest.main()
