"""Where the read-along tools find the live data, the speech models and their work folders.

Defaults match this server (see CLAUDE.md, "Live install vs workshop"); each can be overridden with an
environment variable. The live code's own parser (APP_DIR/lib/audio-read-along.js) decides what the server
will accept, so publishing steps validate against it rather than against a copy.
"""
import os
from pathlib import Path


def _path(name, default):
    return Path(os.environ.get(name) or default)


DATA_DIR = _path('TVCLONE_DATA_DIR', '/srv/chocheytv/data')
READ_ALONG_DIR = DATA_DIR / 'read-along'
APP_DIR = _path('TVCLONE_REPO_DIR', '/srv/chocheytv/app')
WAV2VEC2_MODEL = _path('READALONG_WAV2VEC2_MODEL', '/var/lib/tvclone-readalong-words-oct12/model')
WHISPER_TINY = _path('READALONG_WHISPER_TINY', '/var/lib/tvclone-readalong-book1-words-oct14/whisper-model')
WHISPER_SMALL = _path('READALONG_WHISPER_SMALL', '/var/lib/tvclone-readalong-transcribe/model-small.en')
GAPS_WORK = _path('READALONG_GAPS_WORK', '/var/lib/tvclone-readalong-gaps')
TRANSCRIBE_WORK = _path('READALONG_TRANSCRIBE_WORK', '/var/lib/tvclone-readalong-transcribe')
