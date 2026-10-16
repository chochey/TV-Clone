const fs = require('node:fs');
const path = require('node:path');
const { isAudioFile, playbackIssueForFile } = require('./library-media');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHAPTERS = 2048;
const MAX_PARAGRAPHS = 30000;
const MAX_TEXT_LENGTH = 12000;
const MAX_WORDS = 300000;
const MAX_WORDS_PER_PARAGRAPH = 6000;
const ITEM_ID = /^[a-f0-9]{16}$/;
const TEXT_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MISSING = 'Read-along text has not been prepared for this audiobook.';
const INVALID = 'Read-along text could not be loaded. It needs to be prepared again.';
const STALE = 'This audiobook has changed. Its read-along text needs to be prepared again.';
const BUSY = 'Read-along text is temporarily unavailable. Please try again.';
// Only a busy reader is worth retrying. The others need someone to prepare or
// repair the text, so the UI must not offer a button that can never succeed.
const unavailable = message => ({ available: false, message, retryable: message === BUSY });

function validIdentity(value) {
  return value && ['size', 'dev', 'ino'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    ['mtimeMs', 'ctimeMs'].every(key => Number.isFinite(value[key]) && value[key] >= 0);
}
// Compares a persisted sidecar identity against the audio file as it is now, so
// it may only use fields that survive a remount. The library lives on a mergerfs
// (FUSE) union, which synthesises inode numbers in lookup order and reassigns
// them on every mount -- st_dev likewise identifies the mount, not the file.
// Comparing either one reported every unchanged audiobook as "changed" after a
// reboot. ctime is excluded for the same reason: it moves for metadata-only
// events (a move between pool branches, a chown) that leave the audio untouched.
// Size plus mtime is the content signal; the stricter within-request fingerprint
// below still guards against the file being swapped mid-read.
function sameSource(left, right) {
  return validIdentity(left) && validIdentity(right) &&
    left.size === right.size && Math.abs(left.mtimeMs - right.mtimeMs) < 1;
}
const fingerprint = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, maxLength, trim = true) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
      /<\s*(?:\/?[a-zA-Z]|!|\?)/.test(value)) throw Error('Invalid read-along text');
  return trim ? value.trim() : value;
}
function span(value, minimum, maximum) {
  if (!Number.isFinite(value.start) || !Number.isFinite(value.end) ||
      value.start < minimum || value.end > maximum || value.end <= value.start) throw Error('Invalid read-along timing');
}
function splitsSurrogatePair(value, offset) {
  return offset > 0 && offset < value.length &&
    value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff &&
    value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff;
}
function wordTimings(input, paragraph, paragraphText) {
  let characterEnd = 0, timeEnd = paragraph.start;
  return input.map(word => {
    if (!Array.isArray(word) || word.length !== 4) throw Error('Invalid read-along word timing');
    const [startOffset, endOffset, start, end] = word;
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) ||
        startOffset < characterEnd || endOffset <= startOffset || endOffset > paragraphText.length ||
        splitsSurrogatePair(paragraphText, startOffset) || splitsSurrogatePair(paragraphText, endOffset) ||
        !paragraphText.slice(startOffset, endOffset).trim()) throw Error('Invalid read-along word offsets');
    span({ start, end }, timeEnd, paragraph.end);
    characterEnd = endOffset; timeEnd = end;
    return [startOffset, endOffset, start, end];
  });
}

// Construct a fresh allowlisted response. Filesystem identity and processing
// metadata stay on the server; document text is plain text, never markup.
function parseDocument(input, itemId) {
  if (!record(input) || input.version !== 1 || input.itemId !== itemId || !ITEM_ID.test(itemId) ||
      !validIdentity(input.source) || !Number.isFinite(input.duration) || input.duration <= 0 ||
      !Array.isArray(input.chapters) || !input.chapters.length || input.chapters.length > MAX_CHAPTERS) {
    throw Error('Invalid read-along document');
  }
  const chapterIds = new Set(), paragraphIds = new Set();
  let chapterEnd = 0, paragraphCount = 0, wordCount = 0;
  const chapters = input.chapters.map(chapter => {
    if (!record(chapter) || typeof chapter.id !== 'string' || !TEXT_ID.test(chapter.id) || chapterIds.has(chapter.id) ||
        !Array.isArray(chapter.paragraphs) || !chapter.paragraphs.length) throw Error('Invalid read-along chapter');
    chapterIds.add(chapter.id);
    span(chapter, chapterEnd, input.duration);
    chapterEnd = chapter.end;
    let paragraphEnd = chapter.start;
    const paragraphs = chapter.paragraphs.map(paragraph => {
      // Page numbers come from a print edition and are shown as "Page N", so a
      // book prepared from an EPUB alone simply has none -- inventing them
      // would put fabricated page numbers in front of the reader. The player
      // already renders the label only when a page is present.
      if (!record(paragraph) || typeof paragraph.id !== 'string' || !TEXT_ID.test(paragraph.id) || paragraphIds.has(paragraph.id) ||
          ++paragraphCount > MAX_PARAGRAPHS ||
          (paragraph.page !== undefined &&
            (!Number.isSafeInteger(paragraph.page) || paragraph.page < 1 || paragraph.page > 100000))) {
        throw Error('Invalid read-along paragraph');
      }
      paragraphIds.add(paragraph.id);
      span(paragraph, paragraphEnd, chapter.end);
      paragraphEnd = paragraph.end;
      // Character offsets refer to the original UTF-16 text, including whitespace.
      const paragraphText = text(paragraph.text, MAX_TEXT_LENGTH, false);
      const result = { id: paragraph.id, text: paragraphText,
        start: paragraph.start, end: paragraph.end,
        ...(paragraph.page === undefined ? {} : { page: paragraph.page }) };
      if (Object.hasOwn(paragraph, 'words')) {
        if (!Array.isArray(paragraph.words) || !paragraph.words.length ||
            paragraph.words.length > MAX_WORDS_PER_PARAGRAPH ||
            (wordCount += paragraph.words.length) > MAX_WORDS) throw Error('Invalid read-along word count');
        result.words = wordTimings(paragraph.words, paragraph, paragraphText);
      }
      return result;
    });
    return { id: chapter.id, title: text(chapter.title, 512), start: chapter.start, end: chapter.end, paragraphs };
  });
  return { available: true, version: 1, itemId, title: text(input.title, 512), duration: input.duration, chapters };
}

module.exports = function createAudioReadAlong({ DATA_DIR, io = fs.promises,
  maxCacheBytes = MAX_FILE_BYTES, maxCacheEntries = 8, maxPending = 4, timeoutMs = 5000 } = {}) {
  const directory = path.join(DATA_DIR, 'read-along');
  const cache = new Map(), pending = new Map();
  let cacheBytes = 0;
  function forget(id) {
    cacheBytes -= cache.get(id)?.bytes || 0;
    cache.delete(id);
  }
  function remember(id, entry) {
    forget(id);
    if (entry.bytes > maxCacheBytes) return;
    cache.set(id, entry); cacheBytes += entry.bytes;
    while (cache.size > maxCacheEntries || cacheBytes > maxCacheBytes) forget(cache.keys().next().value);
  }
  async function read(itemId, audioPath, alive) {
    let handle;
    try {
      const audioBefore = await io.stat(audioPath);
      if (!audioBefore.isFile()) { forget(itemId); return unavailable(STALE); }
      const file = path.join(directory, `${itemId}.json`);
      const documentBefore = await io.lstat(file);
      if (!documentBefore.isFile() || documentBefore.isSymbolicLink() || documentBefore.size > MAX_FILE_BYTES || documentBefore.size < 2) {
        forget(itemId); return unavailable(INVALID);
      }
      const identity = `${audioPath}:${fingerprint(audioBefore)}:${fingerprint(documentBefore)}`;
      const previous = cache.get(itemId);
      let result, source;
      if (previous?.identity === identity) {
        result = previous.result; source = previous.source;
      } else {
        forget(itemId);
        // O_NOFOLLOW protects against a symlink replacing the checked sidecar.
        handle = await io.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (!opened.isFile() || fingerprint(opened) !== fingerprint(documentBefore)) return unavailable(INVALID);
        // A bounded read remains bounded even when another process grows the file.
        const buffer = Buffer.alloc(documentBefore.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const afterRead = await handle.stat();
        if (offset !== documentBefore.size || fingerprint(afterRead) !== fingerprint(documentBefore)) return unavailable(INVALID);
        const input = JSON.parse(buffer.subarray(0, offset).toString('utf8'));
        result = parseDocument(input, itemId); source = input.source;
      }
      const [audioAfter, documentAfter] = await Promise.all([io.stat(audioPath), io.lstat(file)]);
      if (!audioAfter.isFile() || fingerprint(audioBefore) !== fingerprint(audioAfter) || !sameSource(source, audioAfter)) {
        forget(itemId); return unavailable(STALE);
      }
      if (!documentAfter.isFile() || documentAfter.isSymbolicLink() || fingerprint(documentBefore) !== fingerprint(documentAfter)) {
        forget(itemId); return unavailable(INVALID);
      }
      if (!alive()) return unavailable(BUSY);
      remember(itemId, { identity, result, source, bytes: documentBefore.size });
      return result;
    } catch (error) {
      forget(itemId);
      return unavailable(error.code === 'ENOENT' ? MISSING : INVALID);
    } finally { await handle?.close().catch(() => {}); }
  }
  function get(itemId, audioPath) {
    if (!ITEM_ID.test(itemId) || typeof audioPath !== 'string' || !path.isAbsolute(audioPath) ||
        !isAudioFile(audioPath) || playbackIssueForFile(audioPath)) return Promise.resolve(unavailable(MISSING));
    const key = `${itemId}:${audioPath}`;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxPending) return Promise.resolve(unavailable(BUSY));
    let active = true, timer;
    const work = read(itemId, audioPath, () => active);
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { active = false; resolve(unavailable(BUSY)); }, timeoutMs);
    });
    const result = Promise.race([work, deadline]);
    pending.set(key, result);
    // Keep a timed-out job in the bounded pending set until filesystem work ends.
    work.finally(() => { active = false; clearTimeout(timer); pending.delete(key); });
    return result;
  }
  return { get, snapshot: () => ({ cached: cache.size, cacheBytes, pending: pending.size }) };
};
module.exports.parseDocument = parseDocument;
module.exports.sameSource = sameSource;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;
