"""A separate live install keeps the organizer's state outside the code folder (see lib/paths.js)."""
import importlib
import logging
import os
import tempfile
import unittest
from unittest import mock

import config


class StatePathTests(unittest.TestCase):
    def reload(self, env):
        with mock.patch.dict(os.environ, env, clear=False):
            for key in [k for k in os.environ if k.startswith('ORGANIZER_') and k not in env]:
                os.environ.pop(key)
            return importlib.reload(config)

    def tearDown(self):
        importlib.reload(config)

    def test_data_files_follow_tvclone_data_dir(self):
        c = self.reload({'TVCLONE_DATA_DIR': '/srv/chocheytv/data'})
        self.assertEqual(c.STATUS_FILE, '/srv/chocheytv/data/organizer-status.json')
        self.assertEqual(c.INFLIGHT_FILE, '/srv/chocheytv/data/organizer-inflight.json')
        self.assertEqual(c.OMDB_SEASON_CACHE, '/srv/chocheytv/data/organizer-omdb-seasons.json')
        self.assertEqual(c.RETRY_DIR, '/srv/chocheytv/data/organizer-retries')

    def test_without_settings_the_data_folder_is_beside_the_code(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('TVCLONE_DATA_DIR', None)
            c = importlib.reload(config)
        repo = os.path.dirname(os.path.dirname(os.path.abspath(config.__file__)))
        self.assertEqual(c.INFLIGHT_FILE, os.path.join(repo, 'data', 'organizer-inflight.json'))

    def test_log_goes_to_organizer_log_dir(self):
        import movie_renamer
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {'ORGANIZER_LOG_DIR': folder}):
            handlers = movie_renamer.setup_logging(preview=False)
            try:
                files = [h.baseFilename for h in handlers if isinstance(h, logging.FileHandler)]
                self.assertEqual(files, [os.path.join(folder, 'media-organizer.log')])
            finally:
                for h in handlers:
                    logging.getLogger().removeHandler(h); h.close()


if __name__ == '__main__':
    unittest.main()
