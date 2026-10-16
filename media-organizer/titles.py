"""Pure title and file-name logic for the organizer: no network, no files, no logging.

Reads a download's name (movie or TV), cleans it, compares it with OMDb's, and builds the library's
file names. Kept apart from movie_renamer.py so it can be read and tested on its own; movie_renamer
imports every name here, so callers (and tests that patch them there) are unaffected.
"""
import html
import re
from difflib import SequenceMatcher
from pathlib import Path

from PTN import parse


def movie_folder_identity(name: str) -> str:
    """Compare the complete folder title and year; only punctuation varies."""
    return re.sub(r"[\W_]+", " ", name.casefold()).strip()


# CJK block: fullwidth punctuation (incl. 【】), kana, Han, Hangul, fullwidth forms.
_CJK = r"　-〿぀-ヿ一-鿿가-힯＀-￯"


def strip_foreign_release_prefix(name: str) -> str:
    """Drop Chinese/Japanese/Korean release-site prefixes that hide the title.

    Sites like SSDSSE ship names as
      【高清影视之家发布 www.SSDSSE.com】天兆[国英多音轨].Signs.2002.BluRay...
    PTN then reads the whole CJK blob as the title and every OMDb lookup
    fails. If the name carries CJK, strip the 【…】 groups and any leading CJK
    runs (plus an attached […] tag) so the real Latin title leads.
    """
    if not re.search(f"[{_CJK}]", name):
        return name
    name = re.sub(r"【[^】]*】", " ", name)                       # 【site】 groups
    name = re.sub(f"[{_CJK}]+(\\s*\\[[^\\]]*\\])?", " ", name)   # CJK run + optional [tag]
    name = re.sub(r"^[\s.\-_]+", "", name)                       # leftover separators
    return re.sub(r"\s+", " ", name).strip()


def parse_filename(filename: str) -> tuple[str | None, str | None]:
    """Extract title and year from a filename using PTN."""
    parsed = parse(strip_foreign_release_prefix(filename))
    title = parsed.get("title")
    year = parsed.get("year")
    return title, str(year) if year else None


def clean_title(title: str) -> str:
    """Clean a title by removing common release group tags and normalizing."""
    release_tags = [
        r"\[TGx\]", r"\[YTS[^\]]*\]", r"\[RARBG\]", r"\[ettv\]", r"\[eztv\]",
        r"YTS\.MX", r"YTS\.LT", r"YTS\.AM", r"RARBG", r"TGx",
        r"\(TGx\)", r"\(RARBG\)", r"\(YTS[^\)]*\)",
    ]
    for tag in release_tags:
        title = re.sub(tag, "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s+", " ", title).strip()
    return title


def normalize_for_match(title: str) -> str:
    """Normalize a title for similarity comparison: case, punctuation, '&'.

    'R.I.P.D. 2: Rise of the Damned' and 'R I P D 2 Rise of the Damned'
    both normalize to 'r i p d 2 rise of the damned'.
    """
    s = title.lower().strip().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def title_match_ratio(a: str, b: str) -> float:
    """Title similarity that is robust to punctuation differences.

    Takes the best of raw and normalized comparison so existing accepts
    never get worse, but dots/colons/hyphens stop dragging scores down.
    """
    raw = SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()
    norm = SequenceMatcher(None, normalize_for_match(a), normalize_for_match(b)).ratio()
    return max(raw, norm)


def get_acronym_variations(title: str) -> list[str]:
    """Variations for acronym titles that PTN and OMDb disagree on.

    PTN strips dots, so 'R.I.P.D.2.Rise.of.the.Damned' parses as
    'R I P D 2 Rise of the Damned' while OMDb titles it
    'R.I.P.D. 2: Rise of the Damned'. Generates dotted, collapsed and
    unglued-digit forms so one of the exact queries can land.
    """
    results: list[str] = []
    base = re.sub(r"\s+", " ", title).strip().rstrip(".").strip()

    def add(value: str) -> None:
        value = re.sub(r"\s+", " ", value).strip()
        if value and value.lower() != title.lower().strip() and value not in results:
            results.append(value)

    # Runs of 2+ single-letter words: 'S W A T' -> 'S.W.A.T.' and 'SWAT'
    run_re = re.compile(r"\b([A-Za-z](?:\s+[A-Za-z]\b)+)")
    if run_re.search(base):
        add(run_re.sub(lambda m: ".".join(m.group(1).split()) + ".", base))
        add(run_re.sub(lambda m: "".join(m.group(1).split()), base))

    # Digit glued onto a dotted acronym: 'R.I.P.D.2. Rise' -> 'R.I.P.D. 2 Rise'
    unglued = re.sub(r"((?:[A-Za-z]\.){2,})\s*(\d)", r"\1 \2", base)
    unglued = re.sub(r"(\d)\.(?=\s|$)", r"\1", unglued)
    add(unglued)

    # Dotted acronym -> plain word: 'S.W.A.T. Under Siege' -> 'SWAT Under Siege'
    add(re.sub(r"\b((?:[A-Za-z]\.){2,})", lambda m: m.group(1).replace(".", ""), unglued))

    return results


def get_separator_variations(title: str) -> list[str]:
    """Vary full-title separators without removing words or word hyphens.

    Release folders often use 'Franchise - Subtitle' where metadata uses a
    colon. Only standalone, spaced dashes qualify: 'Spider-Man' stays intact.
    Every part is retained, including sequel numbers and multiple subtitles.
    """
    parts = re.split(r"\s+[-\u2013\u2014]\s+|:\s*", title)
    if len(parts) == 1 or any(not part.strip() for part in parts):
        return []
    parts = [part.strip() for part in parts]
    variations = []
    for separator in (": ", " ", " - "):
        variant = separator.join(parts)
        if variant != title and variant not in variations:
            variations.append(variant)
    return variations


def get_possessive_variations(title: str, limit: int = 6) -> list[str]:
    """Insert an apostrophe in one eligible word; preserve every other word.

    Trying all plural-looking words together turns 'Pirates ... Worlds End'
    into "Pirate's ... World's End". Single-word candidates allow the correct
    possessive without changing the franchise. The fixed bound avoids expanding
    a long release title into an unbounded set of metadata requests.
    """
    variations = []
    for match in re.finditer(r"\b([A-Za-z]+[^s\W])s\b", title, re.IGNORECASE):
        if len(variations) >= limit:
            break
        suffix = title[match.end() - 1]
        variant = title[:match.start()] + match.group(1) + "'" + suffix + title[match.end():]
        variations.append(variant)
    return variations


def is_tv_show(parsed: dict) -> bool:
    """Check if parsed filename indicates a TV show (has season/episode info)."""
    return parsed.get("season") is not None or parsed.get("episode") is not None


def parse_tv_info(filename: str) -> dict | None:
    """Parse TV show info from filename. Returns None if not a TV show."""
    parsed = parse(filename)
    if not is_tv_show(parsed):
        return None

    episode = parsed.get("episode")

    return {
        "title": parsed.get("title"),
        "season": parsed.get("season"),
        "year": str(parsed["year"]) if parsed.get("year") else None,
        "episode": episode,
        "episode_title": parsed.get("episodeName"),
    }


def clean_episode_title(episode_title: str) -> str:
    """An OMDb episode title made safe to use in a file name."""
    text = html.unescape(episode_title)      # OMDb sends HTML entities (&gt; -> >)
    text = text.replace("/", "-")            # not allowed in file names
    text = re.sub(r'[<>:"/\\|?*]', "", text)
    return re.sub(r"\s+", " ", text).strip()


def create_tv_filename(
    series_title: str,
    season: int,
    episode: int | None,
    episode_title: str | None,
    extension: str,
    lang_suffix: str = "",
) -> str | None:
    """Create a TV show filename: 'Show Name - S01E02 - Episode Title.ext'

    Returns None if episode is None (can't create valid filename).
    """
    if episode is None:
        return None

    clean_title = re.sub(r'[<>:"/\\|?*]', "", series_title)
    episodes = episode if isinstance(episode, list) else [episode]
    ep_code = f"S{season:02d}" + "".join(f"E{ep:02d}" for ep in episodes)

    if episode_title:
        base = f"{clean_title} - {ep_code} - {clean_episode_title(episode_title)}"
    else:
        base = f"{clean_title} - {ep_code}"

    if lang_suffix:
        return f"{base}{lang_suffix}{extension}"
    return f"{base}{extension}"


def create_clean_filename(title: str, year: str, extension: str, lang_suffix: str = "") -> str:
    """Create a clean filename from title and year."""
    clean = re.sub(r'[<>:"/\\|?*]', "", title)
    if lang_suffix:
        return f"{clean} ({year}){lang_suffix}{extension}"
    return f"{clean} ({year}){extension}"


def get_file_parts(filepath: Path) -> tuple[str, str]:
    """Get stem and suffix from a file, handling edge cases like '.srt'.

    Returns (stem, suffix) where suffix includes the leading dot.
    For files like '.srt', returns ('', '.srt').
    """
    name = filepath.name
    suffix = filepath.suffix

    # Handle files like ".srt" where pathlib treats it as hidden with no extension
    if not suffix and name.startswith("."):
        return "", name.lower()

    return filepath.stem, suffix.lower()


def extract_language_suffix(filename: str) -> str:
    """Extract language suffix from subtitle filename if present.

    Expects the filename stem (without extension), e.g., "Forced.eng" not "Forced.eng.srt".
    """
    # Known ISO 639-1 and 639-2 codes
    iso_codes = {
        "en", "eng", "es", "spa", "fr", "fre", "fra", "de", "ger", "deu",
        "it", "ita", "pt", "por", "ru", "rus", "zh", "chi", "zho",
        "ja", "jpn", "ko", "kor", "ar", "ara", "hi", "hin", "nl", "dut",
        "nld", "sv", "swe", "no", "nor", "nob", "nb", "nn", "nno",  # Norwegian variants
        "da", "dan", "fi", "fin", "pl", "pol", "tr", "tur", "cs", "cze", "ces",
        "el", "gre", "ell", "he", "heb", "th", "tha", "vi", "vie",
        "id", "ind", "ms", "msa", "ro", "rum", "ron", "hu", "hun",
        "uk", "ukr", "bg", "bul", "hr", "hrv", "sk", "slo", "slk",
        "sl", "slv", "et", "est", "lv", "lav", "lt", "lit",
        "cat", "baq", "fil", "glg", "may", "tam", "tel", "urd",
        "ben", "mar", "guj", "kan", "mal", "pan", "yue",  # Cantonese
    }
    # Full language names and special tags
    full_names = {
        "english", "spanish", "french", "german", "italian", "portuguese",
        "russian", "chinese", "japanese", "korean", "arabic", "hindi",
        "dutch", "swedish", "norwegian", "danish", "finnish", "polish",
        "turkish", "czech", "greek", "hebrew", "thai", "vietnamese",
        "indonesian", "malay", "romanian", "hungarian", "ukrainian",
        "bulgarian", "croatian", "slovak", "slovenian", "brazilian",
        "estonian", "latvian", "lithuanian", "filipino", "catalan",
        "simplified", "traditional", "latin", "european", "canadian",  # Region modifiers
        "forced", "sdh", "hi", "cc",  # Special tags (hi = hearing impaired)
    }

    # Use filename directly - it's already the stem
    stem = filename.strip()
    if not stem:
        return ""

    stem_lower = stem.lower()

    # Check if entire stem is a language code (e.g., "ara" from "ara.srt")
    if stem_lower in iso_codes or stem_lower in full_names:
        return f".{stem_lower}"

    # Split by dots, underscores, and spaces
    parts = re.split(r"[._ ]+", stem_lower)

    # Filter out empty parts
    parts = [p for p in parts if p]
    if not parts:
        return ""

    # Take only the last 1-4 parts that might be language-related
    suffix_parts = []
    for part in reversed(parts[-4:]):
        if part in iso_codes or part in full_names:
            suffix_parts.insert(0, part)
        elif suffix_parts:
            # Stop when we hit a non-language part after finding some
            break

    if suffix_parts:
        return "." + ".".join(suffix_parts)

    return ""
