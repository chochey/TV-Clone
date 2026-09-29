// Subtitle conversion + embedded-stream extraction. Factory module.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { subtitleRunner } = require('./media-process');

function srtToVtt(content) {
  return 'WEBVTT\n\n' + content
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, '$1:$2:$3.$4')
    .replace(/\{\\[^}]*\}/g, '')            // strip SSA/ASS style tags
    .replace(/<font[^>]*>|<\/font>/gi, ''); // strip HTML font tags
}

async function writeCacheAtomic(cacheFile, data, io = fs.promises) {
  const tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try { await io.writeFile(tmp, data); await io.rename(tmp, cacheFile); }
  catch { try { await io.unlink(tmp); } catch {} }
}

module.exports = function createSubtitles({ SUBTITLE_CACHE_DIR, runner = subtitleRunner, io = fs }) {
  const inFlight = new Map();
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
      await writeCacheAtomic(cacheFile, vtt, io.promises);
    } else {
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=604800');
      res.sendFile(sub.absPath);
    }
  }

  async function serveEmbedded({ filePath, fileId, streamIdx, knownSubs }, res) {
    if (!filePath || !io.existsSync(filePath)) return res.status(404).send('File not found');
    if (!Number.isInteger(streamIdx) || streamIdx < 0) return res.status(400).send('Invalid stream index');
    if (!knownSubs || !knownSubs.some(s => s.index === streamIdx && s.extractable)) {
      return res.status(400).send('Invalid stream index');
    }

    const cacheFile = path.join(SUBTITLE_CACHE_DIR, fileId + '_' + streamIdx + '.vtt');
    if (io.existsSync(cacheFile)) {
      res.set('Cache-Control', 'public, max-age=604800');
      return res.sendFile(cacheFile);
    }

    let job = inFlight.get(cacheFile);
    if (!job) {
      job = { controller: new AbortController(), consumers: 0, settled: false };
      const current = job;
      job.promise = runner.run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', filePath,
        '-map', `0:${streamIdx}`, '-f', 'webvtt', '-',
      ], { signal: job.controller.signal, encoding: null, timeoutMs: 45000, maxStdoutBytes: 8 * 1024 * 1024 })
        .then(async ({ stdout }) => {
          if (!stdout.length) throw new Error('Empty subtitle output');
          await writeCacheAtomic(cacheFile, stdout, io.promises);
          return stdout;
        }).finally(() => { current.settled = true; inFlight.delete(cacheFile); });
      inFlight.set(cacheFile, job);
    }
    job.consumers++;
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true; job.consumers--;
      if (!job.settled && job.consumers === 0) job.controller.abort();
    };
    res.once('close', detach);
    try {
      const data = await job.promise;
      if (res.destroyed) return;
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=604800');
      res.end(data);
    } catch (err) {
      if (!res.destroyed && !res.headersSent) res.status(503).send(err.code === 'MEDIA_BUSY'
        ? 'Subtitle processing is busy. Please try again.' : 'Subtitle extraction failed. Please try again.');
    } finally { res.removeListener('close', detach); detach(); }
  }

  return { serveExternal, serveEmbedded, srtToVtt };
};

module.exports.srtToVtt = srtToVtt;
