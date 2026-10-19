"""The download-readiness file the server writes lives in the data dir (TVCLONE_DATA_DIR), never
beside the repo: the live install at /srv/chocheytv/app has no data/ link, and a wrong path here
makes every download look not-ready, so nothing is ever imported (October 2026). Checked in a
fresh interpreter, the way the service starts, so no module is reloaded under other tests."""
import os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = 'import config, movie_renamer; print(config.DOWNLOAD_READINESS_FILE); print(movie_renamer._DOWNLOAD_SNAPSHOT)'


def paths(env):
    out = subprocess.run([sys.executable, '-c', PROBE], cwd=HERE, env=env, capture_output=True, text=True, check=True)
    return out.stdout.split()


class ReadinessPathTests(unittest.TestCase):
    def test_the_readiness_file_follows_the_data_dir(self):
        env = {k: v for k, v in os.environ.items() if k != 'TVCLONE_DATA_DIR'}
        env['TVCLONE_DATA_DIR'] = '/srv/example/data'
        self.assertEqual(paths(env), ['/srv/example/data/download-readiness.json'] * 2)

    def test_without_a_data_dir_it_falls_back_beside_the_repo(self):
        env = {k: v for k, v in os.environ.items() if k not in ('TVCLONE_DATA_DIR', 'ORGANIZER_READINESS_FILE')}
        expected = os.path.join(os.path.dirname(HERE), 'data', 'download-readiness.json')
        self.assertEqual(paths(env), [expected] * 2)


if __name__ == '__main__':
    unittest.main()
