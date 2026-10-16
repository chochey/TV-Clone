"""safe_copy: a crash or failure can never leave a truncated file under the real name."""
import errno
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import safe_copy

REAL_LINK = os.link
REAL_COPY = shutil.copyfileobj


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.src_dir, self.lib = self.root / "downloads", self.root / "library"
        self.src_dir.mkdir()
        self.lib.mkdir()
        self.journal = safe_copy.InflightJournal(self.root / "inflight.json")

    def make(self, name="movie.mkv", data=b"movie data"):
        path = self.src_dir / name
        path.write_bytes(data)
        return path

    def other_drive(self, source):
        """Linking *from the download folder* fails, as it does between two drives; linking
        inside the library (publishing a part-file) still works."""
        def link(a, b, **kwargs):
            if Path(a) == source:
                raise OSError(errno.EXDEV, "different drive")
            return REAL_LINK(a, b, **kwargs)
        return mock.patch.object(os, "link", side_effect=link)

    def names(self):
        return sorted(p.name for p in self.lib.rglob("*"))

    def parts_listed(self):
        return self.journal._read()


class NormalImports(Base):
    def test_same_drive_import_links_without_copying(self):
        src = self.make()
        dst = self.lib / "Movie (2020)" / "Movie (2020).mkv"
        with mock.patch.object(shutil, "copyfileobj", side_effect=AssertionError("unneeded copy")):
            safe_copy.import_file(src, dst, self.journal)
        self.assertFalse(src.exists())
        self.assertEqual(dst.read_bytes(), b"movie data")
        self.assertEqual(self.names(), ["Movie (2020)", "Movie (2020).mkv"])
        self.assertEqual(self.parts_listed(), [])

    def test_cross_drive_copy_keeps_timestamps_and_leaves_no_part_file(self):
        src = self.make(data=os.urandom(300_000))
        os.utime(src, (1_700_000_000, 1_700_000_000))
        data = src.read_bytes()
        dst = self.lib / "Movie (2020).mkv"
        with self.other_drive(src):
            safe_copy.import_file(src, dst, self.journal)
        self.assertFalse(src.exists())
        self.assertEqual(dst.read_bytes(), data)
        self.assertEqual(int(dst.stat().st_mtime), 1_700_000_000, "the file must appear with its real mtime")
        self.assertEqual(self.names(), ["Movie (2020).mkv"], "no hidden part-file may remain")
        self.assertEqual(self.parts_listed(), [])

    def test_hard_links_unsupported_still_imports_by_rename(self):
        src = self.make()
        dst = self.lib / "Movie (2020).mkv"
        with mock.patch.object(os, "link", side_effect=OSError(errno.EPERM, "no hard links here")):
            safe_copy.import_file(src, dst, self.journal)
        self.assertEqual(dst.read_bytes(), b"movie data")
        self.assertEqual(self.names(), ["Movie (2020).mkv"])

    def test_rename_fallback_still_refuses_to_replace(self):
        src = self.make(data=b"new")
        dst = self.lib / "Movie (2020).mkv"
        dst.write_bytes(b"old")
        with mock.patch.object(os, "link", side_effect=OSError(errno.EPERM, "no hard links here")):
            with self.assertRaises(FileExistsError):
                safe_copy.import_file(src, dst, self.journal)
        self.assertEqual(dst.read_bytes(), b"old")
        self.assertEqual(src.read_bytes(), b"new")
        self.assertEqual(self.names(), ["Movie (2020).mkv"])

    def test_the_part_file_is_hidden_and_has_no_media_name(self):
        part = safe_copy.part_path(Path("/lib/Movie (2020)/Movie (2020).mkv"))
        self.assertEqual(part, Path("/lib/Movie (2020)/.Movie (2020).mkv.organizer-part"))
        self.assertEqual(part.suffix, ".organizer-part")

    def test_a_callback_runs_once_just_before_the_source_goes(self):
        src = self.make()
        seen = []
        safe_copy.import_file(src, self.lib / "a.mkv", self.journal, before_unlink=lambda: seen.append(src.exists()))
        self.assertEqual(seen, [True])

    def test_symlinks_and_missing_sources_are_refused(self):
        real = self.make()
        link = self.src_dir / "link.mkv"
        link.symlink_to(real)
        for source in (link, self.src_dir / "missing.mkv"):
            with self.assertRaises(ValueError):
                safe_copy.import_file(source, self.lib / "x.mkv", self.journal)


class FailuresLeaveNothingBehind(Base):
    def fails_with(self, mutate):
        """A copy that does `mutate(dst)` after copying, then lets the import continue."""
        def copy(fsrc, fdst, length=0):
            REAL_COPY(fsrc, fdst, length)
            fdst.flush()
            mutate(fdst)
        return mock.patch.object(shutil, "copyfileobj", side_effect=copy)

    def test_disk_full_mid_copy(self):
        src = self.make(data=b"x" * 5000)
        dst = self.lib / "Movie.mkv"
        def half_then_fail(fsrc, fdst, length=0):
            fdst.write(fsrc.read(2500))
            fdst.flush()
            raise OSError(errno.ENOSPC, "disk full")
        with self.other_drive(src), mock.patch.object(shutil, "copyfileobj", side_effect=half_then_fail):
            with self.assertRaises(OSError):
                safe_copy.import_file(src, dst, self.journal)
        self.assertEqual(src.read_bytes(), b"x" * 5000)
        self.assertEqual(self.names(), [], "neither the destination nor a part-file may remain")
        self.assertEqual(self.parts_listed(), [])

    def test_destination_appearing_mid_copy_is_never_overwritten(self):
        src = self.make(data=b"new")
        dst = self.lib / "Movie.mkv"
        with self.other_drive(src), self.fails_with(lambda fdst: dst.write_bytes(b"old")):
            with self.assertRaises(FileExistsError):
                safe_copy.import_file(src, dst, self.journal)
        self.assertEqual(dst.read_bytes(), b"old", "someone else's file is untouched")
        self.assertEqual(src.read_bytes(), b"new")
        self.assertEqual(self.names(), ["Movie.mkv"], "the part-file is cleaned up")

    def test_a_zero_filled_copy_is_rejected(self):
        src = self.make(data=b"precious movie bytes")
        dst = self.lib / "Movie.mkv"
        def zero(fdst):
            fdst.seek(0)
            fdst.write(b"\0" * len(b"precious movie bytes"))
        with self.other_drive(src), self.fails_with(zero):
            with self.assertRaisesRegex(OSError, "does not match"):
                safe_copy.import_file(src, dst, self.journal)
        self.assertEqual(src.read_bytes(), b"precious movie bytes")
        self.assertEqual(self.names(), [])

    def test_corruption_in_the_middle_of_a_large_file_is_caught(self):
        size = 3 * 1024 * 1024
        src = self.make(data=os.urandom(size))
        def flip_middle(fdst):
            fdst.seek(size // 2)
            fdst.write(b"\xff\xfe\xfd")
        with self.other_drive(src), self.fails_with(flip_middle):
            with self.assertRaisesRegex(OSError, "does not match"):
                safe_copy.import_file(src, self.lib / "Big.mkv", self.journal)
        self.assertEqual(self.names(), [])

    def test_a_short_copy_is_rejected(self):
        src = self.make(data=b"y" * 4000)
        with self.other_drive(src), self.fails_with(lambda fdst: fdst.truncate(3000)):
            with self.assertRaisesRegex(OSError, "Incomplete"):
                safe_copy.import_file(src, self.lib / "Movie.mkv", self.journal)
        self.assertEqual(self.names(), [])

    def test_source_changing_during_the_copy_is_rejected_and_not_deleted(self):
        src = self.make(data=b"z" * 4000)
        def source_grows(_fdst):
            with src.open("ab") as handle:
                handle.write(b"more")
        with self.other_drive(src), self.fails_with(source_grows):
            with self.assertRaisesRegex(OSError, "Source changed"):
                safe_copy.import_file(src, self.lib / "Movie.mkv", self.journal)
        self.assertTrue(src.exists(), "the source is left for review")
        self.assertEqual(self.names(), [], "the published copy is withdrawn")


class HardKill(Base):
    """The scenario the change exists for: the process dies mid-copy."""

    CHILD = r'''
import errno, os, shutil, signal, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
import safe_copy
src, dst, journal = Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
real_link = os.link
def link(a, b, **kw):
    if Path(a) == src:
        raise OSError(errno.EXDEV, "different drive")
    return real_link(a, b, **kw)
def dying_copy(fsrc, fdst, length=0):
    fdst.write(fsrc.read(1024 * 1024))
    fdst.flush()
    os.kill(os.getpid(), signal.SIGKILL)       # power cut / OOM kill / USB drive vanishing
os.link, shutil.copyfileobj = link, dying_copy
safe_copy.import_file(src, dst, journal=safe_copy.InflightJournal(journal))
'''

    def test_sigkill_mid_copy_never_leaves_a_file_under_the_real_name(self):
        src = self.make(data=os.urandom(4 * 1024 * 1024))
        dst = self.lib / "Movie (2020)" / "Movie (2020).mkv"
        journal_file = self.root / "inflight.json"
        done = subprocess.run([sys.executable, "-c", self.CHILD, str(HERE), str(src), str(dst), str(journal_file)])
        self.assertEqual(done.returncode, -signal.SIGKILL, "the child really was killed mid-copy")

        self.assertFalse(dst.exists(), "the real name must never hold a partial file")
        parts = [p for p in dst.parent.iterdir()]
        self.assertEqual([p.name for p in parts], [".Movie (2020).mkv.organizer-part"],
                         "only the hidden part-file is left, and the scanner ignores it")
        self.assertLess(parts[0].stat().st_size, src.stat().st_size, "it really is truncated")
        self.assertEqual(src.stat().st_size, 4 * 1024 * 1024, "the download is untouched")
        self.assertEqual(self.parts_listed(), [str(parts[0])], "and the journal knows about it")

        removed = safe_copy.InflightJournal(journal_file).recover()      # what the next start does
        self.assertEqual(removed, [parts[0]])
        self.assertEqual([p.name for p in dst.parent.iterdir()], [])
        self.assertEqual(self.parts_listed(), [])

        # The retry the old code could never complete ("Destination conflict" forever):
        with self.other_drive(src):
            safe_copy.import_file(src, dst, self.journal)
        self.assertEqual(dst.stat().st_size, 4 * 1024 * 1024)
        self.assertFalse(src.exists())

    def test_a_stale_part_file_is_simply_replaced_by_the_next_attempt(self):
        src = self.make(data=b"complete movie")
        dst = self.lib / "Movie.mkv"
        safe_copy.part_path(dst).write_bytes(b"junk from a crashed run")
        with self.other_drive(src):
            safe_copy.import_file(src, dst, self.journal)
        self.assertEqual(dst.read_bytes(), b"complete movie")
        self.assertEqual(self.names(), ["Movie.mkv"])


class Journal(Base):
    def test_survives_a_restart(self):
        part = self.lib / ".a.mkv.organizer-part"
        self.journal.add(part)
        self.assertEqual(safe_copy.InflightJournal(self.root / "inflight.json")._read(), [str(part)])
        self.journal.discard(part)
        self.assertEqual(self.parts_listed(), [])

    def test_recovery_only_ever_touches_real_part_files(self):
        precious = self.lib / "precious.mkv"
        precious.write_bytes(b"keep")
        hidden_but_not_a_part = self.lib / ".notes.mkv"
        hidden_but_not_a_part.write_bytes(b"keep")
        real_part = self.lib / ".a.mkv.organizer-part"
        real_part.write_bytes(b"partial")
        link_part = self.lib / ".b.mkv.organizer-part"
        link_part.symlink_to(precious)
        folder_part = self.lib / ".c.organizer-part"
        folder_part.mkdir()
        (self.root / "inflight.json").write_text(json.dumps({"parts": [
            str(precious), str(hidden_but_not_a_part), str(real_part), str(link_part), str(folder_part), "/etc/hostname"]}))
        removed = self.journal.recover()
        self.assertEqual(removed, [real_part])
        self.assertTrue(precious.exists() and hidden_but_not_a_part.exists() and folder_part.exists())
        self.assertTrue(link_part.is_symlink(), "a symlink is never followed or removed")
        self.assertTrue(Path("/etc/hostname").exists())

    def test_a_damaged_or_unwritable_journal_never_breaks_an_import(self):
        (self.root / "inflight.json").write_text("{ not json")
        self.assertEqual(self.journal.recover(), [])
        broken = safe_copy.InflightJournal("/proc/definitely/not/writable.json")
        broken.add(self.lib / ".x.organizer-part")               # must not raise
        src = self.make()
        with self.other_drive(src):
            safe_copy.import_file(src, self.lib / "ok.mkv", broken)
        self.assertEqual((self.lib / "ok.mkv").read_bytes(), b"movie data")


class SampleDigest(Base):
    def test_distinguishes_size_start_middle_and_end(self):
        size = 3 * 1024 * 1024
        base = os.urandom(size)
        original = self.make("a.bin", base)
        digest = safe_copy.sample_digest(original, size)
        for where in (0, size // 2, size - 1):
            tweaked = bytearray(base)
            tweaked[where] ^= 0xFF
            other = self.make("b.bin", bytes(tweaked))
            self.assertNotEqual(safe_copy.sample_digest(other, size), digest, f"byte {where}")
        self.assertEqual(safe_copy.sample_digest(self.make("c.bin", base), size), digest)

    def test_tiny_files_are_hashed_whole(self):
        a, b = self.make("a", b"abc"), self.make("b", b"abd")
        self.assertNotEqual(safe_copy.sample_digest(a, 3), safe_copy.sample_digest(b, 3))


if __name__ == "__main__":
    unittest.main()


class LogContract(Base):
    """Other parts of the app read these lines: lib/organizer-share.js pairs them to know what was
    imported, lib/organizer-watch.js rescans the library on "Moved ->", and the EVENT line says the
    same thing in one machine-readable piece."""

    def test_the_organizer_still_logs_the_source_then_the_move(self):
        import movie_renamer as m
        for label, drive in (("same drive", None), ("other drive", True)):
            with self.subTest(label):
                src = self.make(f"{label.replace(' ', '-')}.mkv")
                dst = self.lib / f"{label.replace(' ', '-')}" / "Movie (2020).mkv"
                with self.assertLogs("movie_renamer", level="INFO") as logs:
                    if drive:
                        with self.other_drive(src):
                            m.move_without_overwrite(src, dst)
                    else:
                        m.move_without_overwrite(src, dst)
                messages = [r.getMessage() for r in logs.records]
                self.assertEqual(messages[:2], [f"Import source: {src} -> {dst}", f"Moved -> {dst}"])
                self.assertEqual(len(messages), 3)
                self.assertTrue(messages[2].startswith("EVENT: "))
                self.assertEqual(json.loads(messages[2][len("EVENT: "):]),
                                 {"event": "moved", "release": src.name, "source": str(src), "destination": str(dst)})

    def test_a_failed_import_logs_no_move(self):
        import movie_renamer as m
        src = self.make()
        dst = self.lib / "Movie.mkv"
        dst.write_bytes(b"old")
        with self.assertLogs("movie_renamer", level="INFO") as logs, self.assertRaises(FileExistsError):
            m.log.info("start")
            m.move_without_overwrite(src, dst)
        self.assertFalse([r for r in logs.records if r.getMessage().startswith(("Moved ->", "Import source:", "EVENT:"))])
