// OMDB metadata fetcher + cache. Factory module: require('./lib/omdb')(deps).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

module.exports = function createOmdb({
  loadJSON, saveJSON,
  OMDB_CACHE_FILE, OMDB_API_KEY, OMDB_BASE_URL, OMDB_POSTER_DIR,
}) {
  let omdbCache = loadJSON(OMDB_CACHE_FILE, {});
  let omdbCacheDirty = false;

  function omdbCacheKey(title, year) {
    return `${(title || '').toLowerCase().trim()}|${year || ''}`;
  }

  function titleHash(title, year) {
    return crypto.createHash('md5').update(`${title}|${year || ''}`).digest('hex');
  }

  function parseYearFromName(name) {
    const m = name.match(/[\(\s](\d{4})[\)\s]?/);
    return m ? m[1] : null;
  }

  function stripYearFromName(name) {
    return name.replace(/[\s\.\-_]*[\(\[]?\d{4}[\)\]]?\s*$/, '').trim();
  }

  function httpGet(url, maxRedirects = 3) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
      const urlObj = new URL(url);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return reject(new Error('Invalid protocol'));
      }
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          try {
            const redirectUrl = new URL(res.headers.location, url);
            if (!['http:', 'https:'].includes(redirectUrl.protocol)) {
              return reject(new Error('Invalid redirect protocol'));
            }
            return httpGet(redirectUrl.href, maxRedirects - 1).then(resolve, reject);
          } catch {
            return reject(new Error('Invalid redirect URL'));
          }
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  function normalizeTitle(title) {
    return title
      .replace(/\b(REMASTERED|UNRATED|EXTENDED|DIRECTORS\s*CUT|THEATRICAL|IMAX|PROPER)\b/gi, '')
      .replace(/\b\d{3,4}p\b/gi, '')
      .replace(/\b(brrip|bluray|x264|yify|gaz|webrip|hdtv)\b/gi, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\bm\.c\b/gi, 'M.C.')
      .replace(/\bu n c l e\b/gi, 'U.N.C.L.E.')
      .replace(/\bsg-1\b/gi, 'SG-1')
      .replace(/- /g, ': ')
      .replace(/\s+/g, ' ')
      .replace(/\s*-\s*$/, '')
      .trim();
  }

  function apostropheVariations(title) {
    const contractions = {
      'dont': "don't", 'wont': "won't", 'cant': "can't", 'didnt': "didn't",
      'isnt': "isn't", 'wasnt': "wasn't", 'arent': "aren't", 'werent': "weren't",
      'wouldnt': "wouldn't", 'couldnt': "couldn't", 'shouldnt': "shouldn't",
      'hasnt': "hasn't", 'havent': "haven't", 'hadnt': "hadn't",
      'theyre': "they're", 'youre': "you're", 'were': "we're",
      'im': "I'm", 'ive': "I've", 'youve': "you've", 'theyve': "they've",
      'youll': "you'll", 'theyll': "they'll", 'well': "we'll", 'ill': "I'll",
      'its': "it's", 'hes': "he's", 'shes': "she's", 'whos': "who's",
      'whats': "what's", 'thats': "that's", 'theres': "there's",
    };
    const skip = new Set(['the','this','his','has','was','is','as','us','its','yes','plus',
      'does','goes','makes','takes','comes','gives','lives','moves','uses','alias',
      'christmas','campus','bus','focus','bonus','genius','status','virus','corpus',
      'mess','less','boss','loss','miss','kiss','cross','dress','press','stress','class','glass','grass','pass']);
    const results = [];
    let contracted = title;
    for (const [from, to] of Object.entries(contractions)) {
      contracted = contracted.replace(new RegExp('\\b' + from + '\\b', 'gi'), to);
    }
    if (contracted !== title) results.push(contracted);
    const words = title.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.length < 3 || !w.match(/s$/i) || skip.has(w.toLowerCase())) continue;
      const variant = [...words];
      variant[i] = w.slice(0, -1) + "'s";
      const v = variant.join(' ');
      if (!results.includes(v)) results.push(v);
    }
    return results;
  }

  async function fetchOmdbData(title, year, type) {
    const key = omdbCacheKey(title, year);
    if (omdbCache[key]) return omdbCache[key];
    if (!OMDB_API_KEY) return null;

    title = normalizeTitle(title);
    const params = new URLSearchParams({ apikey: OMDB_API_KEY, t: title, plot: 'short' });
    if (year) params.set('y', year);
    if (type === 'show') params.set('type', 'series');
    else if (type === 'movie') params.set('type', 'movie');

    const url = `${OMDB_BASE_URL}?${params.toString()}`;
    try {
      const raw = await httpGet(url);
      const data = JSON.parse(raw.toString('utf-8'));

      if (data.Response === 'False' && year) {
        const params2 = new URLSearchParams({ apikey: OMDB_API_KEY, t: title, plot: 'short' });
        if (type === 'show') params2.set('type', 'series');
        else if (type === 'movie') params2.set('type', 'movie');
        try {
          const raw2 = await httpGet(`${OMDB_BASE_URL}?${params2.toString()}`);
          const data2 = JSON.parse(raw2.toString('utf-8'));
          if (data2.Response !== 'False') {
            Object.assign(data, data2);
            data.Response = 'True';
          }
        } catch {}
      }
      if (data.Response === 'False') {
        const variations = apostropheVariations(title);
        for (const variant of variations) {
          try {
            const vParams = new URLSearchParams({ apikey: OMDB_API_KEY, t: variant, plot: 'short' });
            if (year) vParams.set('y', year);
            if (type === 'show') vParams.set('type', 'series');
            else if (type === 'movie') vParams.set('type', 'movie');
            const vRaw = await httpGet(`${OMDB_BASE_URL}?${vParams.toString()}`);
            const vData = JSON.parse(vRaw.toString('utf-8'));
            if (vData.Response !== 'False') {
              Object.assign(data, vData);
              data.Response = 'True';
              console.log(`  [omdb] Apostrophe fix: "${title}" -> "${variant}"`);
              break;
            }
          } catch {}
        }
      }
      if (data.Response === 'False') {
        omdbCache[key] = { _miss: true, _fetchedAt: Date.now() };
        omdbCacheDirty = true;
        return omdbCache[key];
      }

      const result = {
        omdbTitle: data.Title || title,
        omdbYear: data.Year || year,
        plot: data.Plot || '',
        rated: data.Rated || '',
        genre: data.Genre || '',
        director: data.Director || '',
        actors: data.Actors || '',
        imdbRating: data.imdbRating || '',
        imdbID: data.imdbID || '',
        runtime: data.Runtime || '',
        posterUrl: null,
        _fetchedAt: Date.now(),
      };

      if (data.Poster && data.Poster !== 'N/A') {
        try {
          const hash = titleHash(title, year);
          const posterPath = path.join(OMDB_POSTER_DIR, `${hash}.jpg`);
          if (!fs.existsSync(posterPath)) {
            const posterData = await httpGet(data.Poster);
            fs.writeFileSync(posterPath, posterData);
          }
          result.posterUrl = `/omdb-poster/${hash}`;
        } catch (e) {
          console.error(`  [omdb] Failed to download poster for "${title}": ${e.message}`);
        }
      }

      omdbCache[key] = result;
      omdbCacheDirty = true;
      return result;
    } catch (e) {
      console.error(`  [omdb] Fetch error for "${title}": ${e.message}`);
      return null;
    }
  }

  function saveOmdbCache() {
    if (omdbCacheDirty) {
      saveJSON(OMDB_CACHE_FILE, omdbCache);
      omdbCacheDirty = false;
    }
  }

  function getCached(title, year) {
    return omdbCache[omdbCacheKey(title, year)];
  }

  function getOmdbForItem(item) {
    let searchTitle, searchYear;
    if (item.type === 'show' && item.showName) {
      searchYear = parseYearFromName(item.showName);
      searchTitle = stripYearFromName(item.showName);
    } else {
      searchTitle = item.title;
      searchYear = item.year;
    }
    const cached = getCached(searchTitle, searchYear);
    if (!cached || cached._miss) return null;
    return {
      omdbTitle: cached.omdbTitle,
      omdbYear: cached.omdbYear,
      plot: cached.plot,
      rated: cached.rated,
      genre: cached.genre,
      director: cached.director,
      actors: cached.actors,
      imdbRating: cached.imdbRating,
      imdbID: cached.imdbID,
      runtime: cached.runtime,
      omdbPosterUrl: cached.posterUrl,
    };
  }

  let bgOmdbRunning = false;
  async function backgroundOmdbFetch(libraryCache) {
    if (bgOmdbRunning) return;
    bgOmdbRunning = true;
    const lib = libraryCache || [];
    let fetchCount = 0;
    const seen = new Set();

    for (const item of lib) {
      let searchTitle, searchYear, itemType;
      if (item.type === 'show' && item.showName) {
        searchYear = parseYearFromName(item.showName);
        searchTitle = stripYearFromName(item.showName);
        itemType = 'show';
      } else {
        searchTitle = item.title;
        searchYear = item.year;
        itemType = 'movie';
      }

      const key = omdbCacheKey(searchTitle, searchYear);
      if (seen.has(key)) continue;
      seen.add(key);
      if (omdbCache[key]) continue;

      await new Promise(r => setTimeout(r, 200));
      await fetchOmdbData(searchTitle, searchYear, itemType);
      fetchCount++;

      if (fetchCount % 25 === 0) {
        saveOmdbCache();
        console.log(`  [omdb] ${fetchCount} items fetched...`);
      }
    }

    saveOmdbCache();
    if (fetchCount > 0) {
      console.log(`  [omdb] Background fetch complete -- ${fetchCount} new items fetched.`);
    }
    bgOmdbRunning = false;
  }

  return {
    parseYearFromName, stripYearFromName, omdbCacheKey,
    fetchOmdbData, saveOmdbCache, getCached, getOmdbForItem,
    backgroundOmdbFetch,
  };
};
