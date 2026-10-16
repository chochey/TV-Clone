"""Importing the organizer must never write to the production log or a Desktop copy.

Before this, importing movie_renamer attached rotating file handlers to
media-organizer.log (and ~/Desktop/media-organizer.log), so every unit-test run put
fake imports, fake review items and "Moved -> /tmp/..." lines in the file the
Organizer page reads and the library-rescan trigger watches.
"""
import logging
import os
import site
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import movie_renamer as m


class ImportIsolation(unittest.TestCase):
    def test_importing_attaches_no_handlers_and_creates_no_desktop_log(self):
        with tempfile.TemporaryDirectory() as home:
            # HOME is redirected so a Desktop log would be visible, but Python's per-user
            # package folder (where PTN lives) is derived from HOME, so pin it.
            env = {**os.environ, "HOME": home, "PYTHONUSERBASE": site.getuserbase()}
            env.pop("ORGANIZER_PREVIEW", None)      # the old guard; the fix must not need it
            env.pop("ORGANIZER_DESKTOP_LOG", None)
            code = ("import logging, sys; sys.path.insert(0, %r); import movie_renamer; "
                    "print(sorted(type(h).__name__ for h in logging.getLogger().handlers))") % str(HERE)
            out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout.strip(), "[]", "a bare import must not attach any log handler")
            self.assertFalse((Path(home) / "Desktop" / "media-organizer.log").exists())


class SetupLogging(unittest.TestCase):
    def tearDown(self):
        self._drop()

    def _drop(self):
        root = logging.getLogger()
        for handler in list(root.handlers):
            if getattr(handler, m._OWN_HANDLER, False):
                root.removeHandler(handler)
                handler.close()

    def _file_handlers(self):
        return [h for h in logging.getLogger().handlers if isinstance(h, logging.FileHandler)]

    def test_writes_to_the_directory_it_is_given_in_the_established_format(self):
        with tempfile.TemporaryDirectory() as directory:
            m.setup_logging(log_dir=directory, preview=False, desktop_copy=False)
            m.log.info("hello organizer")
            for handler in logging.getLogger().handlers:
                handler.flush()
            text = (Path(directory) / "media-organizer.log").read_text()
            self._drop()
        self.assertRegex(text, r"^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] hello organizer")

    def test_preview_mode_never_creates_a_log_file(self):
        with tempfile.TemporaryDirectory() as directory:
            m.setup_logging(log_dir=directory, preview=True)
            m.log.info("preview run")
            self.assertEqual(self._file_handlers(), [])
            self.assertEqual(list(Path(directory).iterdir()), [])
            self._drop()

    def test_the_desktop_mirror_is_opt_in(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as home:
            (Path(home) / "Desktop").mkdir()
            mirror = Path(home) / "Desktop" / "media-organizer.log"
            with mock.patch.dict(os.environ, {"HOME": home}):
                m.setup_logging(log_dir=directory, preview=False)
                self.assertFalse(mirror.exists(), "no Desktop copy unless asked for")
                m.setup_logging(log_dir=directory, preview=False, desktop_copy=True)
                self.assertTrue(mirror.exists())
            self._drop()

    def test_calling_setup_twice_does_not_duplicate_handlers(self):
        with tempfile.TemporaryDirectory() as directory:
            m.setup_logging(log_dir=directory, preview=False)
            first = len(logging.getLogger().handlers)
            m.setup_logging(log_dir=directory, preview=False)
            self.assertEqual(len(logging.getLogger().handlers), first)
            self._drop()

    def test_an_unwritable_log_path_degrades_to_console_only(self):
        m.setup_logging(log_dir="/proc/does/not/exist", preview=False)   # must not raise
        self.assertEqual(self._file_handlers(), [])
        self.assertTrue(logging.getLogger().handlers, "the console handler is still attached")


if __name__ == "__main__":
    unittest.main()
