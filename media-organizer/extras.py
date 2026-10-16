"""Bonus material inside a TV pack: featurettes, deleted scenes, promos.

The organizer used to leave these in the download folder for good. One Narcos pack kept
twelve of them, so the folder never went away and every restart reported them again. They
are now filed under "<Series (Year)>/Extras/", a folder name the library scanner skips
(SKIP_DIRS in server.js), so they are kept, out of the way, and never mistaken for episodes.

This module only decides names and eligibility. The files themselves are moved by the
organizer's normal safe import, which never overwrites anything.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

EXTRAS_DIR = "Extras"

# A file much bigger than the pack's episodes is more likely a separate film than bonus material.
OVERSIZE_FACTOR = 1.5

_SEASON_FOLDER = re.compile(r"(?:Season|S)\s*(\d+)", re.I)     # the shapes resolve_tv_file understands
_SAMPLE = re.compile(r"(?<![a-z0-9])samples?(?![a-z0-9])", re.I)
_YEAR = re.compile(r"(?<![0-9])((?:19|20)[0-9]{2})(?![0-9])")
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_MAX_NAME_BYTES = 240                                            # 255 on most filesystems, with room to spare


def series_start(text) -> int | None:
    """The year a series began (the organizer is given the start year, "2015", not the run)."""
    found = _YEAR.search(str(text or ""))
    return int(found.group(1)) if found else None


def is_sample(source: Path, root: Path) -> bool:
    relative = source.relative_to(root)
    return any(_SAMPLE.search(part) for part in (*relative.parts[:-1], source.stem))


def foreign_years(stem: str, start: int | None) -> list[int]:
    """Years named in the file that are from before the series began (one year earlier is allowed).

    A film from 2008 in the pack of a series that began in 2015 is a different title, not bonus
    material. Later years are fine: a reunion or a panel is a normal extra. Without a start year
    nothing can be compared, so any year in the name is a reason to look."""
    named = sorted({int(year) for year in _YEAR.findall(stem)})
    return named if start is None else [year for year in named if year < start - 1]


def decline_reason(source: Path, root: Path, start, largest_episode, size_of) -> str | None:
    """Why this file should not be filed as an extra (None means it may be)."""
    if is_sample(source, root):
        return "it looks like a sample"
    try:
        size = size_of(source)
    except OSError:
        return "it could not be read"
    if size <= 0:
        return "it is empty"
    if largest_episode and size > largest_episode * OVERSIZE_FACTOR:
        return "it is much larger than the episodes, so it may be a separate film"
    years = foreign_years(source.stem, start)
    if years:
        return f"its name mentions {', '.join(map(str, years))}, from before the series began"
    return None


def _clean(part: str) -> str:
    part = _ILLEGAL.sub("", part)
    return re.sub(r"\s+", " ", part).strip(" .")


def _clean_name(name: str) -> str:
    """The file name without characters a filesystem dislikes; empty when nothing but the extension is left."""
    stem, extension = os.path.splitext(name)
    stem = _clean(stem)
    return stem + extension.lower() if stem else ""


def _fit(name: str) -> str:
    if len(name.encode()) <= _MAX_NAME_BYTES:
        return name
    stem, extension = os.path.splitext(name)
    while stem and len((stem + extension).encode()) > _MAX_NAME_BYTES:
        stem = stem[:-1]
    return (stem.rstrip(" .") + extension) if stem else ""


def destination_parts(source: Path, root: Path, pack_season=None) -> tuple[str, ...]:
    """Where a file goes below Extras/: its folders in the pack, then its name.

    A season folder ("Season 2") is not kept as a folder; it becomes a "Season 02 - " prefix on
    the name, so the same title from two seasons ("Behind the Scenes") cannot collide. A pack for
    a single season gives the same prefix. Empty means no usable name could be made."""
    *folders, name = source.relative_to(root).parts
    season = None
    keep = []
    for folder in folders:
        match = _SEASON_FOLDER.fullmatch(folder)
        if match:
            season = int(match.group(1))
        elif folder.lower() != EXTRAS_DIR.lower():
            keep.append(folder)
    if season is None and isinstance(pack_season, int):
        season = pack_season
    name = _clean_name(name)
    if name and season is not None and not re.match(rf"season\s*0*{season}(?![0-9])", name, re.I):
        name = f"Season {season:02d} - {name}"
    parts = [_clean(folder) for folder in keep] + [_fit(name) if name else ""]
    return tuple(parts) if all(parts) else ()


def choose_extras(root: Path, candidates, *, series_year, largest_episode=None, pack_season=None,
                  size_of=lambda path: path.stat().st_size):
    """Split candidate files into (filed, declined): [(source, parts)] and [(source, reason)]."""
    start = series_start(series_year)
    filed, declined = [], []
    for source in candidates:
        reason = decline_reason(source, root, start, largest_episode, size_of)
        parts = () if reason else destination_parts(source, root, pack_season)
        if reason:
            declined.append((source, reason))
        elif not parts:
            declined.append((source, "no usable file name could be made from it"))
        else:
            filed.append((source, parts))
    return filed, declined


def pair_subtitles(filed, subtitles, language_of):
    """Subtitles that belong to a filed extra: same folder, same name apart from the language tag.

    Returns [(subtitle, parts)] with the tag kept ("Deleted Scenes.eng.srt" follows "Deleted Scenes.mkv")."""
    by_name = {(source.parent, source.stem.casefold()): parts for source, parts in filed}
    paired = []
    for subtitle in subtitles:
        tag = language_of(subtitle.stem)
        base = subtitle.stem[:-len(tag)] if tag and subtitle.stem.casefold().endswith(tag) else subtitle.stem
        parts = by_name.get((subtitle.parent, base.casefold()))
        if parts:
            paired.append((subtitle, (*parts[:-1], f"{Path(parts[-1]).stem}{tag}{subtitle.suffix.lower()}")))
    return paired


def series_has_episodes(base: Path) -> bool:
    """True when the library already holds episodes of this series ("Season NN" with a video in it)."""
    try:
        with os.scandir(base) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False) and re.fullmatch(r"Season\s*\d+", entry.name, re.I):
                    with os.scandir(entry.path) as inner:
                        if any(item.is_file(follow_symlinks=False) and item.name[:1] != "." for item in inner):
                            return True
    except OSError:
        return False
    return False
