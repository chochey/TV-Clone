"""Media Organizer Configuration — reads from environment variables."""
import os


def _load_dotenv():
    """Load this module's sibling .env into os.environ if not already set.

    The systemd unit injects these via EnvironmentFile, but the organizer can
    also run through run-organizer-safe.sh or by hand, where no EnvironmentFile
    applies. Without this, OMDB_API_KEY ends up empty and every OMDb lookup
    returns 401 (silent: titles just get SKIP'd). Dependency-free so it works
    without python-dotenv. Existing env vars win over the file.
    """
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    try:
        with open(env_path, 'r', encoding='utf-8') as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


_load_dotenv()

# Source and staging directories
SOURCE_DIR      = os.environ.get('ORGANIZER_SOURCE_DIR',      '/mnt/media/Share')

# Primary destinations (default for new content with no existing folder)
MOVIE_DEST_DIR  = os.environ.get('ORGANIZER_MOVIE_DEST',      '/mnt/media/Movies')
TV_DEST_DIR     = os.environ.get('ORGANIZER_TV_DEST',         '/mnt/media/TV')

# All destination drives (searched for existing content)
MOVIE_DEST_DIRS = [d.strip() for d in os.environ.get('ORGANIZER_MOVIE_DEST_DIRS', MOVIE_DEST_DIR).split(',') if d.strip()]
TV_DEST_DIRS    = [d.strip() for d in os.environ.get('ORGANIZER_TV_DEST_DIRS',    TV_DEST_DIR).split(',')    if d.strip()]

# OMDb API
OMDB_API_KEY  = os.environ.get('OMDB_API_KEY', '')
# https: the key travels in the query string, so it should not cross the network in the clear
OMDB_BASE_URL = os.environ.get('OMDB_BASE_URL', 'https://www.omdbapi.com/')
# The server's data folder: beside the code unless a separate live install says
# otherwise (TVCLONE_DATA_DIR in /etc/tvclone/tvclone.env; see lib/paths.js).
_DATA = os.environ.get('TVCLONE_DATA_DIR') or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
# Episode titles per season (one request per season) and the daily request count
OMDB_SEASON_CACHE = os.environ.get('ORGANIZER_OMDB_SEASON_CACHE', os.path.join(_DATA, 'organizer-omdb-seasons.json'))
OMDB_USAGE_FILE = os.environ.get('ORGANIZER_OMDB_USAGE', os.path.join(_DATA, 'organizer-omdb-usage.json'))

# What the organizer is doing right now, for the Organizer page (see organizer_status.py)
STATUS_FILE = os.environ.get('ORGANIZER_STATUS_FILE', os.path.join(_DATA, 'organizer-status.json'))
STATUS_INTERVAL = float(os.environ.get('ORGANIZER_STATUS_INTERVAL', '30'))

# Where a --backfill-titles run writes its journal of renames (so --undo-backfill can reverse it)
BACKFILL_DIR = os.environ.get('ORGANIZER_BACKFILL_DIR', _DATA)

# Part-files being written right now (see safe_copy.py), so an interrupted run can clean up
INFLIGHT_FILE = os.environ.get('ORGANIZER_INFLIGHT_FILE', os.path.join(_DATA, 'organizer-inflight.json'))

# "Retry this release" requests from the Organizer page (see organizer_retry_spool.py)
RETRY_DIR = os.environ.get('ORGANIZER_RETRY_DIR') or os.path.join(_DATA, 'organizer-retries')

# Bonus videos inside a TV pack (featurettes, deleted scenes) are filed under <Series>/Extras
# instead of staying in the download folder. Set to 0 to leave them where they are.
FILE_EXTRAS = os.environ.get('ORGANIZER_FILE_EXTRAS', '1').strip().lower() not in ('0', 'false', 'no', 'off')

# Watch mode
POLL_INTERVAL = int(os.environ.get('ORGANIZER_POLL_INTERVAL', '30'))

# Library progress tracking
LIBRARY_PROGRESS_FILE = os.environ.get('ORGANIZER_LIBRARY_PROGRESS', 'library_progress.json')

# Supported extensions
VIDEO_EXTENSIONS    = ['.mkv', '.mp4', '.avi', '.m4v', '.webm', '.mov']
SUBTITLE_EXTENSIONS = ['.srt', '.sub', '.ass', '.idx', '.ssa', '.vtt']
