const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

function parseRange(range, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function streamMediaFile(req, res, filePath, { io = fs, onError = () => {} } = {}) {
  let stat;
  try { stat = await io.promises.stat(filePath); }
  catch (err) {
    onError(err);
    if (!res.destroyed) res.status(err.code === 'ENOENT' ? 404 : 503).send('Media file is unavailable');
    return;
  }
  if (res.destroyed) return;
  const size = stat.size;
  const type = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  let range;
  if (req.headers.range) {
    range = parseRange(req.headers.range, size);
    if (!range) {
      res.set('Content-Range', `bytes */${size}`);
      res.status(416).end(); return;
    }
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  }
  headers['Content-Length'] = range ? range.end - range.start + 1 : size;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  let reader;
  try { reader = io.createReadStream(filePath, range); }
  catch (err) { onError(err); res.destroy(); return; }
  // pipeline catches read errors and destroys the source on client abort.
  // Headers may already have left, so a failed transfer closes cleanly rather
  // than pretending it was a complete successful media response.
  await new Promise(resolve => pipeline(reader, res, err => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') onError(err);
    resolve();
  }));
}
module.exports = { streamMediaFile, parseRange };
