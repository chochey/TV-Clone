// Audiobook filenames arrive squashed from the ripper
// ("AtomicHabitsAnEasyProvenWay...Ones_ep7.m4b"), and the library index used
// that as the title. Search folds punctuation to spaces but never splits
// camelCase, so the haystack held one unbroken word and typing a real title --
// "Atomic Habits" -- matched nothing at all. Every book here carries proper
// title/artist tags, so the scan prefers those and keeps the split filename as
// a fallback for anything untagged.
const { parseMetadata, probeArgs } = require('./audio-metadata');

function splitSquashedTitle(value) {
  return String(value || '')
    .replace(/[\s_-]*\bep\d+\s*$/i, '')          // the ripper's "_ep7" suffix
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // worldsBobiverse -> worlds Bobiverse
    .replace(/([A-Za-z])(\d)/g, '$1 $2')         // Book3 -> Book 3
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // AGrown -> A Grown
    .replace(/\s+/g, ' ')
    .trim();
}

const clean = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : null;

// Only the fields the shelf and search need. Chapters and artwork stay with
// audio-metadata, which serves the player.
function audioTitleFields(metadata) {
  const title = clean(metadata?.title), artist = clean(metadata?.artist);
  return title || artist ? { title, artist } : null;
}

// This cache is persisted, so it must key on something that survives a
// remount: /mnt/media is a mergerfs union that renumbers inodes on every
// mount, which is why dev/ino are deliberately absent here.
const audioMetaEntry = (stat, fields) => ({ size: stat.size, mtimeMs: stat.mtimeMs, ...fields });
function audioMetaValid(entry, stat) {
  return !!entry && !!stat && entry.size === stat.size && Math.abs(entry.mtimeMs - stat.mtimeMs) < 1;
}

// Text only: no artwork extraction, so a scan costs one short ffprobe per book
// rather than an ffmpeg decode. Never throws -- an unreadable book keeps its
// filename title rather than failing the scan.
async function probeAudioText(filePath, { run, timeoutMs = 8000 }) {
  try {
    const { stdout } = await run('ffprobe', probeArgs(filePath), {
      timeoutMs, queueTimeoutMs: 5000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 32 * 1024,
    });
    return audioTitleFields(parseMetadata(JSON.parse(stdout)));
  } catch { return null; }
}

module.exports = { splitSquashedTitle, audioTitleFields, audioMetaEntry, audioMetaValid, probeAudioText };
