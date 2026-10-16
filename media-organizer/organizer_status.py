"""The organizer's live status, for the Organizer page.

One small JSON file, rewritten atomically. The page used to judge "is it alive?" from a
"Still watching..." log line every five minutes, which goes missing while a long copy blocks
the main loop and made a busy organizer look stuck. A background thread rewrites this file
every few seconds whatever the main loop is doing; the loop only says what it is doing now.

The media server reads the file as another user, through the data folder's default ACL.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

VERSION = 1


class StatusFile:
    def __init__(self, path, *, clock=time.time, interval: float = 30.0):
        self.path = Path(path) if path else None
        self.interval = interval
        self.healthy = self.path is not None     # False once the file cannot be written
        self._clock = clock
        self._lock = threading.Lock()
        self._providers = []
        self._stop = threading.Event()
        self._thread = None
        self._warned = False
        now = self._ms()
        self._doc = {"version": VERSION, "pid": os.getpid(), "startedAt": now, "scans": 0,
                     "activity": {"state": "starting", "detail": "", "since": now}}

    def _ms(self) -> int:
        return int(self._clock() * 1000)

    def _warn(self, message: str) -> None:       # replaced by the organizer with its logger
        print(f"[organizer] {message}", flush=True)

    def update(self, **fields) -> None:
        with self._lock:
            self._doc.update(fields)

    def activity(self, state: str, detail: str = "") -> None:
        self.update(activity={"state": state, "detail": detail, "since": self._ms()})

    def add_provider(self, provider) -> None:
        """A function returning fields to merge in at write time (live numbers, not snapshots)."""
        self._providers.append(provider)

    def write(self) -> bool:
        if self.path is None:
            return False
        extra = {}
        for provider in self._providers:
            try:
                extra.update(provider() or {})
            except Exception:                    # a broken provider costs only its own fields
                pass
        with self._lock:
            document = {**self._doc, **extra, "updatedAt": self._ms()}
        temporary = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(document, handle)
            # Explicit: under a strict umask the data folder's default ACL would otherwise
            # mask the media server out of a file that was created 0600.
            os.chmod(temporary, 0o644)
            os.replace(temporary, self.path)
        except OSError as error:
            self.healthy = False
            if not self._warned:
                self._warned = True
                self._warn(f"cannot write the status file {self.path}: {error}; the log heartbeat continues")
            try:
                temporary.unlink()
            except OSError:
                pass
            return False
        self.healthy = True
        return True

    def start(self) -> None:
        """Write now, then keep rewriting in the background until stop()."""
        self.write()
        if self.path is None or self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._beat, name="organizer-status", daemon=True)
        self._thread.start()

    def _beat(self) -> None:
        while not self._stop.wait(self.interval):
            self.write()

    def stop(self, final: str | None = None) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=5)
        if final:
            self.activity(final)
            self.write()
