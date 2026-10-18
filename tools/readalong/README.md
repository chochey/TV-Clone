# Read-along tools

How audiobooks get their read-along text and word highlighting. These run by hand (or as one-off
background jobs), never inside the server. The server only *reads* the finished documents from
`<data>/read-along/<itemId>.json` (validated by `lib/audio-read-along.js`).

Locations (data folder, models, work folders) come from `settings.py`; each can be overridden with an
environment variable. Run everything as `chocheytv` with the speech venv:

    PY=/var/lib/tvclone-readalong-book1-words-oct14/venv/bin/python   # has requirements.txt installed
    sudo -u chocheytv env HF_HUB_OFFLINE=1 $PY tools/readalong/<step>.py ...

`<itemId>` is the first 16 hex characters of sha256(audio file path), as in the library.

## Books with an ebook (best quality)

1. **Text** (`text/`): split the EPUB/PDF into the audiobook's chapters and paragraphs
   (`prepare_book.py` for EPUB, `prepare_book5.py` + `pdf_sections.py` for PDF), align paragraphs with
   aeneas, then `build_document.py` writes the paragraph-only document and checks it with the server's
   parser. `spot_check_sidecar.py <itemId>` listens to a few places with Whisper to confirm alignment.
2. **Words** (`words/`): a job folder holds `job.json` (audio, itemId, modelPath, whisperPath, destination,
   repository, chapterCount, optional chapterWindows) and `input.json` (the published paragraph-only
   document). Run `READALONG_JOB_ROOT=<job> PUBLISH_WORDS=1 $PY words/run_job.py`; without PUBLISH_WORDS it
   is a dry run. It aligns each chapter with wav2vec2 CTC, checks three spots per chapter against Whisper,
   publishes a chapter only if coverage ≥ 0.80 and the spots are strong, and resumes from
   `completed-step-NN.json` markers.
3. **Gap repair** (`gaps/`): `align_words` drops every word of a paragraph whose quick decode matches
   under 45% (announcers, shouts, short lines). `recover_gaps.py <job> --out <dir>` re-aligns those inside
   the gap between well-timed neighbours, keeping a word only if Whisper (tight window) hears it within
   0.6 s; `publish_gaps.py <job> <dir> [--dry-run]` publishes chapters that pass the job's validation.
4. **Held-back chapters**: `check_chapters.py <plan.json>` measures timing accuracy in up to six windows
   per chapter; `publish_checked.py <results.jsonl> [--dry-run]` publishes those with ≥ 100 matched words,
   ≥ 97% within 0.6 s, median ≤ 0.1 s and coverage ≥ 0.65. Most held-back chapters only missed the 0.80
   coverage floor; one failed a spot check because Whisper misheard a slurred character voice.

## Books without an ebook (`transcript/`)

`transcribe_book.py <job.json>` transcribes each embedded chapter with faster-whisper small.en, splits the
text into paragraphs at pauses (`paragraphs.py`) and writes `prepared.json`. `run_queue.py` works through
`<work>/queue.json` (publishing each book after the server's parser accepts it, never overwriting an
existing document); run it capped, e.g. a transient unit with `CPUQuota=150% Nice=19 IOSchedulingClass=idle`.
Look up each book's names on the web first and pass only **sourced** names: hints bias the recogniser, and
an unsourced "Keyes" turned the poet Keats into "Keyes". About 3x real time on this box at 2 threads.

## Hard-won rules

- Audiobooks narrate front matter the ebook text drops: always spot-check chapter 1.
- Map chapters by listening to their first seconds; a PDF can merge chapters the audio splits.
- `<Note ...>`-style text trips the reader's markup guard: use ‹ › instead.
- Compare audio identity by size + mtime only: /mnt/media is mergerfs and renumbers inodes every mount.
- Never republish a book while its word job runs; publishing asserts the live text equals the job's input.
- The reader's size limit (16 MiB) is shared with the nightly backup.

## Tests

    python3 -m unittest discover -s tools/readalong/tests -p "test_*.py"
