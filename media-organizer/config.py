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
INCOMPLETE_DIR  = os.environ.get('ORGANIZER_INCOMPLETE_DIR',  '/mnt/media/incomplete')

# Primary destinations (default for new content with no existing folder)
MOVIE_DEST_DIR  = os.environ.get('ORGANIZER_MOVIE_DEST',      '/mnt/media/Movies')
TV_DEST_DIR     = os.environ.get('ORGANIZER_TV_DEST',         '/mnt/media/TV')

# All destination drives (searched for existing content)
MOVIE_DEST_DIRS = [d.strip() for d in os.environ.get('ORGANIZER_MOVIE_DEST_DIRS', MOVIE_DEST_DIR).split(',') if d.strip()]
TV_DEST_DIRS    = [d.strip() for d in os.environ.get('ORGANIZER_TV_DEST_DIRS',    TV_DEST_DIR).split(',')    if d.strip()]

# OMDb API
OMDB_API_KEY  = os.environ.get('OMDB_API_KEY', '')
OMDB_BASE_URL = os.environ.get('OMDB_BASE_URL', 'http://www.omdbapi.com/')

# Watch mode
POLL_INTERVAL = int(os.environ.get('ORGANIZER_POLL_INTERVAL', '30'))

# Library progress tracking
LIBRARY_PROGRESS_FILE = os.environ.get('ORGANIZER_LIBRARY_PROGRESS', 'library_progress.json')

# Supported extensions
VIDEO_EXTENSIONS    = ['.mkv', '.mp4', '.avi', '.m4v', '.webm', '.mov']
SUBTITLE_EXTENSIONS = ['.srt', '.sub', '.ass', '.idx', '.ssa', '.vtt']
