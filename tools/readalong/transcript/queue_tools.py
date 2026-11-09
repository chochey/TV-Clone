"""Which audiobooks to transcribe, and with which names (pure: used by run_queue.py).

The Dungeon Crawler Carl books were first given read-along from their ebooks, matched against a full-cast
performance that changes lines, adds announcements and skips text, so the words drifted and some chapters had
no highlighting at all (the user, 2026-11-09). They are redone from the audio like the other books: the queue
comes from the library (--match), an ebook-made document is replaced only once its transcript is ready
(--replace; the old one is kept), and the spelling hints come from that ebook document, the book's own spelling
of every name.
"""
import re
from collections import Counter

_BOOK_NUMBER = re.compile(r'\bBook (\d+)\b', re.I)
# Capitalised words that are not names even in mid-sentence.
_NOT_NAMES = frozenset('''I I'm I'll I've I'd Mr Mrs Ms Dr OK Okay Oh God Monday Tuesday Wednesday Thursday Friday
Saturday Sunday January February March April May June July August September October November December
English American Earth Christmas'''.split())
# A capital after a lower-case word or punctuation inside the sentence; sentence starts are not evidence.
_MID_SENTENCE = re.compile(r"(?<=[a-z0-9,;:–—-] )([A-Z][A-Za-z'’-]+)")


def library_queue(items, match, first=()):
    """Audiobooks whose title or file name contains `match`: the ids in `first` lead, the rest by book number."""
    needle = match.lower()
    books = [{'id': i['id'], 'path': i['_filePath'], 'title': i.get('title') or i.get('filename') or i['id']}
             for i in items
             if isinstance(i, dict) and i.get('mediaKind') == 'audio' and i.get('_filePath') and i.get('id')
             and needle in f"{i.get('title') or ''} {i.get('filename') or ''}".lower()]
    order = {item_id: n for n, item_id in enumerate(first)}
    def key(b):
        number = _BOOK_NUMBER.search(b['title'])
        return (order.get(b['id'], len(order)), int(number.group(1)) if number else 999, b['title'])
    return sorted(books, key=key)


def plan(existing, replace):
    """What to do with a book, given its current read-along document (None when it has none)."""
    if existing is None:
        return 'transcribe'
    if existing.get('origin') == 'transcript':
        return 'skip: already made from the audio'
    return 'transcribe' if replace else 'skip: already has read-along'


def names_from_document(doc, limit=40, min_count=5):
    """The names a book uses most, spelt its way: capitalised words met mid-sentence, the most frequent first."""
    counts = Counter()
    for chapter in (doc or {}).get('chapters', []):
        for paragraph in chapter.get('paragraphs', []):
            for word in _MID_SENTENCE.findall(paragraph.get('text', '')):
                word = re.sub(r"['’]s$", '', word).strip("'’-")
                if len(word) > 1 and word not in _NOT_NAMES:
                    counts[word] += 1
    return [word for word, n in counts.most_common() if n >= min_count][:limit]
