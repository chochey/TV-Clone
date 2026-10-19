"""Tell apart subtitles of one language.

A release often ships two subtitles for one language: "English (SDH)" and "English (forced)",
"Español (España)" and "Español (Latinoamérica)", "中文（简体）" and "中文（繁體）". The language
suffix alone ("Film (2026).eng.srt") gives them one name, so the organizer used to leave both in
Share with a review note each. Here the part of the name that is not the language becomes a tag
between the language and the extension ("Film (2026).eng.sdh.srt"); two names that still match
are numbered. Videos are never renamed: two videos with one name are a real conflict.
"""
import re
import unicodedata
from pathlib import Path

import config

# Scripts and regions written in their own alphabet, so the tag stays ASCII.
_WORDS = {
    '简体': 'simplified', '简体中文': 'simplified', '简': 'simplified',
    '繁體': 'traditional', '繁体': 'traditional', '繁體中文': 'traditional', '繁': 'traditional',
}


def _ascii(text: str) -> str:
    """Lower-case ASCII letters, digits and hyphens: "Latinoamérica" -> "latinoamerica"."""
    folded = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', folded.lower()).strip('-')


def variant_tag(stem: str, lang_suffix: str) -> str | None:
    """The bracketed part of a subtitle's name ("English (SDH)" -> "sdh"), or None when there is none.

    `stem` is the file name without its extension and `lang_suffix` what extract_language_suffix
    made of it (".eng"); the tag comes only from the text before that suffix.
    """
    base = stem[:-len(lang_suffix)] if lang_suffix and stem.lower().endswith(lang_suffix.lower()) else stem
    match = re.search(r'[(（\[]([^()（）\[\]]+)[)）\]]', base)
    if not match:
        return None
    inner = match.group(1).strip()
    tag = _WORDS.get(inner) or _WORDS.get(inner.replace(' ', '')) or _ascii(inner)
    return tag or None


def _is_subtitle(path: Path) -> bool:
    return path.suffix.lower() in config.SUBTITLE_EXTENSIONS


def disambiguate_subtitles(plan: list) -> list:
    """Give colliding subtitle destinations distinct names. Order and sources are unchanged."""
    counts = {}
    for _, destination in plan:
        counts[destination] = counts.get(destination, 0) + 1
    taken = set(counts)
    out = []
    for source, destination in plan:
        if counts[destination] < 2 or not _is_subtitle(destination):
            out.append((source, destination))
            continue
        stem, suffix = destination.stem, destination.suffix
        tag = variant_tag(source.stem, _trailing_language(stem))
        candidate = destination.with_name(f"{stem}.{tag}{suffix}") if tag else destination
        if candidate in taken and candidate != destination or (candidate == destination and _claimed(destination, out)):
            base = candidate.stem
            number = 2
            while candidate in taken or _claimed(candidate, out):
                candidate = destination.with_name(f"{base}.{number}{suffix}")
                number += 1
        taken.add(candidate)
        out.append((source, candidate))
    return out


def _claimed(destination: Path, out: list) -> bool:
    return any(d == destination for _, d in out)


def _trailing_language(dest_stem: str) -> str:
    """The language suffix the destination already carries (".eng" of "Film (2026).eng")."""
    match = re.search(r'((?:\.[a-z]{2,3})+)$', dest_stem)
    return match.group(1) if match else ''
