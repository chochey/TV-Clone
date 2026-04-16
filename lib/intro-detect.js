// Chromaprint-based TV intro detection + IntroDB community lookups.
// Factory module.
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const FP_RATE = 1 / 0.1238; // ~8.08 fingerprints per second (Chromaprint default)

function popcount32(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
}

function getChromaprint(filePath, durationSec) {
  return new Promise((resolve) => {
    const proc = spawn('fpcalc', ['-raw', '-length', String(durationSec), filePath]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', (code) => {
      if (code !== 0) return resolve([]);
      const match = out.match(/FINGERPRINT=(.+)/);
      if (!match) return resolve([]);
      resolve(match[1].split(',').map(Number));
    });
    proc.on('error', () => resolve([]));
  });
}

function findMatchingSegment(fp1, fp2, minLenFp) {
  const MAX_HAMMING = 10;
  const GAP_TOLERANCE = 3;
  const len1 = fp1.length, len2 = fp2.length;
  if (len1 < minLenFp || len2 < minLenFp) return null;

  let bestStart1 = 0, bestStart2 = 0, bestLen = 0, bestMatches = 0;

  for (let shift = -(len2 - minLenFp); shift < len1 - minLenFp; shift++) {
    const i1Start = Math.max(0, shift);
    const i2Start = Math.max(0, -shift);
    const overlapLen = Math.min(len1 - i1Start, len2 - i2Start);

    let runStart1 = 0, runStart2 = 0, runLen = 0, gapCount = 0, matchCount = 0;
    for (let k = 0; k < overlapLen; k++) {
      const hamming = popcount32(fp1[i1Start + k] ^ fp2[i2Start + k]);
      if (hamming <= MAX_HAMMING) {
        if (runLen === 0) { runStart1 = i1Start + k; runStart2 = i2Start + k; }
        runLen++;
        matchCount++;
        gapCount = 0;
      } else {
        gapCount++;
        if (gapCount <= GAP_TOLERANCE && runLen > 0) {
          runLen++;
        } else {
          if (runLen > bestLen && matchCount > bestMatches) {
            bestStart1 = runStart1; bestStart2 = runStart2; bestLen = runLen; bestMatches = matchCount;
          }
          runLen = 0; matchCount = 0; gapCount = 0;
        }
      }
    }
    if (runLen > bestLen && matchCount > bestMatches) {
      bestStart1 = runStart1; bestStart2 = runStart2; bestLen = runLen; bestMatches = matchCount;
    }
  }

  if (bestLen < minLenFp) return null;
  return { start1: bestStart1, start2: bestStart2, length: bestLen, score: bestMatches / bestLen };
}

module.exports = function createIntroDetect({ DATA_DIR, loadJSON, saveJSON, getFilePath, getLibrary }) {
  const INTRODB_CACHE_FILE = path.join(DATA_DIR, 'introdb_cache.json');
  const introDbCache = loadJSON(INTRODB_CACHE_FILE, {});

  function fetchIntroDb(imdbId, season, episode) {
    return new Promise((resolve) => {
      const cacheKey = `${imdbId}_s${season}e${episode}`;
      if (introDbCache[cacheKey]) return resolve(introDbCache[cacheKey]);
      const url = `https://api.introdb.app/segments?imdb_id=${imdbId}&season=${season}&episode=${episode}`;
      const req = https.get(url, { timeout: 5000 }, (resp) => {
        let data = '';
        resp.on('data', d => data += d);
        resp.on('end', () => {
          try {
            const json = JSON.parse(data);
            introDbCache[cacheKey] = json;
            saveJSON(INTRODB_CACHE_FILE, introDbCache);
            resolve(json);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  async function detectIntroForShow(showName) {
    const lib = getLibrary();
    const episodes = lib.filter(i => i.type === 'show' && i.showName === showName);
    if (episodes.length < 2) return null;

    episodes.sort((a, b) => {
      const sa = a.epInfo?.season || 0, sb = b.epInfo?.season || 0;
      const ea = a.epInfo?.episode || 0, eb = b.epInfo?.episode || 0;
      return sa - sb || ea - eb;
    });
    const candidates = episodes.slice(1, 6);
    if (candidates.length < 2) return null;

    const SCAN_DURATION = 300;
    const MIN_INTRO_SEC = 10;
    const minLenFp = Math.round(MIN_INTRO_SEC * FP_RATE);

    console.log(`[SkipIntro] Chromaprint analysis for "${showName}" (${candidates.length} episodes)...`);

    const fingerprints = [];
    for (const ep of candidates.slice(0, 3)) {
      const fp = getFilePath(ep.id);
      if (!fp) continue;
      const chromaFp = await getChromaprint(fp, SCAN_DURATION);
      if (chromaFp.length > minLenFp) fingerprints.push(chromaFp);
    }
    if (fingerprints.length < 2) return null;

    const match = findMatchingSegment(fingerprints[0], fingerprints[1], minLenFp);
    if (!match || match.score < 0.7) {
      console.log(`[SkipIntro] No intro detected for "${showName}" (best score: ${match ? (match.score * 100).toFixed(1) : 0}%)`);
      return null;
    }

    let startFp = match.start1, endFp = match.start1 + match.length;
    if (fingerprints.length >= 3) {
      const verify = findMatchingSegment(fingerprints[0], fingerprints[2], minLenFp);
      if (!verify || verify.score < 0.6) {
        console.log(`[SkipIntro] Failed 3rd-episode verification for "${showName}"`);
        return null;
      }
      const vStart = verify.start1, vEnd = verify.start1 + verify.length;
      startFp = Math.max(startFp, vStart);
      endFp = Math.min(endFp, vEnd);
      if (endFp - startFp < minLenFp) {
        console.log(`[SkipIntro] Intersection too short for "${showName}"`);
        return null;
      }
    }

    const start = Math.round(startFp / FP_RATE);
    const end = Math.round(endFp / FP_RATE);

    console.log(`[SkipIntro] Detected intro for "${showName}": ${start}s - ${end}s (confidence: ${(match.score * 100).toFixed(1)}%, ${match.length} fp matched)`);
    return { start, end };
  }

  return { fetchIntroDb, detectIntroForShow };
};

module.exports.popcount32 = popcount32;
module.exports.findMatchingSegment = findMatchingSegment;
module.exports.FP_RATE = FP_RATE;
