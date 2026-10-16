#!/usr/bin/env python3
"""Movie Renamer - Automatically rename and organize movie files."""

import argparse
import errno
import html
import json
import os
import re
import shutil
import time
import logging
import logging.handlers
import pathlib
from difflib import SequenceMatcher
from pathlib import Path

import requests
from PTN import parse

import config
import extras
import omdb_support
import organizer_status
import safe_copy
from movie_import_guard import check_movie
from omdb_support import OMDbUnavailableError
from organizer_readiness import ready_for_import, existing_series
_download_observations = {}
_DOWNLOAD_SNAPSHOT = Path(__file__).resolve().parent.parent / "data" / "download-readiness.json"

# Logging is configured by setup_logging(), which main() calls -- never at import.
# It used to attach rotating file handlers to the production log (and a copy on the
# Desktop) the moment this module was imported, so every unit-test run wrote fake
# imports, fake review items and "Moved -> /tmp/..." lines into the files the
# Organizer page reads and that the library-rescan trigger watches.
_LOG_FORMAT = logging.Formatter("[%(asctime)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
_OWN_HANDLER = "_organizer_handler"
log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())  # stays silent when imported without setup_logging()


def setup_logging(log_dir=None, preview=None, desktop_copy=None) -> list:
    """Attach console + rotating-file handlers to the root logger. Safe to call twice.

    preview (ORGANIZER_PREVIEW=1): console only; never writes a log file.
    desktop_copy (ORGANIZER_DESKTOP_LOG=1): also mirror the log to ~/Desktop. Off by
    default: it doubled every write and left two 5 MB files on the Desktop.
    """
    if preview is None:
        preview = os.environ.get("ORGANIZER_PREVIEW") == "1"
    if desktop_copy is None:
        desktop_copy = os.environ.get("ORGANIZER_DESKTOP_LOG") == "1"
    directory = pathlib.Path(log_dir) if log_dir else pathlib.Path(__file__).parent
    root = logging.getLogger()
    for existing in list(root.handlers):
        if getattr(existing, _OWN_HANDLER, False):
            root.removeHandler(existing)
            existing.close()
    handlers = [logging.StreamHandler()]
    if not preview:
        paths = [directory / "media-organizer.log"]
        if desktop_copy:
            paths.append(pathlib.Path.home() / "Desktop" / "media-organizer.log")
        for path in paths:
            try:
                handlers.append(logging.handlers.RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=2))
            except OSError as error:  # keep running on the console/journal if a log path is unwritable
                print(f"[organizer] cannot write {path}: {error}", flush=True)
    for handler in handlers:
        handler.addFilter(omdb_support.RedactingFilter())   # the API key never reaches a log
        handler.setFormatter(_LOG_FORMAT)
        setattr(handler, _OWN_HANDLER, True)
        root.addHandler(handler)
    root.setLevel(logging.INFO)
    return handlers

# Track consecutive OMDb 401 errors to detect rate limiting
_omdb_consecutive_401s = 0
_OMDB_RATE_LIMIT_THRESHOLD = 5  # Abort after this many consecutive 401s

# Cache OMDb "no match" results to avoid re-querying the same files in watch mode
# Key: (title, year), Value: timestamp of when the lookup failed
_omdb_no_match_cache: dict[tuple[str, str | None], float] = {}
_OMDB_CACHE_TTL = 86400  # Cache "no match" results for 24 hours
_OMDB_SERIES_SEARCH_MAX_PAGES = 5  # Ten search results per page; never search unbounded.

# Track files already logged as skipped in watch mode to avoid log spam
# Key: parse_name, Value: reason string
_watch_skip_logged: set[str] = set()

# Folders logged as still-downloading (part-files present), to log the wait
# once instead of every poll. Never used to skip processing.
_transferring_logged: set[str] = set()


class OMDbRateLimitError(Exception):
    """Raised when OMDb API rate limit is detected."""
    pass


def _check_omdb_rate_limit(response: requests.Response) -> None:
    """Track consecutive 401 errors and raise if rate limited."""
    global _omdb_consecutive_401s
    if response.status_code == 401:
        _omdb_consecutive_401s += 1
        if _omdb_consecutive_401s >= _OMDB_RATE_LIMIT_THRESHOLD:
            raise OMDbRateLimitError(
                f"OMDb API rate limit reached ({_omdb_consecutive_401s} consecutive 401 errors). "
                f"The free tier allows 1,000 requests/day. Try again tomorrow."
            )
    else:
        _omdb_consecutive_401s = 0


# Shared OMDb state. The episode-title cache and the usage counter are memory-only until a
# real run calls start_omdb_state(), so tests and previews touch no shared files.
_omdb_backoff = omdb_support.Backoff()
_season_cache = omdb_support.SeasonCache()
_omdb_usage = omdb_support.UsageCounter()
_omdb_wait_logged: set[str] = set()   # releases already reported as waiting for OMDb
_omdb_trouble = {"since": None, "reason": None}   # while OMDb is failing: when it began and why


def start_omdb_state() -> None:
    """Persist the episode-title cache and the daily request count (real runs only)."""
    global _season_cache, _omdb_usage
    _season_cache = omdb_support.SeasonCache(config.OMDB_SEASON_CACHE)
    _omdb_usage = omdb_support.UsageCounter(config.OMDB_USAGE_FILE)


def reset_omdb_state() -> None:
    """Forget every in-memory OMDb result and failure (used by tests)."""
    global _omdb_backoff, _season_cache, _omdb_usage, _omdb_consecutive_401s
    _omdb_backoff = omdb_support.Backoff()
    _season_cache = omdb_support.SeasonCache()
    _omdb_usage = omdb_support.UsageCounter()
    _omdb_consecutive_401s = 0
    _omdb_wait_logged.clear()
    _omdb_no_match_cache.clear()
    _omdb_trouble.update(since=None, reason=None)


def _note_omdb_failure(reason: str = "") -> None:
    first = _omdb_backoff.failures == 0
    _omdb_backoff.failed()
    if first:
        _omdb_trouble.update(since=int(time.time() * 1000), reason=reason or None)
    elif reason:
        _omdb_trouble["reason"] = reason
    if first:
        log.warning("OMDb is not responding; releases that need it will wait and be retried "
                    "(next attempt in %ds)", int(_omdb_backoff.remaining()))


def _omdb_get(params: dict) -> dict:
    """One OMDb request; returns the parsed reply (an unknown title is {"Response": "False"}).

    Raises OMDbRateLimitError after repeated 401s, and OMDbUnavailableError when OMDb could
    not be asked at all (timeout, connection failure, server error, unreadable or refused
    reply). That is not an answer about the title: callers must wait and retry, never record
    a "no match". While OMDb is failing, requests are held back and fail fast, so an outage
    costs one probe every few minutes instead of a 10 s timeout per spelling of every title.
    """
    if _omdb_backoff.blocked():
        raise OMDbUnavailableError(f"holding off for {int(_omdb_backoff.remaining())}s after a failure")
    _omdb_usage.hit()
    try:
        response = requests.get(config.OMDB_BASE_URL, params=params, timeout=10)
    except requests.RequestException as error:
        reason = omdb_support.describe_request_error(error)
        _note_omdb_failure(reason)
        raise OMDbUnavailableError(reason) from None
    try:
        _check_omdb_rate_limit(response)
    except OMDbRateLimitError:
        _omdb_backoff.hold(30 * 60)   # the day's allowance is gone; re-asking every poll only wastes it
        raise
    try:
        response.raise_for_status()
        data = response.json()
    except (requests.RequestException, ValueError) as error:
        reason = omdb_support.describe_request_error(error)
        _note_omdb_failure(reason)
        raise OMDbUnavailableError(reason) from None
    if not isinstance(data, dict):
        return {}   # readable but not an answer we understand: no verdict is accepted (fails closed)
    if data.get("Response") == "False" and re.search(r"api key|limit", str(data.get("Error", "")), re.I):
        reason = f"OMDb said: {omdb_support.redact(data.get('Error'))[:80]}"
        _note_omdb_failure(reason)
        raise OMDbUnavailableError(reason)
    if _omdb_backoff.failures:
        log.info("OMDb is responding again")
        _omdb_wait_logged.clear()
        _omdb_trouble.update(since=None, reason=None)
    _omdb_backoff.succeeded()
    return data


def omdb_snapshot() -> dict:
    """What the Organizer page shows about OMDb: is it failing, why, and how much of the day is used."""
    return {"omdb": {"failing": _omdb_backoff.failures > 0, "since": _omdb_trouble["since"],
                     "reason": _omdb_trouble["reason"], "retryInSeconds": int(_omdb_backoff.remaining()),
                     "waiting": len(_omdb_wait_logged), "requestsToday": _omdb_usage.today()}}


def _wait_for_omdb(parse_name: str, error: Exception) -> None:
    """A release that could not be looked up because OMDb was unreachable. It is left for
    the next scan: no skip is recorded and no "no match" is remembered."""
    if parse_name not in _omdb_wait_logged:
        _omdb_wait_logged.add(parse_name)
        log.warning("WAIT: OMDb unavailable (%s); leaving %s for the next scan", error, parse_name)


def find_existing_movie_drive(movie_folder_name: str) -> Path | None:
    """Check all movie drives for an existing folder with this name."""
    for drive_dir in config.MOVIE_DEST_DIRS:
        candidate = Path(drive_dir) / movie_folder_name
        if candidate.exists():
            return Path(drive_dir)
    return None


def movie_folder_identity(name: str) -> str:
    """Compare the complete folder title and year; only punctuation varies."""
    return re.sub(r"[\W_]+", " ", name.casefold()).strip()


def _folder_has_movie_video(folder: Path) -> bool:
    """Require a nonempty regular video; unreadable folders raise for review."""
    pending = [folder]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif (entry.is_file(follow_symlinks=False)
                      and Path(entry.name).suffix.lower() in config.VIDEO_EXTENSIONS
                      and entry.stat(follow_symlinks=False).st_size > 0):
                    return True
    return False


def find_existing_equivalent_movie(movie_folder_name: str) -> Path | None:
    """Find existing media by the full folder name/year across configured roots.

    Only immediate movie folders are compared. No fuzzy title matching, article
    removal, word removal, or year tolerance is used for duplicate detection.
    """
    wanted = movie_folder_identity(movie_folder_name)
    for drive_dir in dict.fromkeys([config.MOVIE_DEST_DIR, *config.MOVIE_DEST_DIRS]):
        with os.scandir(drive_dir) as entries:
            for entry in entries:
                if movie_folder_identity(entry.name) != wanted:
                    continue
                if entry.is_symlink():
                    raise OSError(f"Existing movie location is a shortcut: {entry.path}")
                if entry.is_dir(follow_symlinks=False) and _folder_has_movie_video(Path(entry.path)):
                    return Path(entry.path)
    return None


def find_existing_show_drive(series_folder_name: str) -> Path | None:
    """Check all TV drives for an existing folder with this name."""
    for drive_dir in config.TV_DEST_DIRS:
        candidate = Path(drive_dir) / series_folder_name
        if candidate.exists():
            return Path(drive_dir)
    return None


def get_movie_dest(movie_folder_name: str) -> Path:
    """Get the destination drive for a movie, preferring drives that already have it."""
    existing = find_existing_movie_drive(movie_folder_name)
    if existing:
        return existing
    return Path(config.MOVIE_DEST_DIR)


def get_tv_dest(series_folder_name: str) -> Path:
    """Get the destination drive for a TV show, preferring drives that already have it."""
    existing = find_existing_show_drive(series_folder_name)
    if existing:
        return existing
    return Path(config.TV_DEST_DIR)


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


def infer_missing_movie_year(movie: dict, title: str, year: str | None) -> str | None:
    """Use the sole video filename's year only when its complete title agrees.

    Folder names remain the source identity. A supplied folder year always
    wins; multiple videos, missing years, or different title words never infer
    a year. Punctuation, whitespace, and case are the only title differences
    allowed here, without aliases or fuzzy matching.
    """
    if year is not None or movie.get("type") != "folder":
        return year
    videos = movie.get("video_files", [])
    if len(videos) != 1:
        return year
    video_title, video_year = parse_filename(Path(videos[0]).stem)
    if (video_title and video_year and movie_folder_identity(title)
            and movie_folder_identity(title) == movie_folder_identity(video_title)):
        return video_year
    return year


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


def get_alias_variations(title: str, media_type: str) -> list[str]:
    """Read local alias rules written by TV-Clone and return matching OMDb titles."""
    alias_file = Path(os.environ.get("ORGANIZER_ALIAS_FILE") or Path(__file__).with_name("organizer_aliases.json"))
    try:
        raw = json.loads(alias_file.read_text())
    except (OSError, json.JSONDecodeError):
        return []

    aliases = raw if isinstance(raw, list) else raw.get("aliases", [])
    results = []
    normalized_title = title.lower().strip()
    for alias in aliases:
        if not isinstance(alias, dict):
            continue
        alias_type = alias.get("type", "all")
        if alias_type not in ("all", media_type):
            continue
        if str(alias.get("from", "")).lower().strip() != normalized_title:
            continue
        target = str(alias.get("to", "")).strip()
        if target and target not in results:
            results.append(target)
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


def get_title_variations(title: str) -> list[str]:
    """Generate variations of a title to try searching.

    Variations are ordered from most specific to least specific.
    Aggressive strategies (word removal) are excluded to prevent false matches.
    """
    title = clean_title(title)
    variations = [title]

    for alias in get_alias_variations(title, "movie"):
        if alias not in variations:
            variations.append(alias)

    # Keep complete separator forms ahead of broader legacy fallback queries.
    for variant in get_separator_variations(title):
        if variant not in variations:
            variations.append(variant)

    # Only complete original/separator forms receive these candidates. Do not
    # apply apostrophe guessing to truncated legacy fallbacks or to all words
    # at once. At most twelve additional queries are generated for a title.
    full_title_count = len(variations)
    possessive_variations = []
    for variant in [title, *get_separator_variations(title)]:
        for fixed in get_possessive_variations(variant):
            if fixed not in variations and fixed not in possessive_variations and len(possessive_variations) < 12:
                possessive_variations.append(fixed)

    # Acronym forms: 'R I P D 2 ...' -> 'R.I.P.D. 2 ...' / 'RIPD 2 ...'
    for acro in get_acronym_variations(title):
        if acro not in variations:
            variations.append(acro)

    # Try title before colon (e.g., "Wake Up Dead Man: A Knives Out Mystery" -> "Wake Up Dead Man")
    if ":" in title:
        before_colon = title.split(":")[0].strip()
        if before_colon and before_colon not in variations:
            variations.append(before_colon)

    # Try removing common subtitle patterns
    patterns = [
        r"\s+A\s+\w+\s+(Out\s+)?(Mystery|Story|Tale|Film|Movie).*$",
        r"\s*[-:]\s*A\s+\w+\s+(Mystery|Story|Tale|Film|Movie).*$",
        r"\s*[-:]\s*The\s+\w+.*$",
        r"\s*[-:]\s*(Horror|Action|Comedy|Drama|Thriller|Romance|Sci-Fi|SciFi|Adventure|Fantasy|Animation|Documentary|Crime|Western|Musical|War|History|Sport|Family|Biography)$",
    ]
    for pattern in patterns:
        cleaned = re.sub(pattern, "", title, flags=re.IGNORECASE).strip()
        if cleaned and cleaned != title and cleaned not in variations:
            variations.append(cleaned)

    # Try removing informal sequel numbers: "Title 2 - Subtitle" -> "Title Subtitle"
    # (e.g., "Transformers 2 - Revenge of The Fallen" -> "Transformers Revenge of The Fallen")
    no_seq = re.sub(r"\s+\d+\s*[-:]\s*", " ", title).strip()
    if no_seq and no_seq != title and no_seq not in variations:
        variations.append(no_seq)

    # Common contractions: "Dont" -> "Don't", "Cant" -> "Can't", etc.
    contraction_map = {
        r"\bDont\b": "Don't", r"\bWont\b": "Won't", r"\bCant\b": "Can't",
        r"\bIsnt\b": "Isn't", r"\bDidnt\b": "Didn't", r"\bDoesnt\b": "Doesn't",
        r"\bHasnt\b": "Hasn't", r"\bHavent\b": "Haven't", r"\bWasnt\b": "Wasn't",
        r"\bWerent\b": "Weren't", r"\bArent\b": "Aren't", r"\bCouldnt\b": "Couldn't",
        r"\bShouldnt\b": "Shouldn't", r"\bWouldnt\b": "Wouldn't",
        r"\bWhats\b": "What's", r"\bThats\b": "That's", r"\bIts\b": "It's",
        r"\bWhos\b": "Who's", r"\bHeres\b": "Here's", r"\bTheres\b": "There's",
    }
    for base_var in variations.copy():
        for pattern, replacement in contraction_map.items():
            fixed = re.sub(pattern, replacement, base_var, flags=re.IGNORECASE)
            if fixed != base_var and fixed not in variations:
                variations.append(fixed)

    # Arabic <-> Roman numeral variations (Part 2 <-> Part II, etc.)
    arabic_to_roman = {"2": "II", "3": "III", "4": "IV", "5": "V", "6": "VI", "7": "VII", "8": "VIII"}
    roman_to_arabic = {v: k for k, v in arabic_to_roman.items()}
    for var in variations.copy():
        for arabic, roman in arabic_to_roman.items():
            # "Part 2" -> "Part II"
            swapped = re.sub(rf"\b{arabic}\b", roman, var)
            if swapped != var and swapped not in variations:
                variations.append(swapped)
        for roman, arabic in roman_to_arabic.items():
            # "Part II" -> "Part 2"
            swapped = re.sub(rf"\b{roman}\b", arabic, var)
            if swapped != var and swapped not in variations:
                variations.append(swapped)

    # Add "and" <-> "&" variations
    for var in variations.copy():
        if " and " in var.lower():
            swapped = re.sub(r"\band\b", "&", var, flags=re.IGNORECASE)
            if swapped not in variations:
                variations.append(swapped)
        if " & " in var:
            swapped = var.replace(" & ", " and ")
            if swapped not in variations:
                variations.append(swapped)

    # Superhero compound-word variations: "Spiderman" -> "Spider-Man", etc.
    # PTN strips hyphens from filenames so "Spider-Man" becomes "Spiderman".
    superhero_map = {
        r"\bSpiderman\b": "Spider-Man",
        r"\bSpider Man\b": "Spider-Man",
        r"\bIronman\b": "Iron Man",
        r"\bBatman\b": "Batman",  # Batman is already one word, keep as-is
        r"\bSuperman\b": "Superman",  # same
        r"\bAntman\b": "Ant-Man",
        r"\bAnt Man\b": "Ant-Man",
    }
    for var in variations.copy():
        for pattern, replacement in superhero_map.items():
            fixed = re.sub(pattern, replacement, var, flags=re.IGNORECASE)
            if fixed != var and fixed not in variations:
                variations.append(fixed)

    # Strip trailing " 1" — filenames often tag the first movie as "Title 1" but
    # OMDb titles it without a number (e.g. "Spider-Man 1" -> "Spider-Man").
    # Only strip " 1" at end, not mid-title, and only as a last-resort variation.
    for var in variations.copy():
        no_one = re.sub(r"\s+1$", "", var).strip()
        if no_one and no_one != var and no_one not in variations:
            variations.append(no_one)

    # NOTE: Progressive word removal has been removed intentionally.
    # It caused false matches (e.g., "The Lord of the Rings" -> "The Lord").

    # Insert the bounded complete-title candidates before broader fallbacks,
    # without feeding them through every legacy expansion rule above.
    possessive_variations = [variant for variant in possessive_variations if variant not in variations]
    return variations[:full_title_count] + possessive_variations + variations[full_title_count:]


def is_good_match(parsed_title: str, parsed_year: str | None, omdb_info: dict) -> bool:
    """Check if the OMDb result is a confident match for what we parsed.

    Uses title similarity and year proximity to filter out bad matches
    like TV specials, talk show appearances, or wrong movies entirely.
    """
    omdb_title = omdb_info.get("title", "")
    omdb_year = omdb_info.get("year", "")
    omdb_type = omdb_info.get("type", "movie")

    # Reject non-movie types (episodes, series, etc.)
    if omdb_type and omdb_type.lower() != "movie":
        log.info(f"  Rejected: type is '{omdb_type}', not 'movie'")
        return False

    if re.findall(r"\b\d+\b", parsed_title) != re.findall(r"\b\d+\b", omdb_title):
        return False

    # Title similarity check — punctuation-insensitive, so 'R I P D 2 Rise of
    # the Damned' scores 1.0 against 'R.I.P.D. 2: Rise of the Damned'.
    title_similarity = title_match_ratio(parsed_title, omdb_title)

    # Year proximity check (allow ±1 for regional release date differences)
    year_ok = True
    if parsed_year and omdb_year:
        try:
            # OMDb year can be a range like "2023-2024", take the first year
            omdb_year_int = int(omdb_year[:4])
            parsed_year_int = int(parsed_year[:4])
            year_ok = abs(parsed_year_int - omdb_year_int) <= 1
        except ValueError:
            year_ok = False

    # Strict: if title is very different, reject
    if title_similarity < 0.85:
        log.info(
            f"  Rejected: title similarity too low ({title_similarity:.2f}) "
            f"'{parsed_title}' vs '{omdb_title}'"
        )
        return False

    # A result that is just a truncated prefix of what we parsed (e.g.
    # 'The Lord' for 'The Lord of the Rings') is usually the wrong record.
    # Better to skip into the fix queue than silently mis-name the file.
    norm_parsed, norm_omdb = normalize_for_match(parsed_title), normalize_for_match(omdb_title)
    if (title_similarity < 0.7 and norm_omdb and norm_parsed.startswith(norm_omdb)
            and len(norm_parsed.split()) - len(norm_omdb.split()) >= 2):
        log.info(f"  Rejected: '{omdb_title}' looks like a truncated match for '{parsed_title}'")
        return False

    # If year doesn't match, check how far off it is
    if not year_ok and parsed_year and omdb_year:
        try:
            year_gap = abs(int(parsed_year[:4]) - int(omdb_year[:4]))
        except ValueError:
            year_gap = 999

        # Large year gap (>5 years): reject even with perfect title match
        # This prevents matching a 2025 movie to a 1984 movie with the same name
        if year_gap > 1:
            log.info(
                f"  Rejected: year gap too large ({parsed_year} vs {omdb_year}, "
                f"{year_gap} years apart) - likely a different movie"
            )
            return False

        # Small year gap (2-5 years): require very high title similarity
        if title_similarity < 0.85:
            log.info(
                f"  Rejected: year mismatch ({parsed_year} vs {omdb_year}) "
                f"and title similarity only {title_similarity:.2f}"
            )
            return False
        else:
            log.warning(
                f"  Warning: year mismatch ({parsed_year} vs {omdb_year}) "
                f"but title similarity high ({title_similarity:.2f}), accepting"
            )

    # Check for suspiciously long titles that might indicate a TV special
    # e.g., "Movie Name: Late Night with Host featuring Guest Stars"
    # Only apply if the OMDb title differs significantly from what we searched for
    # (skip if titles match closely - e.g., "The Interview" is a real movie)
    if title_similarity < 0.85:
        suspicious_patterns = [
            r"guest\s*star",
            r"late\s*(night|show)",
            r"talk\s*show",
            r"interview",
            r"behind\s*the\s*scenes",
            r"making\s*of",
            r"special\s*appearance",
            r"featuring",
            r"hosted\s*by",
            r"with\s+(jimmy|stephen|seth|jimmy|james|conan|trevor|john)",
        ]
        for pattern in suspicious_patterns:
            if re.search(pattern, omdb_title, re.IGNORECASE):
                log.info(f"  Rejected: suspicious title pattern in '{omdb_title}' (likely TV special)")
                return False

    log.info(f"  Match accepted: similarity={title_similarity:.2f}, year_ok={year_ok}")
    return True


def query_omdb_exact(title: str, year: str | None = None, type_filter: str | None = "movie") -> dict | None:
    """Query OMDb API with exact title match (t= parameter).

    type_filter defaults to "movie" for every normal caller. Pass None to omit
    the &type param entirely and see whatever OMDb actually has under this
    exact title, regardless of type — used by check_if_actually_series, which
    needs to tell "OMDb has never heard of this" apart from "OMDb has it, just
    filed as a series". Passing type='movie' here would silently defeat that
    check by re-applying the exact filter being diagnosed around (this was a
    real bug: the first version of that diagnostic used query_omdb_search,
    which also hardcodes type=movie internally, so it always re-found the
    same wrong movie-typed record it was trying to see past).

    Raises OMDbRateLimitError if too many consecutive 401 errors are detected.
    """
    params = {
        "apikey": config.OMDB_API_KEY,
        "t": title,
    }
    if type_filter:
        params["type"] = type_filter
    if year:
        params["y"] = year

    data = _omdb_get(params)
    if data.get("Response") == "True":
        return {
            "title": data.get("Title"),
            "year": data.get("Year"),
            "type": data.get("Type"),
            "imdbID": data.get("imdbID"),
            "runtime": data.get("Runtime"),
        }
    return None


def query_omdb_search(title: str, year: str | None = None) -> dict | None:
    """Query OMDb API with search (s= parameter) and return best match.

    Raises OMDbRateLimitError if too many consecutive 401 errors are detected.
    """
    params = {
        "apikey": config.OMDB_API_KEY,
        "s": title,
        "type": "movie",
    }
    if year:
        params["y"] = year

    data = _omdb_get(params)
    if data.get("Response") == "True" and data.get("Search"):
        if int(data.get("totalResults", len(data["Search"]))) > len(data["Search"]):
            return None
        candidates = [{"title": row.get("Title"), "year": row.get("Year"),
                       "type": row.get("Type"), "imdbID": row.get("imdbID")}
                      for row in data["Search"]]
        candidates = [row for row in candidates if is_good_match(title, year, row)]
        candidates.sort(key=lambda row: title_match_ratio(title, row["title"]), reverse=True)
        if len(candidates) > 1 and (title_match_ratio(title, candidates[0]["title"]) -
                                   title_match_ratio(title, candidates[1]["title"])) < 0.08:
            return None
        return candidates[0] if candidates else None
    return None


def query_omdb(title: str, year: str | None = None) -> dict | None:
    """Query OMDb API, trying multiple strategies to find a match.

    Strategies are ordered from most reliable to least reliable.
    Each match is validated with is_good_match() before being accepted.
    Results are cached to avoid re-querying the same titles in watch mode.
    """
    cache_key = (title.lower().strip(), year)
    cached_time = _omdb_no_match_cache.get(cache_key)
    if cached_time and (time.time() - cached_time) < _OMDB_CACHE_TTL:
        log.debug(f"  No OMDb match for movie (cached): {title} ({year})")
        return None

    variations = get_title_variations(title)
    if not year:
        # Search all returned candidates; ties stay in the review queue.
        return query_omdb_search(title)

    # Strategy 1: Exact match with year for all variations (most reliable)
    for variant in variations:
        result = query_omdb_exact(variant, year)
        if result and is_good_match(title, year, result):
            log.info(f"  Strategy: exact + year, query: '{variant}'")
            return result
        # Small delay to avoid hammering the API
        time.sleep(0.15)

    # Strategy 2: Exact match WITHOUT year (year from filename might be wrong)
    if year:
        for variant in variations[:3]:  # Limit to top 3 variations
            result = query_omdb_exact(variant, None)
            if result and is_good_match(title, year, result):
                log.info(f"  Strategy: exact (no year), query: '{variant}'")
                return result
            time.sleep(0.15)

    # Strategy 3: Search endpoint with year (less reliable, limited attempts)
    for variant in variations[:2]:  # Only try first 2 variations
        result = query_omdb_search(variant, year)
        if result and is_good_match(title, year, result):
            log.info(f"  Strategy: search + year, query: '{variant}'")
            return result
        time.sleep(0.15)

    # Strategy 4: Search endpoint WITHOUT year (least reliable, very limited)
    if year:
        result = query_omdb_search(variations[0], None)  # Only try original title
        if result and is_good_match(title, year, result):
            log.info(f"  Strategy: search (no year), query: '{variations[0]}'")
            return result

    _omdb_no_match_cache[cache_key] = time.time()
    return None


def check_if_actually_series(title: str, year: str | None) -> dict | None:
    """After a movie match fails, check whether OMDb has this title as a
    series instead of a movie, and misreport that as "no match" purely because
    of our own type=movie filter.

    Real case caught in the wild: "Band of Brothers" (2001) is OMDb type
    'series'. query_omdb's exact-match call sends &type=movie, which OMDb
    honours by excluding the real series entry and returning the closest
    movie-typed record instead — "The Making of 'Band of Brothers'", an
    unrelated 30-minute documentary. That gets correctly rejected by
    is_good_match, and the resulting log line ("No confident OMDb match")
    reads exactly like a title OMDb has never heard of, when in fact OMDb
    knows it perfectly well — it's just not a movie.

    This does NOT attempt to place the file. A whole miniseries downloaded as
    one video file with no season/episode markers does not fit the per-episode
    structure the TV pipeline expects; auto-placing it would be a guess, not a
    fix. This only makes the fix-queue message honest, so it doesn't ever
    look like an OMDb-data-lag case (see the 2026-08 "The Last House" incident,
    where the two really do look identical from a bare 'No match' log line).

    One cheap query only, and only ever called after the real match attempt
    already failed — this does not add a request to the normal successful path.
    """
    # type_filter=None is load-bearing here: query_omdb_search always sends
    # &type=movie internally, so it cannot be used for this check — it would
    # just re-find the same wrong movie-typed record being diagnosed around.
    result = query_omdb_exact(title, year, type_filter=None)
    if not result:
        result = query_omdb_exact(title, None, type_filter=None)  # year might be wrong/absent
    if not result:
        return None
    if (result.get("type") or "").lower() == "movie":
        return None  # genuinely not a movie match; nothing new to report
    if title_match_ratio(title, result.get("title", "")) < 0.7:
        return None  # not confident enough that this is even the same title
    return result


def get_all_files(directory: Path, extensions: list[str]) -> list[Path]:
    """Recursively find all files with given extensions in a directory."""
    files = []
    for f in directory.rglob("*"):
        if f.is_file() and f.suffix.lower() in extensions:
            files.append(f)
    return files


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


def get_series_title_variations(title: str) -> list[str]:
    """Generate variations of a TV series title for OMDb lookup.

    Handles common patterns like country suffixes (US, UK), missing apostrophes,
    and other naming quirks in folder names.
    """
    title = clean_title(title).strip()
    variations = [title]

    for alias in get_alias_variations(title, "series"):
        if alias not in variations:
            variations.append(alias)

    # Strip country suffixes: "Hells Kitchen US" -> "Hells Kitchen", "Top Gear UK" -> "Top Gear"
    country_stripped = re.sub(r"\s+(US|UK|AU|CA|NZ)$", "", title, flags=re.IGNORECASE).strip()
    if country_stripped and country_stripped != title and country_stripped not in variations:
        variations.append(country_stripped)

    # Acronym forms: 'S W A T' -> 'S.W.A.T.' / 'SWAT'
    for base_var in variations.copy():
        for acro in get_acronym_variations(base_var):
            if acro not in variations:
                variations.append(acro)

    # OMDb often keeps a colon after acronym prefixes: "SAS Rogue Heroes" -> "SAS: Rogue Heroes".
    for base_var in variations.copy():
        acronym_colon = re.sub(r"^([A-Z]{2,6})\s+(.+)$", r"\1: \2", base_var).strip()
        if acronym_colon and acronym_colon != base_var and acronym_colon not in variations:
            variations.append(acronym_colon)

    # Add common contraction variants: "Dont" -> "Don't", "Whats" -> "What's"
    contraction_map = {
        r"\bDont\b": "Don't",
        r"\bWont\b": "Won't",
        r"\bCant\b": "Can't",
        r"\bIsnt\b": "Isn't",
        r"\bDidnt\b": "Didn't",
        r"\bDoesnt\b": "Doesn't",
        r"\bHasnt\b": "Hasn't",
        r"\bHavent\b": "Haven't",
        r"\bWasnt\b": "Wasn't",
        r"\bWerent\b": "Weren't",
        r"\bArent\b": "Aren't",
        r"\bCouldnt\b": "Couldn't",
        r"\bShouldnt\b": "Shouldn't",
        r"\bWouldnt\b": "Wouldn't",
        r"\bWhats\b": "What's",
        r"\bThats\b": "That's",
        r"\bIts\b": "It's",
        r"\bWhos\b": "Who's",
        r"\bHeres\b": "Here's",
        r"\bTheres\b": "There's",
        r"\bWheres\b": "Where's",
    }
    for base_var in variations.copy():
        for pattern, replacement in contraction_map.items():
            fixed = re.sub(pattern, replacement, base_var, flags=re.IGNORECASE)
            if fixed != base_var and fixed not in variations:
                variations.append(fixed)

    # Generic possessive/apostrophe-s: try each capitalized word ending in 's'
    # individually, e.g. "Bobs Burgers" -> "Bob's Burgers" and "Bobs Burger's"
    for base_var in variations.copy():
        # Find all capitalized words ending in 's' (potential possessives)
        words_with_s = re.findall(r"\b([A-Z][a-z]+)s\b", base_var)
        for word in words_with_s:
            # Replace just this one word's trailing s with 's
            possessive = re.sub(r"\b" + re.escape(word) + r"s\b", word + "'s", base_var, count=1)
            if possessive != base_var and possessive not in variations:
                variations.append(possessive)

    # Try "and" <-> "&" swap
    for var in variations.copy():
        if " and " in var.lower():
            swapped = re.sub(r"\band\b", "&", var, flags=re.IGNORECASE)
            if swapped not in variations:
                variations.append(swapped)
        if " & " in var:
            swapped = var.replace(" & ", " and ")
            if swapped not in variations:
                variations.append(swapped)

    # Last resort: drop a leading acronym word — OMDb sometimes lists these
    # without the prefix (e.g. 'SAS Rogue Heroes' is titled 'Rogue Heroes').
    # Requires 2+ remaining words, and every result is still checked by
    # is_good_series_match before it is used.
    dropped = re.sub(r"^[A-Z]{2,6}:?\s+", "", title).strip()
    if dropped and dropped != title and len(dropped.split()) >= 2 and dropped not in variations:
        variations.append(dropped)

    return variations


def is_good_series_match(parsed_title: str, parsed_year: str | None, result: dict) -> bool:
    """Validate an OMDb series hit before accepting it.

    OMDb's t= matching is fuzzy and our variations are aggressive, so make
    sure the returned series actually resembles what we parsed: either the
    titles are similar, or one contains the other (with at least two words
    of overlap, so 'Rogue Heroes' can match 'SAS Rogue Heroes' but a
    one-word result can't hijack a longer title).
    """
    omdb_title = result.get("title") or ""
    similarity = title_match_ratio(parsed_title, omdb_title)
    a, b = normalize_for_match(parsed_title), normalize_for_match(omdb_title)
    def acronym_prefix(long_title, short_normalized):
        parts = long_title.split(maxsplit=1)
        return (len(parts) == 2 and parts[0].isupper() and parts[0].isalpha()
                and 2 <= len(parts[0]) <= 5
                and normalize_for_match(parts[1]) == short_normalized
                and len(short_normalized.split()) >= 2)
    contained = acronym_prefix(parsed_title, b) or acronym_prefix(omdb_title, a)
    if re.findall(r"\b\d+\b", parsed_title) != re.findall(r"\b\d+\b", omdb_title):
        return False
    if similarity < 0.85 and not contained:
        log.info(
            f"  Rejected series: '{omdb_title}' too different from "
            f"'{parsed_title}' (similarity {similarity:.2f})"
        )
        return False
    if parsed_year and result.get("year"):
        try:
            if abs(int(parsed_year[:4]) - int(str(result["year"])[:4])) > 1:
                log.info(
                    f"  Rejected series: year gap '{parsed_year}' vs "
                    f"'{result['year']}' for '{omdb_title}'"
                )
                return False
        except ValueError:
            pass
    return True


def _query_omdb_series_single(title: str, year: str | None = None) -> dict | None:
    """Query OMDb API for a single TV series title (no variations).

    Raises OMDbRateLimitError if too many consecutive 401 errors are detected.
    """
    params = {
        "apikey": config.OMDB_API_KEY,
        ("t" if year else "s"): title,
        "type": "series",
    }
    if year:
        params["y"] = year

    try:
        data = _omdb_get(params)

        if data.get("Response") == "True":
            if not year:
                rows = data.get("Search", [])
                if not isinstance(rows, list):
                    return None
                def search_count(payload, default=None):
                    value = payload.get("totalResults", default)
                    if isinstance(value, bool) or not isinstance(value, (int, str)) or not str(value).isdigit():
                        return None
                    return int(value)
                total = search_count(data, len(rows))
                if total is None or not 0 < total <= 10 * _OMDB_SERIES_SEARCH_MAX_PAGES:
                    return None
                # A result on page one is not safe until every reported row has
                # been checked. Short, overlapping, or changing pages leave the
                # identity unresolved, even when an earlier row looked exact.
                if len(rows) != min(10, total):
                    return None
                for page in range(2, (total + 9) // 10 + 1):
                    page_params = {**params, "page": page}
                    page_data = _omdb_get(page_params)
                    if not isinstance(page_data, dict) or page_data.get("Response") != "True":
                        return None
                    page_rows = page_data.get("Search")
                    if (search_count(page_data) != total
                            or not isinstance(page_rows, list)
                            or len(page_rows) != min(10, total - len(rows))):
                        return None
                    rows.extend(page_rows)
                seen_ids = set()
                for row in rows:
                    if (not isinstance(row, dict)
                            or not isinstance(row.get("Title"), str) or not row["Title"].strip()
                            or not isinstance(row.get("Year"), str)
                            or row.get("Type") != "series"
                            or not isinstance(row.get("imdbID"), str)
                            or not re.fullmatch(r"tt\d+", row["imdbID"])
                            or row["imdbID"] in seen_ids):
                        return None
                    seen_ids.add(row["imdbID"])
                candidates = [{"title": row.get("Title"), "year": row.get("Year", "")[:4],
                               "type": row.get("Type"), "imdbID": row.get("imdbID")}
                              for row in rows]
                candidates = [row for row in candidates if is_good_series_match(title, None, row)]
                return candidates[0] if len(candidates) == 1 else None
            return {
                "title": data.get("Title"),
                "year": data.get("Year", "").split("–")[0],  # Get start year from "2008–2013"
                "type": data.get("Type"),
                "imdbID": data.get("imdbID"),
            }
    except (OMDbRateLimitError, OMDbUnavailableError):
        raise  # not a verdict on the title: the caller waits and retries
    except (ValueError, TypeError, AttributeError):
        # An unexpected reply shape is not a transport failure: no match is accepted.
        log.error("OMDb series lookup failed; no match accepted")

    return None


def query_omdb_series(title: str, year: str | None = None) -> dict | None:
    """Query OMDb API for a TV series, trying title variations.

    Raises OMDbRateLimitError if too many consecutive 401 errors are detected.
    Results are cached to avoid re-querying the same titles in watch mode.
    """
    local = existing_series(title, year, config.TV_DEST_DIRS)
    if local:
        return local
    cache_key = (f"series:{title.lower().strip()}", year)
    cached_time = _omdb_no_match_cache.get(cache_key)
    if cached_time and (time.time() - cached_time) < _OMDB_CACHE_TTL:
        log.debug(f"  No OMDb match for series (cached): {title}")
        return None

    variations = get_series_title_variations(title)

    for variant in variations:
        result = _query_omdb_series_single(variant, year)
        if result and is_good_series_match(title, year, result):
            if variant != variations[0]:
                log.info(f"  Series matched via variation: '{variant}'")
            return result

    _omdb_no_match_cache[cache_key] = time.time()
    return None


def _season_episode_titles(series_title: str, season: int, imdb_id: str | None) -> dict:
    """{episode number: title} for one season: a single OMDb request, then cached.

    Asking for each episode on its own cost one request per file, so a 134-episode pack ate
    13% of the free key's 1,000-a-day allowance and a few big packs could exhaust it."""
    key = f"{imdb_id or 'title:' + series_title.lower().strip()}|{int(season)}"
    cached = _season_cache.get(key)
    if cached is not None:
        return cached
    params = {
        "apikey": config.OMDB_API_KEY,
        ("i" if imdb_id else "t"): imdb_id or series_title,
        "Season": season,
    }
    data = _omdb_get(params)
    episodes, finished = omdb_support.parse_season(data) if data.get("Response") == "True" else ({}, False)
    _season_cache.put(key, episodes, finished)
    return episodes


def query_omdb_episode(series_title: str, season: int, episode: int, imdb_id: str | None = None) -> dict | None:
    """Episode title from OMDb, from one cached request per season.

    Raises OMDbRateLimitError after repeated 401s, and OMDbUnavailableError when OMDb cannot
    be asked: that is never reported as "no title", or the episode would be filed without one.
    """
    title = _season_episode_titles(series_title, season, imdb_id).get(int(episode))
    return {"episode_title": title} if title else None


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
        # Decode HTML entities from OMDb (e.g., &gt; -> >)
        episode_title = html.unescape(episode_title)
        # Replace / with - (not allowed in Windows filenames)
        episode_title = episode_title.replace("/", "-")
        clean_ep_title = re.sub(r'[<>:"/\\|?*]', "", episode_title)
        clean_ep_title = re.sub(r"\s+", " ", clean_ep_title).strip()
        base = f"{clean_title} - {ep_code} - {clean_ep_title}"
    else:
        base = f"{clean_title} - {ep_code}"

    if lang_suffix:
        return f"{base}{lang_suffix}{extension}"
    return f"{base}{extension}"


def find_media_in_source() -> tuple[list[dict], list[dict]]:
    """Find all media in source directory, separating movies from TV shows."""
    source = Path(config.SOURCE_DIR)
    if not source.exists():
        log.error(f"Source directory does not exist: {source}")
        return [], []

    movies = []
    tv_shows = []

    for item in source.iterdir():
        # Underscore prefix = admin parking convention (_review, _keep):
        # deliberately left in Share, never organized or judged.
        if item.name.startswith("_") or item.name.lower() == "incomplete":
            continue
        if not ready_for_import(item, _DOWNLOAD_SNAPSHOT, _download_observations):
            continue
        if item.is_file() and item.suffix.lower() in config.VIDEO_EXTENSIONS:
            # Check if it's a TV show
            tv_info = parse_tv_info(item.stem)
            if tv_info:
                tv_shows.append({
                    "type": "loose",
                    "path": item,
                    "parse_name": item.stem,
                    "tv_info": tv_info,
                })
            else:
                movies.append({
                    "type": "loose",
                    "path": item,
                    "parse_name": item.stem,
                })

        elif item.is_dir():
            if item.name.lower() == "incomplete":
                continue
            # qBittorrent downloads in place with .!qb appended until each
            # file completes. A mid-download pack looks "complete but
            # episode-less" (small extras finish first), gets judged on
            # partial contents, and lands in the permanent skip list — the
            # Grimm bug. Wait until no part-files remain.
            if any(f.suffix.lower() in (".!qb", ".part") for f in item.rglob("*")):
                if item.name not in _transferring_logged:
                    log.info(f"WAIT: Still downloading (part-files present): {item.name}")
                    _transferring_logged.add(item.name)
                continue

            video_files = get_all_files(item, config.VIDEO_EXTENSIONS)
            if video_files:
                # Check if it's a TV show based on folder name or first video file
                tv_info = parse_tv_info(item.name)
                if not tv_info:
                    tv_info = next((info for file in sorted(video_files)
                                    if (info := parse_tv_info(file.stem))), None)

                if tv_info:
                    tv_shows.append({
                        "type": "folder",
                        "path": item,
                        "parse_name": item.name,
                        "video_files": video_files,
                        "subtitle_files": get_all_files(item, config.SUBTITLE_EXTENSIONS),
                        "tv_info": tv_info,
                    })
                else:
                    movies.append({
                        "type": "folder",
                        "path": item,
                        "parse_name": item.name,
                        "video_files": video_files,
                        "subtitle_files": get_all_files(item, config.SUBTITLE_EXTENSIONS),
                    })

    return movies, tv_shows


def review_item(item: dict, title: str, reason: str, file: str | None = None) -> None:
    """Report something a person must look at. `file` names the one file the note is about, so the
    Organizer page can clear the note once that file has been imported."""
    record = {"type": "show" if "tv_info" in item else "movie", "title": title,
              "source": item["path"].name, "reason": reason}
    if file:
        record["file"] = file
    log.warning("REVIEW: %s", json.dumps(record, ensure_ascii=False))


# Names the part-files being written so a crash cannot leave them behind. Set only by
# real runs (see start_inflight_journal); None in tests and previews, which touch no
# shared state.
_inflight_journal = None


def start_inflight_journal() -> None:
    """Clean up after an interrupted run, then start tracking this run's copies."""
    global _inflight_journal
    journal = safe_copy.InflightJournal(config.INFLIGHT_FILE)
    journal.recover()
    _inflight_journal = journal


# The live status file (see organizer_status.py). Set only by watch mode; None everywhere
# else, so tests, previews and one-off runs write nothing.
_status = None


def start_status() -> None:
    global _status
    status = organizer_status.StatusFile(config.STATUS_FILE, interval=config.STATUS_INTERVAL)
    status._warn = log.warning
    status.add_provider(omdb_snapshot)
    status.start()
    _status = status


def stop_status() -> None:
    global _status
    status, _status = _status, None
    if status is not None:
        status.stop(final="stopped")


def _activity(state: str, detail: str = "") -> None:
    if _status is not None:
        _status.activity(state, detail)


def _release_of(source: Path) -> str:
    """The download a file came from: its first folder below Share, or its own name."""
    try:
        return Path(source).relative_to(config.SOURCE_DIR).parts[0]
    except (ValueError, IndexError):
        return Path(source).name


def _record_move(source: Path, destination: Path) -> None:
    """One machine-readable line per completed move, next to the human-readable ones.

    The Organizer page pairs a release with what was filed from it, and clears review notes for
    files that were later imported, from these lines rather than from the wording of the others."""
    release = _release_of(source)
    log.info("EVENT: %s", json.dumps({"event": "moved", "release": release, "source": str(source),
                                      "destination": str(destination)}, ensure_ascii=False))
    if _status is not None:
        _status.update(lastImport={"at": int(time.time() * 1000), "release": release, "name": Path(destination).name})


def move_without_overwrite(source: Path, destination: Path) -> None:
    """Move a file into the library without ever replacing anything.

    Same-drive moves are an instant hard link. Cross-drive moves are copied to a hidden
    part-file, verified, then published atomically (see safe_copy.py), so a crash
    cannot leave a truncated file under the real name."""
    def announce() -> None:
        # Keep original and destination paths in the activity log for corrections.
        log.info("Import source: %s -> %s", source, destination)

    _activity("importing", _release_of(source))
    safe_copy.import_file(source, destination, journal=_inflight_journal, before_unlink=announce)
    log.info("Moved -> %s", destination)
    _record_move(source, destination)


def execute_import(item: dict, title: str, plan: list, dry_run: bool) -> bool:
    """One plan is used for preview and apply. Conflicts always preserve sources."""
    counts = {}
    for _, destination in plan:
        counts[destination] = counts.get(destination, 0) + 1
    moved = 0
    for source, destination in plan:
        if destination.exists() or destination.is_symlink() or counts[destination] > 1:
            review_item(item, title, f"Destination conflict: {source.name} -> {destination}; source retained", source.name)
            continue
        if dry_run:
            log.info("[DRY RUN] Would move: %s -> %s", source, destination)
            moved += 1
            continue
        try:
            move_without_overwrite(source, destination)
            moved += 1
        except Exception as error:
            review_item(item, title, f"Could not import {source.name}: {error}; source retained", source.name)
    if not dry_run and item["type"] == "folder":
        cleanup_source_folder(item["path"])
    return moved > 0


def resolve_tv_file(file: Path, show: dict) -> dict | None:
    info = parse_tv_info(file.stem)
    if not info or info.get("episode") is None:
        return None
    # Explicit filename season wins; otherwise consult the nearest season folder.
    season = info.get("season")
    if season is None and show["type"] == "folder":
        for parent in file.parents:
            if parent == show["path"].parent:
                break
            match = re.fullmatch(r"(?:Season|S)\s*(\d+)", parent.name, re.I)
            if match:
                season = int(match.group(1))
                break
        if season is None:
            season = show["tv_info"].get("season")
    if not isinstance(season, int):
        return None
    info["season"] = season
    return info


def _ambiguous_note(file: Path) -> tuple[str, str]:
    """(review reason, file name)"""
    return f"Missing or ambiguous season/episode: {file.name}; source retained", file.name


def _names_no_episode(file: Path) -> bool:
    """Bonus material, as opposed to an episode whose season could not be worked out."""
    info = parse_tv_info(file.stem)
    return not info or info.get("episode") is None


def _plan_extras(show: dict, series_info: dict, base: Path, plan: list, bonus: list,
                 subtitles: list) -> tuple[list, list]:
    """File the bonus videos of an episode pack under <series>/Extras/ (see extras.py).

    Only for a pack whose series is a confident match and that is demonstrably a set of
    episodes: one of its own episodes is being imported now, or the library already has some.
    Anything doubtful (a sample, something much larger than the episodes, a name that carries
    another year) stays where it is and is reported for review as before.
    Returns (plan entries, review notes)."""
    if not (bonus or subtitles):
        return [], []
    episodes = [source for source, _ in plan if source in show["video_files"]]
    eligible = (bonus and config.FILE_EXTRAS and show["type"] == "folder" and series_info.get("imdbID")
                and (episodes or extras.series_has_episodes(base)))
    if not eligible:
        return [], [_ambiguous_note(file) for file in bonus + subtitles]
    sizes = []
    for source in episodes:
        try:
            sizes.append(source.stat().st_size)
        except OSError:
            pass
    filed, declined = extras.choose_extras(
        show["path"], bonus, series_year=series_info["year"],
        largest_episode=max(sizes) if sizes else None, pack_season=show["tv_info"].get("season"))
    destination = base / extras.EXTRAS_DIR
    paired = extras.pair_subtitles(filed, subtitles, extract_language_suffix)
    entries = [(source, destination.joinpath(*parts)) for source, parts in filed + paired]
    taken = {subtitle for subtitle, _ in paired}
    notes = [(f"Not filed as an extra ({why}): {source.name}; source retained", source.name) for source, why in declined]
    notes += [_ambiguous_note(file) for file in subtitles if file not in taken]
    if filed:
        log.info("Filing %d extra%s from %s under %s/%s", len(filed), "" if len(filed) == 1 else "s",
                 show["path"].name, base.name, extras.EXTRAS_DIR)
    return entries, notes


def move_tv_show(show: dict, series_info: dict, dry_run: bool = False) -> bool:
    title, year = series_info["title"], series_info["year"]
    folder = create_clean_filename(title, year, "")
    base = get_tv_dest(folder) / folder
    videos = [show["path"]] if show["type"] == "loose" else show["video_files"]
    plan = []
    # Written once the plan is complete. If OMDb cannot supply an episode title the pack is
    # planned again on the next scan, and these notes must not be repeated every time.
    reviews = []
    bonus, loose_subtitles = [], []   # what is left over once the episodes are placed
    for file in videos + show.get("subtitle_files", []):
        info = resolve_tv_file(file, show)
        if not info:
            if file not in videos:
                loose_subtitles.append(file)
            elif show["type"] == "folder" and _names_no_episode(file):
                bonus.append(file)
            else:
                reviews.append(_ambiguous_note(file))
            continue
        file_title = info.get("title")
        if file_title and not is_good_series_match(file_title, info.get("year"), series_info):
            reviews.append((f"File belongs to a different or uncertain series: {file.name}; source retained", file.name))
            continue
        season, episode = info["season"], info["episode"]
        is_video = file in videos
        ep_title = None
        # Combined episodes keep every number and omit a misleading single title.
        if is_video and not isinstance(episode, list) and series_info.get("imdbID"):
            ep_info = query_omdb_episode(title, season, episode, series_info["imdbID"])
            ep_title = (ep_info or {}).get("episode_title")
        if ep_title and re.match(r"^Episode\s+#?\d+(?:\.\d+)?$", ep_title):
            ep_title = None
        stem, suffix = get_file_parts(file)
        name = create_tv_filename(title, season, episode, ep_title, suffix,
                                  "" if is_video else extract_language_suffix(stem))
        if name:
            plan.append((file, base / f"Season {season:02d}" / name))
    extra_plan, extra_notes = _plan_extras(show, series_info, base, plan, bonus, loose_subtitles)
    plan += extra_plan
    for reason, name in reviews + extra_notes:
        review_item(show, title, reason, name)
    return execute_import(show, title, plan, dry_run)


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


def move_movie(movie: dict, omdb_info: dict, dry_run: bool = False) -> bool:
    title, year = omdb_info["title"], omdb_info["year"]
    folder = create_clean_filename(title, year, "")
    try:
        existing = find_existing_equivalent_movie(folder)
    except OSError as error:
        review_item(movie, title, f"Cannot verify existing movie folders: {error}; source retained")
        return False
    if existing:
        review_item(movie, title, f"Movie already exists at {existing}; source retained for comparison")
        return False
    destination = get_movie_dest(folder) / folder
    videos = [movie["path"]] if movie["type"] == "loose" else movie["video_files"]
    # Multiple videos could be a collection, split movie, alternate cut or extras.
    # Never choose the largest and discard the rest.
    if len(videos) != 1:
        review_item(movie, title, "Multiple videos need individual identification; all source files retained")
        return False
    reason = check_movie(videos[0], omdb_info)
    if reason:
        review_item(movie, title, reason)
        return False
    plan = [(videos[0], destination / create_clean_filename(title, year, videos[0].suffix.lower()))]
    for file in movie.get("subtitle_files", []):
        stem, suffix = get_file_parts(file)
        plan.append((file, destination / create_clean_filename(title, year, suffix, extract_language_suffix(stem))))
    return execute_import(movie, title, plan, dry_run)


def cleanup_source_folder(folder: Path) -> None:
    """Remove empty directories only. Unresolved files and extras always survive."""
    if not folder.is_dir() or folder.is_symlink():
        return
    for path in sorted(folder.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_dir() and not path.is_symlink():
            try:
                path.rmdir()
            except OSError:
                pass
    try:
        folder.rmdir()
        log.info("Removed empty source folder: %s", folder.name)
    except OSError:
        log.info("Retained source folder with remaining files: %s", folder.name)


def _progress_file_path() -> Path:
    """Get the path to the library progress file (next to the script)."""
    return Path(__file__).parent / config.LIBRARY_PROGRESS_FILE


def load_library_progress() -> dict:
    """Load library progress from JSON file."""
    path = _progress_file_path()
    if path.exists():
        try:
            data = json.loads(path.read_text())
            return {
                "movies": set(data.get("movies", [])),
                "tv": set(data.get("tv", [])),
            }
        except (json.JSONDecodeError, KeyError):
            log.warning(f"Corrupt progress file, starting fresh: {path}")
    return {"movies": set(), "tv": set()}


def save_library_progress(progress: dict) -> None:
    """Save library progress to JSON file."""
    path = _progress_file_path()
    data = {
        "movies": sorted(progress.get("movies", set())),
        "tv": sorted(progress.get("tv", set())),
    }
    path.write_text(json.dumps(data, indent=2))


def clear_library_progress(mode: str) -> None:
    """Clear library progress for the given mode ('movies', 'tv', or 'all')."""
    if mode == "all":
        path = _progress_file_path()
        if path.exists():
            path.unlink()
            log.info("Cleared all library progress.")
        else:
            log.info("No progress file found.")
        return

    progress = load_library_progress()
    if mode in progress:
        count = len(progress[mode])
        progress[mode] = set()
        save_library_progress(progress)
        log.info(f"Cleared {mode} library progress ({count} entries).")
    else:
        log.info(f"No {mode} progress found.")


def is_properly_named(folder_name: str) -> bool:
    """Check if a folder is already in 'Title (Year)' format."""
    # Match pattern like "Movie Name (2024)" or "Movie Name (2024-2025)"
    return bool(re.match(r"^.+\s+\(\d{4}(-\d{4})?\)$", folder_name))


def rename_library_folder(folder: Path, omdb_info: dict, dry_run: bool = False) -> bool:
    """Rename a library folder and its contents to proper naming."""
    if len(get_all_files(folder, config.VIDEO_EXTENSIONS)) != 1:
        log.warning("SKIP: Multiple or missing movie videos need review: %s", folder)
        return False
    title = omdb_info["title"]
    year = omdb_info["year"]
    new_folder_name = create_clean_filename(title, year, "")
    new_folder = folder.parent / new_folder_name

    # Skip if already named correctly
    if folder.name == new_folder_name:
        log.info(f"  Already correctly named: {folder.name}")
        return False

    # Check if target already exists
    if new_folder.exists() and new_folder != folder:
        log.warning(f"  SKIP: Target folder already exists: {new_folder_name}")
        return False

    if dry_run:
        log.info(f"  [DRY RUN] Would rename folder: {folder.name} -> {new_folder_name}")
        # Show what files would be renamed
        for video_file in get_all_files(folder, config.VIDEO_EXTENSIONS):
            new_name = create_clean_filename(title, year, video_file.suffix.lower())
            if video_file.name != new_name:
                log.info(f"  [DRY RUN] Would rename file: {video_file.name} -> {new_name}")
        return True

    try:
        # First rename files inside the folder
        for video_file in get_all_files(folder, config.VIDEO_EXTENSIONS):
            new_name = create_clean_filename(title, year, video_file.suffix.lower())
            if video_file.name != new_name:
                new_path = video_file.parent / new_name
                if new_path.exists():
                    log.warning("SKIP: Destination conflict: %s", new_path)
                    continue
                move_without_overwrite(video_file, new_path)
                log.info(f"  Renamed file: {video_file.name} -> {new_name}")

        for sub_file in get_all_files(folder, config.SUBTITLE_EXTENSIONS):
            stem, suffix = get_file_parts(sub_file)
            lang_suffix = extract_language_suffix(stem)
            new_name = create_clean_filename(title, year, suffix, lang_suffix)
            if sub_file.name != new_name:
                new_path = sub_file.parent / new_name
                if new_path.exists():
                    log.warning("SKIP: Destination conflict: %s", new_path)
                    continue
                move_without_overwrite(sub_file, new_path)
                log.info(f"  Renamed file: {sub_file.name} -> {new_name}")

        # Then rename the folder itself
        if folder.name != new_folder_name:
            folder.rename(new_folder)
            log.info(f"  Renamed folder: {folder.name} -> {new_folder_name}")

        return True

    except Exception as e:
        log.error(f"  ERROR renaming: {e}")
        return False


def rename_files_in_folder(folder: Path, title: str, year: str, dry_run: bool = False) -> int:
    """Rename files inside a folder to proper naming. Returns count of files renamed."""
    if len(get_all_files(folder, config.VIDEO_EXTENSIONS)) != 1:
        log.warning("SKIP: Multiple or missing movie videos need review: %s", folder)
        return False
    renamed_count = 0

    for video_file in get_all_files(folder, config.VIDEO_EXTENSIONS):
        new_name = create_clean_filename(title, year, video_file.suffix.lower())
        if video_file.name != new_name:
            if dry_run:
                log.info(f"  [DRY RUN] Would rename: {video_file.name} -> {new_name}")
            else:
                new_path = video_file.parent / new_name
                if new_path.exists():
                    log.warning("SKIP: Destination conflict: %s", new_path)
                    continue
                move_without_overwrite(video_file, new_path)
                log.info(f"  Renamed: {video_file.name} -> {new_name}")
            renamed_count += 1

    for sub_file in get_all_files(folder, config.SUBTITLE_EXTENSIONS):
        stem, suffix = get_file_parts(sub_file)
        lang_suffix = extract_language_suffix(stem)
        new_name = create_clean_filename(title, year, suffix, lang_suffix)
        if sub_file.name != new_name:
            if dry_run:
                log.info(f"  [DRY RUN] Would rename: {sub_file.name} -> {new_name}")
            else:
                new_path = sub_file.parent / new_name
                if new_path.exists():
                    log.warning("SKIP: Destination conflict: %s", new_path)
                    continue
                move_without_overwrite(sub_file, new_path)
                log.info(f"  Renamed: {sub_file.name} -> {new_name}")
            renamed_count += 1

    return renamed_count


def process_library(dry_run: bool = False) -> tuple[int, int, int]:
    """Process existing library to rename improperly named folders and files."""
    if dry_run:
        log.info("=== DRY RUN MODE - No files will be renamed ===")

    # Collect folders from all movie drives
    all_folders = []
    for lib_dir in config.MOVIE_DEST_DIRS:
        library = Path(lib_dir)
        if not library.exists():
            log.warning(f"Skipping missing library: {library}")
            continue
        log.info(f"Scanning library: {library}")
        all_folders.extend(sorted(f for f in library.iterdir() if f.is_dir()))

    if not all_folders:
        log.error("No movie library directories found")
        return 0, 0, 0

    progress = load_library_progress()
    prev_done = progress["movies"]

    renamed = 0
    skipped = 0
    already_ok = 0
    prev_skipped = 0

    folders = all_folders
    total = len(folders)

    try:
        for i, folder in enumerate(folders, 1):
            # Skip folders already processed in a previous run
            if folder.name in prev_done:
                prev_skipped += 1
                continue

            log.info(f"[{i}/{total}] Checking: {folder.name}")

            # Parse title and year from folder name
            title, year = parse_filename(folder.name)
            if not title:
                log.info(f"  SKIP: Could not parse title from folder name")
                skipped += 1
                continue

            # If folder is properly named, use its title/year directly for file renaming
            if is_properly_named(folder.name):
                # Extract title and year from the folder name pattern "Title (Year)"
                match = re.match(r"^(.+)\s+\((\d{4})\)$", folder.name)
                if match:
                    title = match.group(1)
                    year = match.group(2)

                    # Check and rename files inside
                    files_renamed = rename_files_in_folder(folder, title, year, dry_run=dry_run)
                    if files_renamed > 0:
                        renamed += 1
                    else:
                        log.info(f"  Files already correctly named")
                        already_ok += 1
                    progress["movies"].add(folder.name)
                    if not dry_run:
                        save_library_progress(progress)
                    continue

            log.info(f"  Parsed: title='{title}', year={year or 'none'}")

            # Query OMDb for folders not in correct format
            omdb_info = query_omdb(title, year)
            if not omdb_info:
                series_hit = check_if_actually_series(title, year)
                if series_hit:
                    log.info(
                        f"  SKIP: '{title}' is a TV series in OMDb ({series_hit['title']}, "
                        f"{series_hit['year']}), not a movie"
                    )
                else:
                    log.info(f"  SKIP: No confident OMDb match")
                skipped += 1
                continue

            log.info(f"  OMDb match: {omdb_info['title']} ({omdb_info['year']})")

            # Rename the folder and contents
            if rename_library_folder(folder, omdb_info, dry_run=dry_run):
                renamed += 1
                # Track by new name after rename
                new_name = create_clean_filename(omdb_info["title"], omdb_info["year"], "")
                progress["movies"].add(new_name)
            else:
                already_ok += 1
                progress["movies"].add(folder.name)
            if not dry_run:
                save_library_progress(progress)

    except OMDbRateLimitError as e:
        log.error(f"ABORTING: {e}")
        log.error("Partial progress has been saved. Re-run once the API limit resets.")
    except OMDbUnavailableError as e:
        log.error(f"ABORTING: OMDb is not responding ({e}). Progress has been saved; re-run later.")
    except KeyboardInterrupt:
        log.info("Interrupted. Progress has been saved. Re-run to continue.")

    prefix = "[DRY RUN] " if dry_run else ""
    if prev_skipped > 0:
        log.info(f"{prefix}Skipped {prev_skipped} previously processed folders.")
    log.info(f"{prefix}Library scan complete. Renamed: {renamed}, Skipped: {skipped}, Already OK: {already_ok}")
    return renamed, skipped, already_ok


def rename_tv_files_in_season(
    season_folder: Path, series_title: str, season: int, dry_run: bool = False,
    trust_folder_season: bool = False,
) -> int:
    """Rename episode files inside a season folder. Returns count of files renamed.

    When trust_folder_season=True (matched season folder), always use the folder's season number.
    When trust_folder_season=False (no season subfolders), use each file's own parsed season.
    """
    renamed_count = 0

    # Cache episode titles from OMDb to avoid duplicate calls for subs
    # Key is (season, episode) tuple
    episode_title_cache: dict[tuple[int, int], str | None] = {}

    def get_episode_title(s: int, ep: int) -> str | None:
        """Get episode title, preferring OMDb over PTN (PTN truncates at special chars)."""
        key = (s, ep)
        if key in episode_title_cache:
            return episode_title_cache[key]

        ep_info = query_omdb_episode(series_title, s, ep)
        ep_title = None
        if ep_info:
            ep_title = ep_info.get("episode_title")
            # Skip generic episode titles (Episode 1, Episode #1.1, etc.)
            if ep_title and re.match(r"^Episode\s+#?\d+(?:\.\d+)?$", ep_title):
                ep_title = None
            time.sleep(0.15)

        episode_title_cache[key] = ep_title
        return ep_title

    for video_file in get_all_files(season_folder, config.VIDEO_EXTENSIONS):
        # Parse episode info from the filename
        tv_info = parse_tv_info(video_file.stem)
        if not tv_info or not tv_info.get("episode"):
            continue

        # In a matched season folder, trust the folder's season number (filenames may be wrong)
        # Without season folders, use each file's own parsed season
        file_season = (tv_info.get("season") if tv_info.get("season") is not None else season)
        file_episode = tv_info["episode"]
        if not isinstance(file_season, int):
            continue

        # Extract existing episode title from filename if it's already in our format
        # "Show Name - S01E02 - Episode Title.ext" -> "Episode Title"
        existing_ep_title = None
        ep_title_match = re.match(
            r".+ - S\d{2}E\d{2} - (.+)$", video_file.stem
        )
        if ep_title_match:
            existing_ep_title = ep_title_match.group(1)

        # Always prefer OMDb title (PTN truncates at special chars like ' / = etc.)
        file_ep_title = None if isinstance(file_episode, list) else get_episode_title(file_season, file_episode)
        # Fall back to existing filename title (already clean), then PTN-parsed title
        if not file_ep_title and not isinstance(file_episode, list):
            file_ep_title = existing_ep_title or tv_info.get("episode_title")

        new_name = create_tv_filename(
            series_title, file_season, file_episode, file_ep_title, video_file.suffix.lower()
        )
        if new_name and video_file.name != new_name:
            new_path = video_file.parent / new_name
            # Skip if target file already exists (e.g., specials with same episode number)
            if new_path.exists():
                log.warning(f"    SKIP: Target already exists: {new_name}")
                continue
            if dry_run:
                log.info(f"    [DRY RUN] Would rename: {video_file.name} -> {new_name}")
            else:
                move_without_overwrite(video_file, new_path)
                log.info(f"    Renamed: {video_file.name} -> {new_name}")
            renamed_count += 1

    for sub_file in get_all_files(season_folder, config.SUBTITLE_EXTENSIONS):
        stem, suffix = get_file_parts(sub_file)
        tv_info = parse_tv_info(stem)
        if not tv_info or not tv_info.get("episode"):
            continue

        file_season = (tv_info.get("season") if tv_info.get("season") is not None else season)
        file_episode = tv_info["episode"]
        if not isinstance(file_season, int):
            continue
        lang_suffix = extract_language_suffix(stem)

        new_name = create_tv_filename(
            series_title, file_season, file_episode, None, suffix, lang_suffix
        )
        if new_name and sub_file.name != new_name:
            new_path = sub_file.parent / new_name
            if new_path.exists():
                continue  # Skip silently for subs
            if dry_run:
                log.info(f"    [DRY RUN] Would rename: {sub_file.name} -> {new_name}")
            else:
                move_without_overwrite(sub_file, new_path)
                log.info(f"    Renamed: {sub_file.name} -> {new_name}")
            renamed_count += 1

    return renamed_count


def process_tv_library(dry_run: bool = False) -> tuple[int, int, int]:
    """Process existing TV library to rename folders and episode files."""
    if dry_run:
        log.info("=== DRY RUN MODE - No files will be renamed ===")

    # Collect folders from all TV drives
    all_folders = []
    for lib_dir in config.TV_DEST_DIRS:
        library = Path(lib_dir)
        if not library.exists():
            log.warning(f"Skipping missing TV library: {library}")
            continue
        log.info(f"Scanning TV library: {library}")
        all_folders.extend(sorted(f for f in library.iterdir() if f.is_dir()))

    if not all_folders:
        log.error("No TV library directories found")
        return 0, 0, 0

    progress = load_library_progress()
    prev_done = progress["tv"]

    renamed = 0
    skipped = 0
    already_ok = 0
    prev_skipped = 0

    folders = all_folders
    total = len(folders)

    try:
        for i, folder in enumerate(folders, 1):
            # Skip folders already processed in a previous run
            if folder.name in prev_done:
                prev_skipped += 1
                continue

            log.info(f"[{i}/{total}] Checking: {folder.name}")

            # Check if folder already has year in "Show Name (Year)" format
            # Also handle malformed like "Fargo (2014 )" with extra whitespace
            match = re.match(r"^(.+)\s+\(\s*(\d{4})\s*\)$", folder.name)
            if match:
                series_title = match.group(1).strip()
                series_year = match.group(2)

                # If the folder name was malformed, fix it
                clean_folder_name = f"{re.sub(r'[<>:\"/\\|?*]', '', series_title)} ({series_year})"
                if folder.name != clean_folder_name:
                    clean_folder = folder.parent / clean_folder_name
                    if clean_folder.exists() and clean_folder != folder:
                        log.warning(f"  SKIP: Clean target already exists: {clean_folder_name}")
                        skipped += 1
                        continue
                    if dry_run:
                        log.info(f"  [DRY RUN] Would fix folder name: {folder.name} -> {clean_folder_name}")
                    else:
                        folder.rename(clean_folder)
                        log.info(f"  Fixed folder name: {folder.name} -> {clean_folder_name}")
                        folder = clean_folder
            else:
                # Need to look up the show on OMDb to get the year
                parsed_title = folder.name
                # Clean common patterns from folder name
                parsed_title = re.sub(r"\s*\(\d{4}p?\)", "", parsed_title)  # Remove resolution
                parsed_title = clean_title(parsed_title)

                series_info = query_omdb_series(parsed_title)
                if not series_info:
                    log.info(f"  SKIP: No OMDb match for series: {parsed_title}")
                    skipped += 1
                    continue

                series_title = series_info["title"]
                series_year = series_info["year"]
                log.info(f"  OMDb match: {series_title} ({series_year})")

                # Rename the folder to include the year
                new_folder_name = f"{re.sub(r'[<>:\"/\\|?*]', '', series_title)} ({series_year})"
                new_folder = folder.parent / new_folder_name

                if new_folder.exists() and new_folder != folder:
                    log.warning(f"  SKIP: Target folder already exists: {new_folder_name}")
                    skipped += 1
                    continue

                if dry_run:
                    log.info(f"  [DRY RUN] Would rename folder: {folder.name} -> {new_folder_name}")
                else:
                    folder.rename(new_folder)
                    log.info(f"  Renamed folder: {folder.name} -> {new_folder_name}")
                    folder = new_folder  # Update reference for file processing below

            # Process season folders inside - match various naming patterns:
            # "Season 01", "Season 1", "Show Name Season 1", "Show Name (2010) Season 1"
            season_folders = []
            for f in sorted(folder.iterdir()):
                if not f.is_dir():
                    continue
                season_match = re.search(r"Season\s+(\d+)", f.name, re.IGNORECASE)
                if season_match:
                    season_folders.append((f, int(season_match.group(1))))

            if not season_folders:
                # Maybe files are directly in the show folder (no season subfolders)
                video_files = get_all_files(folder, config.VIDEO_EXTENSIONS)
                if video_files:
                    # No season folder - use each file's own parsed season
                    files_renamed = rename_tv_files_in_season(
                        folder, series_title, 1, dry_run, trust_folder_season=False
                    )
                    if files_renamed > 0:
                        renamed += 1
                    else:
                        already_ok += 1
                else:
                    already_ok += 1
                progress["tv"].add(folder.name)
                if not dry_run:
                    save_library_progress(progress)
                continue

            show_had_renames = False
            for season_folder, season_num in season_folders:
                # Rename non-standard season folders (e.g. "Show Name Season 1" -> "Season 01")
                standard_name = f"Season {season_num:02d}"
                if season_folder.name != standard_name:
                    new_season_path = season_folder.parent / standard_name
                    if new_season_path.exists() and new_season_path != season_folder:
                        log.warning(f"  SKIP season folder rename: {standard_name} already exists")
                    elif dry_run:
                        log.info(f"  [DRY RUN] Would rename season folder: {season_folder.name} -> {standard_name}")
                    else:
                        season_folder.rename(new_season_path)
                        log.info(f"  Renamed season folder: {season_folder.name} -> {standard_name}")
                        season_folder = new_season_path

                log.info(f"  Season {season_num:02d}:")
                files_renamed = rename_tv_files_in_season(
                    season_folder, series_title, season_num, dry_run, trust_folder_season=True
                )
                if files_renamed > 0:
                    show_had_renames = True

            if show_had_renames:
                renamed += 1
            else:
                log.info(f"  Files already correctly named")
                already_ok += 1

            progress["tv"].add(folder.name)
            if not dry_run:
                save_library_progress(progress)

    except OMDbRateLimitError as e:
        log.error(f"ABORTING: {e}")
        log.error("Partial progress has been saved. Re-run once the API limit resets.")
    except OMDbUnavailableError as e:
        log.error(f"ABORTING: OMDb is not responding ({e}). Progress has been saved; re-run later.")
    except KeyboardInterrupt:
        log.info("Interrupted. Progress has been saved. Re-run to continue.")

    prefix = "[DRY RUN] " if dry_run else ""
    if prev_skipped > 0:
        log.info(f"{prefix}Skipped {prev_skipped} previously processed folders.")
    log.info(f"{prefix}TV library scan complete. Renamed: {renamed}, Skipped: {skipped}, Already OK: {already_ok}")
    return renamed, skipped, already_ok


_retry_queue = None


def _consume_targeted_retries() -> None:
    if _retry_queue is None:
        return
    for request in _retry_queue.poll():
        titles = {request["title"].lower().strip()}
        if request["type"] == "movie":
            parsed_title, _ = parse_filename(request["parseName"])
            if parsed_title:
                titles.add(parsed_title.lower().strip())
        keys = titles if request["type"] == "movie" else {"series:" + title for title in titles}
        for key in list(_omdb_no_match_cache):
            if key[0] in keys:
                del _omdb_no_match_cache[key]
        log.info("[Retry] Queued release is ready for a new import attempt")


def _targeted_retry_item(item: dict, dry_run: bool = False) -> bool:
    return not dry_run and _retry_queue is not None and _retry_queue.wants(item["path"].name)


def _complete_targeted_retry(item: dict, dry_run: bool = False) -> None:
    if not dry_run and _retry_queue is not None:
        _retry_queue.complete(item["path"].name)


def process_movies_list(movies: list[dict], dry_run: bool = False) -> tuple[int, int]:
    """Process a list of movies. Returns (processed, skipped) counts."""
    processed = 0
    skipped = 0

    for movie in movies:
        if not dry_run:
            _consume_targeted_retries()
        parse_name = movie["parse_name"]

        # Already skipped in watch mode, e.g. duplicate destination or parse
        # failure. Skip before OMDb so polling does not hammer the API or logs.
        if parse_name in _watch_skip_logged and not _targeted_retry_item(movie, dry_run):
            skipped += 1
            continue

        # Parse filename
        title, year = parse_filename(parse_name)
        if not title:
            if parse_name not in _watch_skip_logged or _targeted_retry_item(movie, dry_run):
                log.info("")
                log.info(f"[MOVIE] Found: {parse_name}")
                log.info(f"SKIP: Could not parse title from: {parse_name}")
                _watch_skip_logged.add(parse_name)
            skipped += 1
            _complete_targeted_retry(movie, dry_run)
            continue

        folder_year = year
        year = infer_missing_movie_year(movie, title, year)
        inferred_year = folder_year is None and year is not None

        # Query OMDb (match validation happens inside query_omdb)
        try:
            omdb_info = query_omdb(title, year)
        except OMDbUnavailableError as error:
            # OMDb could not be asked, which says nothing about this title: leave it for the
            # next scan instead of recording a skip that would last until a restart.
            _wait_for_omdb(parse_name, error)
            skipped += 1
            continue
        if not omdb_info:
            if parse_name not in _watch_skip_logged or _targeted_retry_item(movie, dry_run):
                log.info("")
                log.info(f"[MOVIE] Found: {parse_name}")
                log.info(f"  Parsed: title='{title}', year={year or 'none'}")
                if inferred_year:
                    log.info(f"  Year inferred from sole matching video: {Path(movie['video_files'][0]).name}")
                try:
                    series_hit = check_if_actually_series(title, year)
                except OMDbUnavailableError as error:
                    _wait_for_omdb(parse_name, error)
                    skipped += 1
                    continue
                if series_hit:
                    log.info(
                        f"SKIP: '{title}' is a TV series in OMDb ({series_hit['title']}, "
                        f"{series_hit['year']}), not a movie — needs season/episode "
                        f"markers or manual placement, not a rename"
                    )
                else:
                    log.info(f"SKIP: No confident OMDb match for: {title} ({year or 'no year'})")
                _watch_skip_logged.add(parse_name)
            skipped += 1
            _complete_targeted_retry(movie, dry_run)
            continue

        log.info("")
        log.info(f"[MOVIE] Found: {parse_name}")
        log.info(f"  Parsed: title='{title}', year={year or 'none'}")
        if inferred_year:
            log.info(f"  Year inferred from sole matching video: {Path(movie['video_files'][0]).name}")
        log.info(f"  OMDb match: {omdb_info['title']} ({omdb_info['year']})")

        # Move the movie
        if move_movie(movie, omdb_info, dry_run=dry_run):
            processed += 1
        else:
            _watch_skip_logged.add(parse_name)
            skipped += 1
        _complete_targeted_retry(movie, dry_run)

    return processed, skipped


def process_tv_shows_list(tv_shows: list[dict], dry_run: bool = False) -> tuple[int, int]:
    """Process a list of TV shows. Returns (processed, skipped) counts."""
    processed = 0
    skipped = 0

    for show in tv_shows:
        if not dry_run:
            _consume_targeted_retries()
        parse_name = show["parse_name"]
        tv_info = show["tv_info"]

        # Already skipped in watch mode. Skip before OMDb lookups so polling
        # does not repeatedly query the same unprocessable source item.
        if parse_name in _watch_skip_logged and not _targeted_retry_item(show, dry_run):
            skipped += 1
            continue

        title = tv_info.get("title")
        if not title:
            if parse_name not in _watch_skip_logged or _targeted_retry_item(show, dry_run):
                log.info("")
                log.info(f"[TV] Found: {parse_name}")
                log.info(f"SKIP: Could not parse title from: {parse_name}")
                _watch_skip_logged.add(parse_name)
            skipped += 1
            _complete_targeted_retry(show, dry_run)
            continue

        season = tv_info.get("season") if tv_info.get("season") is not None else 1
        episode = tv_info.get("episode")

        # PTN returns lists for multi-season/episode packs (e.g. "Season 1-12")
        if isinstance(season, list):
            season = season[0]
        if isinstance(episode, list):
            episode = episode[0]

        # Query OMDb for series
        try:
            series_info = query_omdb_series(title, tv_info.get("year"))
        except OMDbUnavailableError as error:
            _wait_for_omdb(parse_name, error)
            skipped += 1
            continue
        if not series_info:
            if parse_name not in _watch_skip_logged or _targeted_retry_item(show, dry_run):
                ep_str = f"{episode:02d}" if episode else "??"
                log.info("")
                log.info(f"[TV] Found: {parse_name}")
                log.info(f"  Parsed: title='{title}', S{season:02d}E{ep_str}")
                log.info(f"SKIP: No OMDb match for series: {title}")
                _watch_skip_logged.add(parse_name)
            skipped += 1
            _complete_targeted_retry(show, dry_run)
            continue

        ep_str = f"{episode:02d}" if episode else "??"
        log.info("")
        log.info(f"[TV] Found: {parse_name}")
        log.info(f"  Parsed: title='{title}', S{season:02d}E{ep_str}")
        log.info(f"  OMDb match: {series_info['title']} ({series_info['year']})")

        # Move the TV show. Episode titles come from OMDb; if it cannot be asked, the pack
        # waits (nothing has moved yet) rather than being filed without titles for good.
        try:
            moved = move_tv_show(show, series_info, dry_run=dry_run)
        except OMDbUnavailableError as error:
            _wait_for_omdb(parse_name, error)
            skipped += 1
            continue
        if moved:
            processed += 1
        else:
            _watch_skip_logged.add(parse_name)
            skipped += 1
        _complete_targeted_retry(show, dry_run)

    return processed, skipped


def process_all(quiet: bool = False, dry_run: bool = False) -> tuple[int, int, int, int]:
    """Process all media in source directory. Returns (movies_processed, movies_skipped, tv_processed, tv_skipped)."""
    if not quiet:
        log.info(f"Scanning {config.SOURCE_DIR}...")
        if dry_run:
            log.info("=== DRY RUN MODE - No files will be moved ===")

    if not dry_run:
        _consume_targeted_retries()
    movies, tv_shows = find_media_in_source()
    # Single episodes should not wait behind a multi-season copy.
    tv_shows.sort(key=lambda item: len(item.get("video_files", [item["path"]])))

    # Prune _watch_skip_logged: remove entries for files no longer in source
    current_names = {m["parse_name"] for m in movies} | {t["parse_name"] for t in tv_shows}
    stale = _watch_skip_logged - current_names
    _watch_skip_logged.difference_update(stale)

    movies_processed = 0
    movies_skipped = 0
    tv_processed = 0
    tv_skipped = 0

    try:
        if movies:
            movies_processed, movies_skipped = process_movies_list(movies, dry_run)

        if tv_shows:
            tv_processed, tv_skipped = process_tv_shows_list(tv_shows, dry_run)

        if not movies and not tv_shows:
            if not quiet:
                log.info("No media found.")
    except OMDbRateLimitError as e:
        log.error(f"ABORTING: {e}")
        log.error("Partial progress has been saved. Re-run once the API limit resets.")
    except OMDbUnavailableError as e:
        log.error(f"ABORTING: OMDb is not responding ({e}). Progress has been saved; re-run later.")

    total_processed = movies_processed + tv_processed
    total_skipped = movies_skipped + tv_skipped

    if total_processed > 0:
        prefix = "[DRY RUN] " if dry_run else ""
        log.info("")
        log.info(f"{prefix}Scan complete. Movies: {movies_processed}/{movies_processed + movies_skipped}, "
                 f"TV: {tv_processed}/{tv_processed + tv_skipped}")
        log.info("=" * 60)
    elif not quiet and total_skipped > 0:
        # Only show summary on manual runs, not in watch mode
        prefix = "[DRY RUN] " if dry_run else ""
        log.info("")
        log.info(f"{prefix}Scan complete. Movies: {movies_processed}/{movies_processed + movies_skipped}, "
                 f"TV: {tv_processed}/{tv_processed + tv_skipped}")
        log.info("=" * 60)

    return movies_processed, movies_skipped, tv_processed, tv_skipped


def run_once(dry_run: bool = False) -> None:
    """Run the renamer once."""
    process_all(quiet=False, dry_run=dry_run)


def run_watch() -> None:
    """Run the renamer in watch mode."""
    global _retry_queue
    from organizer_retry_spool import RetrySpool
    try:
        _retry_queue = RetrySpool(config.SOURCE_DIR,
            os.environ.get("ORGANIZER_RETRY_DIR") or Path(__file__).resolve().parent.parent / "data" / "organizer-retries", log=log)
    except (OSError, ValueError):
        log.warning("[Retry] Targeted retry queue unavailable; normal imports continue")
        _retry_queue = None
    log.info(f"Watching {config.SOURCE_DIR} (polling every {config.POLL_INTERVAL}s)")
    log.info("Press Ctrl+C to stop")

    start_status()
    last_heartbeat = time.time()
    scans = imported = 0

    try:
        while True:
            _activity("scanning")
            begun = time.time()
            movies_done, _, tv_done, _ = process_all(quiet=True)
            scans += 1
            imported += movies_done + tv_done
            if _status is not None:
                _status.update(scans=scans, lastScan={"at": int(time.time() * 1000),
                                                      "ms": int((time.time() - begun) * 1000), "imported": movies_done + tv_done})
            _activity("idle")

            # The status file carries liveness, so the log line is only a courtesy once an hour. If the
            # file cannot be written, the line stays every 5 minutes: it is then the only signal.
            heartbeat_interval = 3600 if _status is not None and _status.healthy else 300
            if time.time() - last_heartbeat >= heartbeat_interval:
                log.info("Still watching... %d scan%s, %d import%s since start", scans, "" if scans == 1 else "s",
                         imported, "" if imported == 1 else "s")
                last_heartbeat = time.time()

            time.sleep(config.POLL_INTERVAL)
    except KeyboardInterrupt:
        log.info("Watch mode stopped.")
    finally:
        stop_status()
        if _retry_queue is not None:
            _retry_queue.close()
            _retry_queue = None


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Rename and organize movies and TV shows from download folder to library."
    )
    parser.add_argument(
        "--watch", "-w",
        action="store_true",
        help=f"Run in watch mode, scanning every {config.POLL_INTERVAL} seconds",
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Preview what would happen without moving any files",
    )
    parser.add_argument(
        "--library", "-l",
        action="store_true",
        help="Scan and rename existing movie library folders to proper naming format",
    )
    parser.add_argument(
        "--library-tv",
        action="store_true",
        help="Scan and rename existing TV show library folders and episodes",
    )
    parser.add_argument(
        "--all", "-a",
        action="store_true",
        help="Scan and rename both movie and TV libraries at once",
    )
    parser.add_argument(
        "--library-reset",
        choices=["movies", "tv", "all"],
        help="Clear library progress tracking so folders are re-processed from scratch",
    )
    args = parser.parse_args()
    setup_logging()

    # Loud warning if the OMDb key is missing — without it every lookup 401s
    # and content is silently SKIP'd. (June 2026: a wrapper launch with no
    # EnvironmentFile ran for days with an empty key before anyone noticed.)
    if not config.OMDB_API_KEY:
        log.warning("=" * 60)
        log.warning("OMDB_API_KEY is empty — every OMDb lookup will return 401")
        log.warning("and titles will be SKIP'd. Check media-organizer/.env")
        log.warning("=" * 60)

    # Library reset mode
    if args.library_reset:
        clear_library_progress(args.library_reset)
        return

    if args.watch and args.dry_run:
        log.error("Cannot combine --watch and --dry-run")
        return

    if args.watch and (args.library or args.library_tv or args.all):
        log.error("Cannot combine --watch and --library/--library-tv/--all")
        return

    # Library mode - process existing libraries (can run both together)
    if args.all or args.library or args.library_tv:
        if args.all or args.library:
            process_library(dry_run=args.dry_run)
        if args.all or args.library_tv:
            process_tv_library(dry_run=args.dry_run)
        return

    # Normal mode - verify directories exist
    if not Path(config.SOURCE_DIR).exists():
        log.error(f"Source directory does not exist: {config.SOURCE_DIR}")
        return

    # Create primary destination dirs if needed
    if not Path(config.MOVIE_DEST_DIR).exists():
        log.info(f"Creating movie destination directory: {config.MOVIE_DEST_DIR}")
        Path(config.MOVIE_DEST_DIR).mkdir(parents=True, exist_ok=True)

    if not Path(config.TV_DEST_DIR).exists():
        log.info(f"Creating TV destination directory: {config.TV_DEST_DIR}")
        Path(config.TV_DEST_DIR).mkdir(parents=True, exist_ok=True)

    # Log which additional drives are available
    for drive_dir in config.MOVIE_DEST_DIRS:
        if drive_dir != config.MOVIE_DEST_DIR and Path(drive_dir).exists():
            log.info(f"Additional movie drive available: {drive_dir}")
    for drive_dir in config.TV_DEST_DIRS:
        if drive_dir != config.TV_DEST_DIR and Path(drive_dir).exists():
            log.info(f"Additional TV drive available: {drive_dir}")

    if not args.dry_run:
        start_inflight_journal()
        start_omdb_state()
    if args.watch:
        run_watch()
    else:
        run_once(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
