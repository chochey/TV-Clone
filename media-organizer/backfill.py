"""Add episode titles to library file names, and keep subtitles attached to their videos.

The media server attaches an external subtitle to a video only when the subtitle's file name starts
with the video's name. So adding a title to a video means renaming its subtitles in the same step, and
a titled video whose subtitles never got the title (the importer used to leave them bare) is repaired
from the video's own name, with no lookup at all.

Everything here is a rename inside one folder: nothing is copied or deleted, a name that is already
taken is never replaced, and every rename is written to a journal as it happens so it can be undone.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import config
from titles import clean_episode_title

_EPISODE = re.compile(r"^(?P<show>.+?) - (?P<code>S(?P<season>\d{2,3})(?P<episodes>(?:E\d{2,3})+))(?P<title> - .+)?$", re.I)
_SEASON_FOLDER = re.compile(r"Season\s+\d+", re.I)
_SERIES_FOLDER = re.compile(r"(?P<title>.+?) \((?P<year>\d{4})\)")


@dataclass(frozen=True)
class Rename:
    source: Path
    destination: Path
    why: str                      # "title" (a video gained its title) or "subtitle" (a subtitle follows its video)


@dataclass
class Result:
    done: int = 0
    skipped: list = field(default_factory=list)      # [(path, reason)]
    applied: list = field(default_factory=list)      # the Rename objects that happened


@dataclass
class Summary:
    folders: int = 0
    titled: int = 0                                  # videos that gained (or would gain) a title
    subtitles: int = 0                               # subtitles renamed (or that would be) to follow their video
    planned: list = field(default_factory=list)      # every rename, for a preview
    applied: list = field(default_factory=list)      # every rename that was done
    unmatched: list = field(default_factory=list)    # series OMDb has no confident match for
    untitled: dict = field(default_factory=dict)     # series folder -> how many episodes OMDb has no usable title for
    notes: list = field(default_factory=list)        # what was left alone, and why
    skipped: list = field(default_factory=list)      # renames that could not be done


def _same_name(a: str, b: str) -> bool:
    def squash(text):
        return re.sub(r"[\W_]+", " ", text.casefold()).strip()
    return squash(a) == squash(b)


def series_identity(folder_name: str):
    """("Show Name", "2020") from a library folder called "Show Name (2020)"; None for anything else."""
    match = _SERIES_FOLDER.fullmatch(folder_name)
    if not match or "(" in match["title"] or ")" in match["title"]:
        return None
    return match["title"].strip(), match["year"]


def season_folders(roots):
    """(series folder, series title, season folder) for every "Show (Year)/Season NN" below the roots."""
    for root in roots:
        try:
            series_entries = sorted(os.scandir(root), key=lambda entry: entry.name)
        except OSError:
            continue
        for series in series_entries:
            identity = series_identity(series.name)
            if not identity or not series.is_dir(follow_symlinks=False):
                continue
            try:
                seasons = sorted(os.scandir(series.path), key=lambda entry: entry.name)
            except OSError:
                continue
            for season in seasons:
                if season.is_dir(follow_symlinks=False) and _SEASON_FOLDER.fullmatch(season.name):
                    yield Path(series.path), identity[0], Path(season.path)


def plan_folder(folder: Path, show: str, title_of, missing: list | None = None):
    """The renames one season folder needs, and notes about what was left alone.

    `title_of(season, episode)` returns the OMDb title for an episode or None. It is only asked for videos
    that have no title and are a single episode. Their codes ("S01E02") are added to `missing` when OMDb has
    nothing usable for them."""
    try:
        names = sorted(os.listdir(folder))
    except OSError as error:
        return [], [f"{folder.name}: cannot be read ({error})"]
    existing = {name.casefold() for name in names}
    videos, subtitles = {}, []
    for name in names:
        if name.startswith("."):
            continue
        stem, extension = os.path.splitext(name)
        extension = extension.lower()
        if extension in config.VIDEO_EXTENSIONS:
            match = _EPISODE.match(stem)
            if match and _same_name(match["show"], show):
                videos.setdefault(match["code"].casefold(), []).append((name, stem, extension, match))
        elif extension in config.SUBTITLE_EXTENSIONS:
            subtitles.append((name, stem, extension))

    renames, notes = [], []
    for group in videos.values():
        name, stem, extension, match = group[0]
        base_code = f"{match['show']} - {match['code']}"
        if len(group) > 1:
            notes.append(f"{folder.name}: {base_code}: more than one video for this episode; left alone")
            continue
        episodes = [int(number) for number in re.findall(r"E(\d{2,3})", match["episodes"], re.I)]
        planned = []
        if match["title"]:
            final_stem = stem                           # already titled: only its subtitles may need to follow
        else:
            final_stem = None
            if len(episodes) == 1:                      # a combined episode has no single title
                raw = title_of(int(match["season"]), episodes[0])
                cleaned = clean_episode_title(raw) if raw else ""
                if cleaned:
                    final_stem = f"{base_code} - {cleaned}"
                elif missing is not None:
                    missing.append(match["code"].upper())
            if final_stem is None:
                continue
            planned.append(Rename(folder / name, folder / (final_stem + extension), "title"))

        wanted = base_code.casefold()
        for sub_name, sub_stem, sub_extension in subtitles:
            lowered = sub_stem.casefold()
            if not lowered.startswith(wanted) or not (len(lowered) == len(wanted) or lowered[len(wanted)] == "."):
                continue                                # another episode, or one that already has its own title
            if lowered == final_stem.casefold() or lowered.startswith(final_stem.casefold() + "."):
                continue                                # attached already
            planned.append(Rename(folder / sub_name, folder / (final_stem + sub_stem[len(base_code):] + sub_extension), "subtitle"))

        taken, clash = set(), None
        for item in planned:
            key = item.destination.name.casefold()
            if key in existing or key in taken:
                clash = item.destination.name
                break
            taken.add(key)
        if clash:
            notes.append(f"{folder.name}: {base_code}: {clash} already exists; left alone")
        else:
            renames.extend(planned)
    return renames, notes


def _refusal(source: Path, destination: Path):
    if source.parent != destination.parent:
        return "a rename must stay in the same folder"
    if not source.is_file() or source.is_symlink():
        return "the file is no longer there"
    if os.path.lexists(destination):
        return "a file with the new name already exists"
    return None


def apply(renames, journal: Path, rename=os.rename) -> Result:
    """Do the renames, one at a time, writing each to the journal once it has happened."""
    result = Result()
    journal.parent.mkdir(parents=True, exist_ok=True)
    with open(journal, "a", encoding="utf-8") as log:
        for item in renames:
            problem = _refusal(item.source, item.destination)
            if problem:
                result.skipped.append((item.source, problem))
                continue
            try:
                rename(item.source, item.destination)
            except OSError as error:
                result.skipped.append((item.source, f"could not be renamed: {error}"))
                continue
            log.write(json.dumps({"from": str(item.source), "to": str(item.destination)}, ensure_ascii=False) + "\n")
            log.flush()
            result.done += 1
            result.applied.append(item)
    return result


def undo(journal: Path, rename=os.rename) -> Result:
    """Put names back, newest first, skipping anything that has changed since."""
    entries = []
    for line in Path(journal).read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("from"), str) and isinstance(entry.get("to"), str):
            entries.append(entry)
    result = Result()
    for entry in reversed(entries):
        current, original = Path(entry["to"]), Path(entry["from"])
        problem = _refusal(current, original)
        if problem:
            result.skipped.append((current, problem))
            continue
        try:
            rename(current, original)
        except OSError as error:
            result.skipped.append((current, f"could not be renamed: {error}"))
            continue
        result.done += 1
    return result


def run(roots, *, find_series, episode_title, apply_changes, journal: Path) -> Summary:
    """Walk the library; plan each season folder and, when asked, apply it before moving on.

    find_series(title, year) -> the series' OMDb info or None. episode_title(series, season, episode) -> a title
    or None. Both are asked only when a title-less video needs them. Whatever raises (OMDb being down) stops
    the walk: folders already done stay done, and are in the journal."""
    summary = Summary()
    matched = {}                                      # series folder -> OMDb info, or None

    for series_folder, title, season_folder in season_folders(roots):
        year = series_identity(series_folder.name)[1]

        def title_of(season, episode, _folder=series_folder, _title=title, _year=year):
            if _folder not in matched:
                matched[_folder] = find_series(_title, _year)
                if matched[_folder] is None:
                    summary.unmatched.append(_folder.name)
            series = matched[_folder]
            return episode_title(series, season, episode) if series else None

        missing = []
        renames, notes = plan_folder(season_folder, title, title_of, missing)
        if missing:
            summary.untitled[series_folder.name] = summary.untitled.get(series_folder.name, 0) + len(missing)
        summary.folders += 1
        summary.notes.extend(notes)
        if not renames:
            continue
        if apply_changes:
            result = apply(renames, journal)
            summary.skipped.extend(result.skipped)
            summary.applied.extend(result.applied)
            renames = result.applied
        else:
            summary.planned.extend(renames)
        summary.titled += sum(item.why == "title" for item in renames)
        summary.subtitles += sum(item.why == "subtitle" for item in renames)
    return summary
