"""Crash-safe, never-overwrite file import for the organizer.

The old import wrote straight to the final filename. A crash, power cut or USB
hiccup halfway through a multi-GB copy therefore left a truncated file with the
real name in the library -- where the scanner could index it -- and every retry
then failed as a "Destination conflict" forever.

Now the copy is written to a hidden sibling (".<name>.organizer-part"), verified,
and only then published under the real name with a hard link, which refuses to
replace an existing file. A crash can only ever leave the hidden part-file, which a
small journal lets the next start clean up.
"""
import errno
import hashlib
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger(__name__)

PART_SUFFIX = ".organizer-part"
SAMPLE_BYTES = 1024 * 1024
# link() fails with these when it cannot join two paths (other drive, odd filesystem).
_LINK_UNSUPPORTED = (errno.EXDEV, errno.EPERM, errno.EOPNOTSUPP, errno.ENOSYS)


def part_path(destination: Path) -> Path:
    """The hidden sibling a copy is written to. The library scanner ignores it: it is
    a dotfile and its extension is not a media type."""
    return destination.with_name("." + destination.name + PART_SUFFIX)


def sample_digest(path: Path, size: int) -> str:
    """Hash of the size plus the first, middle and last MiB.

    Cheap even for a 20 GB file, and enough to catch the failures that matter here: a
    short write, a zero-filled tail, a copy of the wrong file. It is not a full
    checksum, and does not claim to be."""
    digest = hashlib.sha256(str(size).encode())
    offsets = sorted({0, max(0, size // 2 - SAMPLE_BYTES // 2), max(0, size - SAMPLE_BYTES)})
    with path.open("rb") as handle:
        for offset in offsets:
            handle.seek(offset)
            digest.update(handle.read(SAMPLE_BYTES))
    return digest.hexdigest()


class InflightJournal:
    """Remembers which part-files are being written, so a crash cannot leak them.

    Deliberately forgiving: it must never be the reason an import fails."""

    def __init__(self, path):
        self.path = Path(path)

    def _read(self) -> list:
        try:
            data = json.loads(self.path.read_text())
            parts = data.get("parts", []) if isinstance(data, dict) else []
            return [str(p) for p in parts if isinstance(p, str)]
        except (OSError, ValueError):
            return []

    def _write(self, parts: list) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle, name = tempfile.mkstemp(prefix=".inflight-", dir=self.path.parent)
            with os.fdopen(handle, "w") as out:
                json.dump({"parts": sorted(set(parts))}, out)
            os.replace(name, self.path)
        except OSError as error:
            log.warning("Could not update the in-flight journal (%s); imports continue", error)

    def add(self, part: Path) -> None:
        self._write(self._read() + [str(part)])

    def discard(self, part: Path) -> None:
        remaining = [p for p in self._read() if p != str(part)]
        if remaining != self._read():
            self._write(remaining)

    def recover(self) -> list:
        """Delete part-files an interrupted run left behind. Returns what was removed.

        Only regular files whose name is exactly a part-file are ever touched, whatever
        the journal says."""
        removed = []
        for name in self._read():
            path = Path(name)
            try:
                if path.name.startswith(".") and path.name.endswith(PART_SUFFIX) \
                        and path.is_file() and not path.is_symlink():
                    path.unlink()
                    removed.append(path)
                    log.info("Removed an interrupted copy left by an earlier run: %s", path)
            except OSError as error:
                log.warning("Could not remove leftover %s: %s", path, error)
        if self._read():
            self._write([])
        return removed


def _remove_part(part: Path, journal: Optional[InflightJournal]) -> None:
    try:
        part.unlink(missing_ok=True)
    except OSError as error:
        log.warning("Could not remove %s: %s", part, error)
    if journal is not None:
        journal.discard(part)


def _publish(part: Path, destination: Path) -> None:
    """Give a verified part-file its real name without ever replacing a file."""
    try:
        os.link(part, destination)           # atomic; raises FileExistsError rather than replacing
    except OSError as error:
        if error.errno not in _LINK_UNSUPPORTED:
            raise
        # No hard links here. Check, then rename; only the instant between the two can race.
        if os.path.lexists(destination):
            raise FileExistsError(errno.EEXIST, "Destination already exists", str(destination))
        os.rename(part, destination)
        return
    os.unlink(part)


def _copy_into_place(source: Path, destination: Path, part: Path, before: os.stat_result,
                     journal: Optional[InflightJournal]) -> None:
    size = before.st_size
    if part.exists() or part.is_symlink():   # a crashed run's leftover; one organizer runs at a time
        part.unlink()
    if journal is not None:
        journal.add(part)
    with source.open("rb") as src, part.open("xb") as dst:
        shutil.copyfileobj(src, dst, 1024 * 1024)
        dst.flush()
        os.fsync(dst.fileno())
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise OSError("Source changed during import; left for review")
    if part.stat().st_size != size:
        raise OSError("Incomplete destination copy")
    if sample_digest(part, size) != sample_digest(source, size):
        raise OSError("Copy does not match the source")
    shutil.copystat(source, part)            # so the file appears with its real timestamps
    _publish(part, destination)
    if journal is not None:
        journal.discard(part)


def import_file(source: Path, destination: Path, journal: Optional[InflightJournal] = None,
                before_unlink: Optional[Callable[[], None]] = None) -> None:
    """Move source to destination without ever replacing destination.

    On any failure the source is untouched and nothing is left at the destination."""
    if source.is_symlink() or not source.is_file():
        raise ValueError("Source must be a regular file")
    before = source.stat()
    destination.parent.mkdir(parents=True, exist_ok=True)
    published = False
    part = part_path(destination)
    try:
        try:
            # Same filesystem: publish a link without copying gigabytes. link() refuses
            # an existing destination, so this can never replace anything.
            os.link(source, destination)
            published = True
        except OSError as error:
            if error.errno not in _LINK_UNSUPPORTED:
                raise
            _copy_into_place(source, destination, part, before, journal)
            published = True
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise OSError("Source changed during import; left for review")
        if destination.stat().st_size != before.st_size:
            raise OSError("Incomplete destination copy")
        shutil.copystat(source, destination)
        if before_unlink is not None:
            before_unlink()
        source.unlink()
    except BaseException:                     # includes Ctrl-C / a clean shutdown request
        if published:
            destination.unlink(missing_ok=True)
        _remove_part(part, journal)
        raise
