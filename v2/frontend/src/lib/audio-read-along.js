const finite = value => typeof value === 'number' && Number.isFinite(value);

// Never fill gaps with estimated timestamps: untimed passages remain readable.
export function readAlongDocument(value, itemId) {
  if (!value?.available) return null;
  if (value.version !== 1 || value.itemId !== itemId || !finite(value.duration) || value.duration <= 0 || !Array.isArray(value.chapters)) {
    throw new Error('Invalid read-along document');
  }
  const ids = new Set();
  let previousEnd = 0, wordCount = 0;
  const chapters = value.chapters.map((chapter, chapterIndex) => {
    if (!finite(chapter.start) || !finite(chapter.end) || chapter.start < previousEnd || chapter.end <= chapter.start || chapter.end > value.duration + 1 || !Array.isArray(chapter.paragraphs)) {
      throw new Error('Invalid read-along chapter');
    }
    previousEnd = chapter.end;
    let paragraphEnd = chapter.start;
    const paragraphs = chapter.paragraphs.map((paragraph, paragraphIndex) => {
      const id = String(paragraph.id ?? `${chapterIndex}-${paragraphIndex}`);
      if (ids.has(id) || typeof paragraph.text !== 'string' || !paragraph.text.trim()) throw new Error('Invalid read-along paragraph');
      ids.add(id);
      const timed = finite(paragraph.start) && finite(paragraph.end);
      if (timed && (paragraph.start < paragraphEnd || paragraph.end <= paragraph.start || paragraph.end > chapter.end + 0.01)) throw new Error('Invalid paragraph timing');
      if (timed) paragraphEnd = paragraph.end;
      let words;
      if (paragraph.words !== undefined) {
        if (!timed || !Array.isArray(paragraph.words) || !paragraph.words.length || paragraph.words.length > 6000 || (wordCount += paragraph.words.length) > 300000) throw new Error('Invalid word timing');
        let textEnd = 0, wordEnd = paragraph.start;
        words = paragraph.words.map(word => {
          if (!Array.isArray(word) || word.length !== 4) throw new Error('Invalid word timing');
          const [start, end, from, until] = word;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < textEnd || end <= start || end > paragraph.text.length ||
            !finite(from) || !finite(until) || from < wordEnd || until <= from || until > paragraph.end ||
            splitsSurrogate(paragraph.text, start) || splitsSurrogate(paragraph.text, end) || !paragraph.text.slice(start, end).trim()) throw new Error('Invalid word timing');
          textEnd = end; wordEnd = until;
          return [start, end, from, until];
        });
      }
      return { id, text: paragraph.text, start: timed ? paragraph.start : null, end: timed ? paragraph.end : null,
        page: Number.isInteger(paragraph.page) && paragraph.page > 0 ? paragraph.page : null, ...(words ? { words } : {}) };
    });
    return { id: String(chapter.id ?? chapterIndex), title: String(chapter.title || `Chapter ${chapterIndex + 1}`),
      start: chapter.start, end: chapter.end, paragraphs };
  });
  if (!chapters.length) throw new Error('Empty read-along document');
  return { title: String(value.title || ''), duration: value.duration, chapters };
}

function splitsSurrogate(text, offset) {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
}

// Keep every character, including punctuation and unmatched words. Only the
// active paragraph needs spans; all other paragraphs stay ordinary text nodes.
export function readAlongWordParts(paragraph) {
  if (!paragraph?.words?.length) return [];
  const parts = [];
  let end = 0;
  paragraph.words.forEach(([start, until], word) => {
    if (start > end) parts.push({ text: paragraph.text.slice(end, start), word: -1 });
    parts.push({ text: paragraph.text.slice(start, until), word });
    end = until;
  });
  if (end < paragraph.text.length) parts.push({ text: paragraph.text.slice(end), word: -1 });
  return parts;
}

export function readAlongWordAt(words, position, text) {
  if (!Array.isArray(words) || !finite(position)) return -1;
  let low = 0, high = words.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, word = words[middle];
    if (position < word[2]) high = middle - 1;
    else if (position >= word[3]) low = middle + 1;
    else return middle;
  }
  // Short acoustic gaps between consecutive written words should not make the
  // highlight blink. Hold the last confirmed word; never anticipate the next
  // one, fill an omitted word, or carry a highlight across a longer pause.
  const previous = words[high], next = words[low];
  if (typeof text === 'string' && previous && next &&
    next[2] - previous[3] <= 0.25 &&
    /^\s+$/u.test(text.slice(previous[1], next[0]))) return high;
  return -1;
}

export function readAlongPosition(document, position) {
  if (!document || !finite(position) || position < 0) return { chapter: -1, paragraph: -1 };
  const chapter = intervalAt(document.chapters, position);
  if (chapter < 0) return { chapter: -1, paragraph: -1 };
  // Only the current chapter is searched, and untimed paragraphs never highlight.
  const paragraphs = document.chapters[chapter].paragraphs;
  const paragraph = paragraphs.findIndex(value => value.start !== null && position >= value.start && position < value.end);
  return { chapter, paragraph };
}

function intervalAt(values, position) {
  let low = 0, high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, value = values[middle];
    if (position < value.start) high = middle - 1;
    else if (position >= value.end) low = middle + 1;
    else return middle;
  }
  return -1;
}
