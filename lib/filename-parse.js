// Pure filename parsing helpers. No filesystem, no state — safe to unit-test.
const path = require('path');

const LANG_CODES = {
  eng: 'English', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian',
  por: 'Portuguese', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese',
  rus: 'Russian', ara: 'Arabic', hin: 'Hindi', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish',
  nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', pol: 'Polish', tur: 'Turkish',
  gre: 'Greek', ell: 'Greek', heb: 'Hebrew', tha: 'Thai', und: 'Unknown',
};

// 2-letter ISO 639-1 code mapping
const LANG_CODES_2 = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian',
  ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
  fi: 'Finnish', pl: 'Polish', tr: 'Turkish', el: 'Greek', he: 'Hebrew', th: 'Thai',
  cs: 'Czech', hr: 'Croatian', hu: 'Hungarian', ro: 'Romanian', uk: 'Ukrainian',
  vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', tl: 'Tagalog', ca: 'Catalan',
  eu: 'Basque', bg: 'Bulgarian', sk: 'Slovak', sl: 'Slovenian', sr: 'Serbian',
  lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', ta: 'Tamil', te: 'Telugu',
};

// Full-word language names that appear in subtitle filenames
const LANG_WORDS = {
  english: 'English', spanish: 'Spanish', french: 'French', german: 'German', italian: 'Italian',
  portuguese: 'Portuguese', japanese: 'Japanese', korean: 'Korean', chinese: 'Chinese', russian: 'Russian',
  arabic: 'Arabic', hindi: 'Hindi', dutch: 'Dutch', swedish: 'Swedish', norwegian: 'Norwegian',
  danish: 'Danish', finnish: 'Finnish', polish: 'Polish', turkish: 'Turkish', greek: 'Greek',
  hebrew: 'Hebrew', thai: 'Thai', czech: 'Czech', croatian: 'Croatian', hungarian: 'Hungarian',
  romanian: 'Romanian', ukrainian: 'Ukrainian', vietnamese: 'Vietnamese', indonesian: 'Indonesian',
  catalan: 'Catalan', basque: 'Basque', bulgarian: 'Bulgarian', slovak: 'Slovak', slovenian: 'Slovenian',
  serbian: 'Serbian', brazilian: 'Portuguese (BR)', european: 'European', forced: 'Forced',
};

function parseTitle(filename) {
  const name = path.parse(filename).name;
  let yearMatch = name.match(/\((\d{4})\)/);
  if (!yearMatch) {
    yearMatch = name.match(/[\.\s\-_]((?:19[2-9]\d|20[0-3]\d))[\.\s\-_]?$/);
  }
  const year = yearMatch ? yearMatch[1] : null;
  let title = name;
  if (yearMatch) title = name.substring(0, yearMatch.index);
  title = title.replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, year };
}

function parseEpisodeInfo(filename) {
  const lower = filename.toLowerCase();
  let m = lower.match(/s(\d{1,2})e(\d{1,3})/i);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]) };
  m = lower.match(/(\d{1,2})x(\d{2,3})/i);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]) };
  return null;
}

function parseShowName(filename) {
  const name = path.parse(filename).name;
  let m = name.match(/^(.+?)[\.\s\-_]*[Ss]\d{1,2}[Ee]\d{1,3}/);
  if (m) return m[1].replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim();
  m = name.match(/^(.+?)[\.\s\-_]*\d{1,2}x\d{2,3}/);
  if (m) return m[1].replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim();
  return null;
}

function detectType(filename, folderType) {
  if (folderType && folderType !== 'auto') return folderType;
  const lower = filename.toLowerCase();
  if (/s\d{1,2}e\d{1,2}/i.test(lower) || /\d{1,2}x\d{2}/i.test(lower)) return 'show';
  return 'movie';
}

function hasEpisodePattern(filename) {
  return /s\d{1,2}e\d{1,2}/i.test(filename) || /\d{1,2}x\d{2}/i.test(filename);
}

function detectSubLanguage(filename, videoBaseName) {
  const name = path.parse(filename).name;
  let tagPart = name;
  if (videoBaseName && name.toLowerCase().startsWith(videoBaseName.toLowerCase())) {
    tagPart = name.slice(videoBaseName.length).replace(/^[\.\-_ ]+/, '');
  }
  if (!tagPart) return 'Default';

  const parts = tagPart.toLowerCase().split(/[\.\-_ ]+/).filter(Boolean);
  const labels = [];

  for (const part of parts) {
    const resolved = LANG_WORDS[part] || LANG_CODES_2[part] || LANG_CODES[part];
    if (resolved) {
      if (!labels.includes(resolved)) labels.push(resolved);
      continue;
    }
    if (/^(sdh|cc|hi|forced|full|default|signs|songs)$/i.test(part)) { labels.push(part.toUpperCase()); continue; }
    if (part.length > 3) { labels.push(part.charAt(0).toUpperCase() + part.slice(1)); continue; }
    labels.push(part.toUpperCase());
  }

  return labels.length > 0 ? labels.join(' · ') : 'Unknown';
}

module.exports = {
  parseTitle, parseEpisodeInfo, parseShowName, detectType, hasEpisodePattern, detectSubLanguage,
  LANG_CODES, LANG_CODES_2, LANG_WORDS,
};
