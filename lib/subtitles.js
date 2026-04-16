// Subtitle conversion + embedded-stream extraction. Factory module.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function srtToVtt(content) {
  return 'WEBVTT\n\n' + content
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, '$1:$2:$3.$4')
    .replace(/\{\\[^}]*\}/g, '')            // strip SSA/ASS style tags
    .replace(/<font[^>]*>|<\/font>/gi, ''); // strip HTML font tags
}

function writeCacheAtomic(cacheFile, data) {
  const tmp = cacheFile + '.tmp';
  fs.writeFile(tmp, data, () => { fs.rename(tmp, cacheFile, () => {}); });
}

module.exports = function createSubtitles({ SUBTITLE_CACHE_DIR }) {
  async function serveExternal(sub, subId, res) {
    if (!sub || !fs.existsSync(sub.absPath)) { res.status(404).send('Not found'); return; }

    if (sub.format === 'srt') {
      const cacheFile = path.join(SUBTITLE_CACHE_DIR, subId + '.vtt');
      if (fs.existsSync(cacheFile)) {
        res.set('Cache-Control', 'public, max-age=604800');
        return res.sendFile(cacheFile);
      }
      let content;
      try { content = await fs.promises.readFile(sub.absPath, 'utf-8'); }
      catch { return res.status(404).send('Not found'); }
      const vtt = srtToVtt(content);
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=604800');
      res.send(vtt);
      writeCacheAtomic(cacheFile, vtt);
    } else {
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=604800');
      res.sendFile(sub.absPath);
    }
  }

  function serveEmbedded({ filePath, fileId, streamIdx, knownSubs }, res) {
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not found');
    if (isNaN(streamIdx) || streamIdx < 0) return res.status(400).send('Invalid stream index');
    if (!knownSubs || !knownSubs.some(s => s.index === streamIdx)) {
      return res.status(400).send('Invalid stream index');
    }

    const cacheFile = path.join(SUBTITLE_CACHE_DIR, fileId + '_' + streamIdx + '.vtt');
    if (fs.existsSync(cacheFile)) {
      res.set('Cache-Control', 'public, max-age=604800');
      return res.sendFile(cacheFile);
    }

    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-map', `0:${streamIdx}`,
      '-f', 'webvtt', '-',
    ]);

    const chunks = [];
    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.stderr.on('data', d => console.error(`[sub-extract] ${d.toString().trim()}`));
    proc.on('error', () => { if (!res.headersSent) res.status(500).send('Extraction failed'); });
    proc.on('close', code => {
      if (code === 0 && chunks.length > 0) {
        const data = Buffer.concat(chunks);
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=604800');
        res.end(data);
        writeCacheAtomic(cacheFile, data);
      } else if (!res.headersSent) {
        res.status(500).send('Extraction failed');
      }
    });
  }

  return { serveExternal, serveEmbedded, srtToVtt };
};

module.exports.srtToVtt = srtToVtt;
