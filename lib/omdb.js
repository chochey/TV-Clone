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
  let omdbCacheVersion = 0;
  const MISS_RETRY_MS = Math.max(60 * 1000, parseInt(process.env.OMDB_MISS_RETRY_MS || '', 10) || 7 * 24 * 60 * 60 * 1000);
  const POSTER_RETRY_MS = Math.max(60 * 1000, parseInt(process.env.OMDB_POSTER_RETRY_MS || '', 10) || 30 * 24 * 60 * 60 * 1000);

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

  async function fetchOmdbJson(params) {
    const raw = await httpGet(`${OMDB_BASE_URL}?${params.toString()}`);
    return JSON.parse(raw.toString('utf-8'));
  }

  function isMiss(cached) {
    return !!(cached && cached._miss);
  }

  function cacheAge(cached) {
    if (!cached || !cached._fetchedAt) return Infinity;
    return Date.now() - cached._fetchedAt;
  }

  function isStaleMiss(cached) {
    const age = cacheAge(cached);
    return isMiss(cached) && (age > MISS_RETRY_MS || age < -5 * 60 * 1000);
  }

  function isStalePosterless(cached) {
    if (!cached || cached._miss || cached.posterUrl) return false;
    const age = cacheAge(cached);
    return age > POSTER_RETRY_MS || age < -5 * 60 * 1000;
  }

  function markOmdbDirty() {
    omdbCacheDirty = true;
    omdbCacheVersion++;
  }

  function isWeakOmdbData(data) {
    return data && data.Response !== 'False' &&
      (!data.Poster || data.Poster === 'N/A') &&
      (!data.Plot || data.Plot === 'N/A') &&
      (!data.Runtime || data.Runtime === 'N/A');
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

  function lookupVariations(title) {
    const results = [];
    const add = (value) => {
      const cleaned = (value || '').replace(/\s+/g, ' ').trim();
      if (cleaned && cleaned.toLowerCase() !== title.toLowerCase() && !results.includes(cleaned)) results.push(cleaned);
    };

    add(title.replace(/\s*\(+\s*$/g, ''));
    add(title.replace(/\bJackass\s+(\d)\s+(\d)\b/i, 'Jackass $1.$2'));
    add(title.replace(/\bDen of Thieves\s+2\s+Pantera\b/i, 'Den of Thieves: Pantera'));
    add(title.replace(/\bFrom the World of John Wick\s*:?\s*Ballerina\b/i, 'Ballerina'));
    add(title.replace(/\bThe Wandering Earth\s+2\b/i, 'The Wandering Earth II'));
    add(title.replace(/\bWake Up Dead Man\s+A Knives Out Mystery\b/i, 'Wake Up Dead Man: A Knives Out Mystery'));
    add(title.replace(/\bWake Up Dead Man\s+A Knives Out Mystery\b/i, 'Wake Up Dead Man'));

    const starWars = title.match(/^Star Wars Episode\s+([IVXLCDM]+)\s+(.+?)\s*\(*$/i);
    if (starWars) add(`Star Wars: Episode ${starWars[1].toUpperCase()} - ${starWars[2]}`);

    return results;
  }

  async function fetchOmdbSearchResult(title, year, type) {
    const searches = [];
    const withYear = new URLSearchParams({ apikey: OMDB_API_KEY, s: title });
    if (year) withYear.set('y', year);
    if (type === 'show') withYear.set('type', 'series');
    else if (type === 'movie') withYear.set('type', 'movie');
    searches.push(withYear);

    if (year) {
      const withoutYear = new URLSearchParams({ apikey: OMDB_API_KEY, s: title });
      if (type === 'show') withoutYear.set('type', 'series');
      else if (type === 'movie') withoutYear.set('type', 'movie');
      searches.push(withoutYear);
    }

    for (const params of searches) {
      try {
        const data = await fetchOmdbJson(params);
        if (data.Response === 'False' || !Array.isArray(data.Search)) continue;
        const expectedType = type === 'show' ? 'series' : (type === 'movie' ? 'movie' : null);
        const match = data.Search.find(entry => {
          const yearMatch = !year || String(entry.Year || '').startsWith(String(year));
          const typeMatch = !expectedType || entry.Type === expectedType;
          return yearMatch && typeMatch && entry.imdbID;
        }) || data.Search.find(entry => entry.imdbID);
        if (!match) continue;
        const byId = new URLSearchParams({ apikey: OMDB_API_KEY, i: match.imdbID, plot: 'short' });
        return await fetchOmdbJson(byId);
      } catch {}
    }
    return null;
  }

  async function fetchOmdbData(title, year, type, options = {}) {
    const key = omdbCacheKey(title, year);
    const cached = omdbCache[key];
    if (cached && !options.force && !isStaleMiss(cached) && !isStalePosterless(cached)) return cached;
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
          const data2 = await fetchOmdbJson(params2);
          if (data2.Response !== 'False') {
            Object.assign(data, data2);
            data.Response = 'True';
          }
        } catch {}
      }
      if (data.Response === 'False' || isWeakOmdbData(data)) {
        const variations = lookupVariations(title);
        for (const variant of variations) {
          try {
            const vParams = new URLSearchParams({ apikey: OMDB_API_KEY, t: variant, plot: 'short' });
            if (year) vParams.set('y', year);
            if (type === 'show') vParams.set('type', 'series');
            else if (type === 'movie') vParams.set('type', 'movie');
            const vData = await fetchOmdbJson(vParams);
            if (vData.Response !== 'False' && !isWeakOmdbData(vData)) {
              Object.assign(data, vData);
              data.Response = 'True';
              console.log(`  [omdb] Title fix: "${title}" -> "${variant}"`);
              break;
            }
          } catch {}
        }
      }
      if (data.Response === 'False') {
        const variations = apostropheVariations(title);
        for (const variant of variations) {
          try {
            const vParams = new URLSearchParams({ apikey: OMDB_API_KEY, t: variant, plot: 'short' });
            if (year) vParams.set('y', year);
            if (type === 'show') vParams.set('type', 'series');
            else if (type === 'movie') vParams.set('type', 'movie');
            const vData = await fetchOmdbJson(vParams);
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
        const searchData = await fetchOmdbSearchResult(title, year, type);
        if (searchData && searchData.Response !== 'False') {
          Object.assign(data, searchData);
          data.Response = 'True';
          console.log(`  [omdb] Search fallback matched "${title}" -> "${data.Title || title}"`);
        }
      }
      if (data.Response === 'False') {
        omdbCache[key] = { _miss: true, _fetchedAt: Date.now() };
        markOmdbDirty();
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
      markOmdbDirty();
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
      const cached = omdbCache[key];
      if (cached && !isStaleMiss(cached) && !isStalePosterless(cached)) continue;

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

  async function refreshMissingMetadata(libraryCache, options = {}) {
    const limit = Math.max(1, Math.min(parseInt(options.limit || 100, 10), 500));
    const forceMisses = options.forceMisses !== false;
    const forcePosterless = options.forcePosterless === true;
    const lib = libraryCache || [];
    const seen = new Set();
    const result = { checked: 0, fetched: 0, recovered: 0, misses: 0, skipped: 0 };

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
      result.checked++;

      const cached = omdbCache[key];
      const shouldFetch = !cached || (cached._miss && forceMisses) || (!cached._miss && !cached.posterUrl && forcePosterless) || isStaleMiss(cached) || isStalePosterless(cached);
      if (!shouldFetch) {
        result.skipped++;
        continue;
      }
      if (result.fetched >= limit) break;

      await new Promise(r => setTimeout(r, 200));
      const beforeWasMiss = !cached || cached._miss || !cached.posterUrl;
      const fresh = await fetchOmdbData(searchTitle, searchYear, itemType, { force: true });
      result.fetched++;
      if (fresh && fresh._miss) result.misses++;
      else if (fresh && beforeWasMiss && fresh.posterUrl) result.recovered++;

      if (result.fetched % 25 === 0) {
        saveOmdbCache();
        console.log(`  [omdb] Refresh ${result.fetched}/${limit}: ${result.recovered} posters recovered...`);
      }
    }

    saveOmdbCache();
    return result;
  }

  return {
    parseYearFromName, stripYearFromName, omdbCacheKey,
    fetchOmdbData, saveOmdbCache, getCached, getOmdbForItem,
    backgroundOmdbFetch, refreshMissingMetadata,
    isStaleMiss, isStalePosterless,
    get cacheSize() { return Object.keys(omdbCache).length; },
    get cacheVersion() {
      let maxFetchedAt = 0;
      for (const value of Object.values(omdbCache)) {
        if (value && value._fetchedAt > maxFetchedAt) maxFetchedAt = value._fetchedAt;
      }
      return `${Object.keys(omdbCache).length}-${maxFetchedAt}-${omdbCacheVersion}`;
    },
  };
};
