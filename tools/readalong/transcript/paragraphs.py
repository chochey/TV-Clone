"""Turning a word-timed transcript into read-along paragraphs (pure: no audio or model libraries).

Used by transcribe_book.py for audiobooks that have no ebook. The rules came from the Old Man's War trial
(2026-10-17): paragraphs break at a pause after a sentence end, or at a long pause; names are respelled only
for near misses of a sourced name list, keeping plural and possessive endings.
"""
import difflib
import re

_CONTROL = re.compile(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]')
_SENTENCE_END = re.compile(r'[.!?]["”’)]*$')


def clean(text):
    """Text the reader accepts: no control characters, no angle brackets (its markup guard)."""
    return _CONTROL.sub('', text).replace('<', '‹').replace('>', '›')


class NameFixer:
    """Respells a capitalised near miss of one of the book's names ('Waidian' -> 'Whaidian').

    Only names confirmed by a source belong in the list: a wrong hint makes real words wrong
    (an unsourced 'Keyes' turned the poet Keats into 'Keyes' in the trial).
    """

    def __init__(self, names, cutoff=0.84):
        self.tokens = sorted({t for n in names for t in re.findall(r"[A-Z][\w'-]+", n)})
        self.stems = sorted({self._stem(t) for t in self.tokens})
        self.cutoff = cutoff
        self.fixes = {}

    @staticmethod
    def _stem(word):
        return re.sub(r"(?i)('s|s)$", '', word)

    def __call__(self, word):
        core = re.sub(r"^\W+|\W+$", '', word)
        if len(core) < 4 or not core[0].isupper():
            return word
        base = self._stem(core)
        ending = core[len(base):]
        if any(base.lower() == s.lower() for s in self.stems) or any(core.lower() == t.lower() for t in self.tokens):
            return word
        match = difflib.get_close_matches(base, self.stems, n=1, cutoff=self.cutoff)
        if not match:
            return word
        name = match[0]
        if name[0].lower() != base[0].lower() or name.lower().startswith(base.lower()) or base.lower().startswith(name.lower()):
            return word
        key = f'{core}->{name}{ending}'
        self.fixes[key] = self.fixes.get(key, 0) + 1
        return word.replace(core, name + ending)


def split_paragraphs(words):
    """Group [start, end, word] items into paragraphs at natural pauses, keeping them a readable length."""
    paragraphs, current = [], []
    for i, (start, end, word) in enumerate(words):
        current.append([start, end, word])
        following = words[i + 1][0] if i + 1 < len(words) else None
        gap = (following - end) if following is not None else 99
        sentence_end = bool(_SENTENCE_END.search(word.strip()))
        n = len(current)
        if following is None or (sentence_end and ((gap >= 0.9 and n >= 25) or n >= 140)) or (gap >= 2.0 and n >= 8) or n >= 260:
            paragraphs.append(current)
            current = []
    return paragraphs


def build_chapter(index, chapter_start, chapter_end, words, fix=lambda w: w):
    """Paragraphs in the reader's format: ordered, non-overlapping, words monotonic inside each paragraph."""
    built, last_end = [], chapter_start
    for p_index, para in enumerate(split_paragraphs(words), 1):
        text, offsets, previous_end = '', [], None
        for start, end, word in para:
            word = fix(clean(word))
            piece = word if text else word.lstrip()
            if not piece.strip():
                continue
            lead = len(piece) - len(piece.lstrip())
            a = len(text) + lead
            text += piece
            b = len(text)
            start = max(start, last_end if previous_end is None else previous_end)
            end = max(end, start + 0.02)
            offsets.append([a, b, round(start, 3), round(end, 3)])
            previous_end = end
        if not offsets or not text.strip():
            continue
        p_start = offsets[0][2]
        p_end = min(chapter_end, max(offsets[-1][3], p_start + 0.05))
        offsets = [[a, b, s, min(e, p_end)] for a, b, s, e in offsets if s < p_end and min(e, p_end) > s]
        if not offsets:
            continue
        built.append({'id': f'c{index:02}-p{p_index:03}', 'text': text, 'start': p_start, 'end': p_end, 'words': offsets})
        last_end = p_end
    return built
