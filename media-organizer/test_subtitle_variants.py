"""Two subtitles of one language (English SDH and English forced, Spanish from Spain and from Latin
America...) used to be planned to the same name, so the organizer gave up on both and left a review
note per file. They now get a tag from their own name, and only true duplicates fall back to a number."""
import unittest
from pathlib import Path
from subtitle_variants import variant_tag, disambiguate_subtitles


class VariantTagTests(unittest.TestCase):
    def test_tags_come_from_the_part_of_the_name_that_is_not_the_language(self):
        self.assertEqual(variant_tag('English (SDH).eng', '.eng'), 'sdh')
        self.assertEqual(variant_tag('English (forced).eng', '.eng'), 'forced')
        self.assertEqual(variant_tag('Español (Latinoamérica).spa', '.spa'), 'latinoamerica')
        self.assertEqual(variant_tag('Español (España).spa', '.spa'), 'espana')
        self.assertEqual(variant_tag('Français (Canada).fre', '.fre'), 'canada')
        self.assertEqual(variant_tag('Português (Brasil).por', '.por'), 'brasil')
        self.assertEqual(variant_tag('中文（简体）.chi', '.chi'), 'simplified')
        self.assertEqual(variant_tag('中文（繁體）.chi', '.chi'), 'traditional')
        self.assertEqual(variant_tag('English.eng', '.eng'), None)
        self.assertEqual(variant_tag('Some.Movie.2026.1080p.eng', '.eng'), None)
        self.assertEqual(variant_tag('4_English', ''), None)


class DisambiguateTests(unittest.TestCase):
    def test_colliding_subtitles_get_their_variant_tag_and_lone_ones_keep_their_name(self):
        dest = Path('/lib/Masterplan (2026)')
        plan = [
            (Path('/src/Masterplan.mp4'), dest / 'Masterplan (2026).mp4'),
            (Path('/src/Subs/English (SDH).eng.srt'), dest / 'Masterplan (2026).eng.srt'),
            (Path('/src/Subs/English (forced).eng.srt'), dest / 'Masterplan (2026).eng.srt'),
            (Path('/src/Subs/Dansk.dan.srt'), dest / 'Masterplan (2026).dan.srt'),
            (Path('/src/Subs/中文（简体）.chi.srt'), dest / 'Masterplan (2026).chi.srt'),
            (Path('/src/Subs/中文（繁體）.chi.srt'), dest / 'Masterplan (2026).chi.srt'),
        ]
        out = disambiguate_subtitles(plan)
        self.assertEqual([d.name for _, d in out], ['Masterplan (2026).mp4', 'Masterplan (2026).eng.sdh.srt', 'Masterplan (2026).eng.forced.srt',
            'Masterplan (2026).dan.srt', 'Masterplan (2026).chi.simplified.srt', 'Masterplan (2026).chi.traditional.srt'])
        self.assertEqual([s for s, _ in out], [s for s, _ in plan], 'sources and order are untouched')

    def test_true_duplicates_are_numbered_and_videos_are_never_renamed(self):
        dest = Path('/lib/Film (2020)')
        plan = [
            (Path('/src/a/English.eng.srt'), dest / 'Film (2020).eng.srt'),
            (Path('/src/b/English.eng.srt'), dest / 'Film (2020).eng.srt'),
            (Path('/src/c/English.eng.srt'), dest / 'Film (2020).eng.srt'),
            (Path('/src/x.mkv'), dest / 'Film (2020).mkv'),
            (Path('/src/y.mkv'), dest / 'Film (2020).mkv'),
        ]
        out = disambiguate_subtitles(plan)
        self.assertEqual([d.name for _, d in out], ['Film (2020).eng.srt', 'Film (2020).eng.2.srt', 'Film (2020).eng.3.srt', 'Film (2020).mkv', 'Film (2020).mkv'])

    def test_a_tag_that_still_collides_gets_a_number(self):
        dest = Path('/lib/Film (2020)')
        plan = [(Path('/src/a/English (SDH).eng.srt'), dest / 'Film (2020).eng.srt'), (Path('/src/b/English (SDH).eng.srt'), dest / 'Film (2020).eng.srt')]
        self.assertEqual([d.name for _, d in disambiguate_subtitles(plan)], ['Film (2020).eng.sdh.srt', 'Film (2020).eng.sdh.2.srt'])


if __name__ == '__main__':
    unittest.main()
