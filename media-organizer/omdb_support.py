"""OMDb plumbing for the organizer: honest failures, a persistent episode-title cache,
a call counter, and log redaction.

Why this exists. A failed request used to come back as "no match". The movie lookup then
tried every other spelling (each waiting out a 10 s timeout), remembered the title as
"no match" for 24 h, and put the release on the do-not-look-again list until the next
restart, so a short OMDb outage made the organizer give up on perfectly good releases
(Scream 7 sat skipped across the whole 04-28 .. 05-02 outage). The raw request error was
also logged, URL and API key included (44 lines in the rotated logs hold the real key).
"""
import json
import logging
import os
import re
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import requests

log = logging.getLogger(__name__)


class OMDbUnavailableError(Exception):
    """OMDb could not be asked: timeout, connection failure, server error, unreadable reply.

    It says nothing about whether the title exists. Callers must leave the release for the
    next scan, never conclude "no match" and never remember one."""


# ── never let the API key reach a log ────────────────────────────────────────

_KEY = re.compile(r"(?i)(apikey=)[^&\s'\"<>)]*")


def redact(text) -> str:
    return _KEY.sub(r"\1<hidden>", str(text))


class RedactingFilter(logging.Filter):
    """Defence in depth: whatever a library puts in a log line, the key is removed."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        cleaned = redact(message)
        if cleaned != message:
            record.msg, record.args = cleaned, ()
        return True


def describe_request_error(error: BaseException) -> str:
    """A short, URL-free description of a failed request."""
    if isinstance(error, requests.Timeout):
        return "timed out"
    if isinstance(error, requests.ConnectionError):
        return "connection failed"
    status = getattr(getattr(error, "response", None), "status_code", None)
    if isinstance(status, int):
        return f"HTTP {status}"
    if isinstance(error, ValueError):
        return "unreadable reply"   # e.g. an HTML error page where JSON was expected
    return type(error).__name__


# ── back off instead of hammering a service that is down ─────────────────────

class Backoff:
    """Exponential delay between attempts after failures: 20 s, 40 s ... capped at 5 min."""

    def __init__(self, base: float = 20, cap: float = 300, clock=time.monotonic):
        self.base, self.cap, self.clock = base, cap, clock
        self.failures = 0
        self.until = 0.0

    def blocked(self) -> bool:
        return self.clock() < self.until

    def remaining(self) -> float:
        return max(0.0, self.until - self.clock())

    def failed(self) -> None:
        self.failures += 1
        self.until = self.clock() + min(self.cap, self.base * 2 ** (self.failures - 1))

    def succeeded(self) -> None:
        self.failures = 0
        self.until = 0.0

    def hold(self, seconds: float) -> None:
        """Stay away for a fixed time (the daily limit is used up: asking again is pointless)."""
        self.failures = max(self.failures, 1)
        self.until = max(self.until, self.clock() + seconds)


# ── persisted state ──────────────────────────────────────────────────────────

def _write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(handle, "w") as out:
            json.dump(value, out)
        os.replace(name, path)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def _read_json(path: Optional[Path], default):
    if path is None:
        return default
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


PLACEHOLDER_TITLE = re.compile(r"^Episode\s+#?\d+(?:\.\d+)?$")


def parse_season(data: dict, today: Optional[date] = None):
    """(episodes {number: title}, finished) from an OMDb ?Season=N reply.

    finished means every episode has a real title and an air date in the past, so the
    season will not change and can be cached for months rather than a day."""
    today = today or datetime.now(timezone.utc).date()
    rows = data.get("Episodes") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return {}, False
    episodes, finished = {}, bool(rows)
    for row in rows:
        if not isinstance(row, dict):
            finished = False
            continue
        number = str(row.get("Episode", "")).strip()
        title = row.get("Title")
        released = str(row.get("Released", "")).strip()
        real = isinstance(title, str) and title.strip() and title != "N/A" and not PLACEHOLDER_TITLE.match(title.strip())
        if number.isdigit() and real:
            episodes[int(number)] = title.strip()
        else:
            finished = False
        try:
            if date.fromisoformat(released) > today:
                finished = False
        except ValueError:
            finished = False
    return episodes, finished


class SeasonCache:
    """Episode titles per (series, season), so a 134-episode pack costs a handful of OMDb
    requests instead of 134. Memory-only unless given a path (tests never write to disk)."""

    FINISHED_TTL = 90 * 86400     # a finished season does not change
    ONGOING_TTL = 86400           # a running season gains titles and episodes
    MAX_SEASONS = 2000

    def __init__(self, path=None, clock=time.time):
        self.path = Path(path) if path else None
        self.clock = clock
        stored = _read_json(self.path, {})
        seasons = stored.get("seasons") if isinstance(stored, dict) else None
        self.seasons = seasons if isinstance(seasons, dict) else {}

    def get(self, key: str) -> Optional[dict]:
        entry = self.seasons.get(key)
        if not isinstance(entry, dict):
            return None
        ttl = self.FINISHED_TTL if entry.get("finished") else self.ONGOING_TTL
        if self.clock() - float(entry.get("fetchedAt", 0)) > ttl:
            return None
        episodes = entry.get("episodes")
        if not isinstance(episodes, dict):
            return None
        return {int(number): title for number, title in episodes.items() if str(number).isdigit()}

    def put(self, key: str, episodes: dict, finished: bool) -> None:
        self.seasons[key] = {"fetchedAt": self.clock(), "finished": bool(finished),
                             "episodes": {str(number): title for number, title in episodes.items()}}
        if len(self.seasons) > self.MAX_SEASONS:
            for stale in sorted(self.seasons, key=lambda k: self.seasons[k].get("fetchedAt", 0))[:len(self.seasons) - self.MAX_SEASONS]:
                del self.seasons[stale]
        self._save()

    def _save(self) -> None:
        if self.path is None:
            return
        try:
            _write_json(self.path, {"version": 1, "seasons": self.seasons})
        except OSError as error:
            log.warning("Could not save the episode-title cache (%s); it will be rebuilt", error)


class UsageCounter:
    """OMDb requests made per UTC day. The free key allows 1,000 a day, and running out
    silently turned into skipped releases, so the count is worth seeing."""

    def __init__(self, path=None, clock=time.time):
        self.path = Path(path) if path else None
        self.clock = clock
        stored = _read_json(self.path, {})
        days = stored.get("days") if isinstance(stored, dict) else None
        self.days = days if isinstance(days, dict) else {}

    def _today(self) -> str:
        return datetime.fromtimestamp(self.clock(), timezone.utc).strftime("%Y-%m-%d")

    def hit(self) -> int:
        today = self._today()
        self.days[today] = int(self.days.get(today, 0)) + 1
        for old in sorted(self.days)[:-7]:
            del self.days[old]
        if self.path is not None:
            try:
                _write_json(self.path, {"version": 1, "days": self.days})
            except OSError:
                pass
        return self.days[today]

    def today(self) -> int:
        return int(self.days.get(self._today(), 0))
