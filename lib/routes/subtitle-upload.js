// Admins can add a subtitle file to a film or episode from the app. It is saved
// as an ordinary sidecar beside the video, "<video name>.<lang>.uploaded.srt",
// so the library attaches it like any other subtitle (lib/fs-helpers.js
// subtitles(): the name must start with the video's) and renames keep it with
// the video. Nothing is overwritten: a second upload gets "uploaded-2".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { detectSubLanguage, LANG_CODES, LANG_CODES_2 } = require('../filename-parse');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMING = /\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3}/g;

// Subtitle files are often Windows-1252; anything that is not valid UTF-8 is read that way.
function decode(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('windows-1252').decode(buffer); }
}

module.exports = function registerSubtitleUploadRoutes(app, {
  requireAdminSession, ensureLibrary, textBody, scanLibrary, fileFor, refreshLibrary, log = console.log,
}) {
  app.post('/api/subtitles/:id', requireAdminSession, ensureLibrary, textBody, async (req, res) => {
    const item = scanLibrary().find(i => i.id === req.params.id);
    if (item?.mediaKind === 'audio') return res.status(415).json({ error: 'Audiobooks do not use subtitles' });
    const video = item && fileFor(item.id);
    if (!item || !video || !fs.existsSync(video)) return res.status(404).json({ error: 'Media not found' });
    const lang = String(req.query.lang || '').toLowerCase();
    if (!/^[a-z]{2,3}$/.test(lang) || !(LANG_CODES[lang] || LANG_CODES_2[lang])) {
      return res.status(400).json({ error: 'Choose the subtitle language' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a subtitle file' });
    if (req.body.length > MAX_BYTES) return res.status(413).json({ error: 'Subtitle files can be up to 2 MB' });

    const text = decode(req.body).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const cues = (text.match(TIMING) || []).length;
    if (!cues) return res.status(400).json({ error: 'That file has no subtitle timings. Use an .srt or .vtt file.' });
    const ext = /^WEBVTT/.test(text) ? '.vtt' : '.srt';

    const dir = path.dirname(video), stem = path.parse(video).name;
    let filename, n = 1;
    do { filename = `${stem}.${lang}.uploaded${n > 1 ? `-${n}` : ''}${ext}`; n++; }
    while (fs.existsSync(path.join(dir, filename)) && n < 100);
    const file = path.join(dir, filename);
    try { await fs.promises.writeFile(file, text, { flag: 'wx' }); }
    catch (error) { return res.status(500).json({ error: `Could not save the subtitle file: ${error.code || error.message}` }); }

    log(`[Subtitles] Added ${filename} (${cues} cues)`);
    refreshLibrary('subtitle-upload');
    res.json({ ok: true, label: detectSubLanguage(filename, stem), filename,
      subtitleId: crypto.createHash('sha256').update(file).digest('hex').slice(0, 16), cues });
  });
};
