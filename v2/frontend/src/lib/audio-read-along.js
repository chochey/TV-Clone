const finite = value => typeof value === 'number' && Number.isFinite(value);

// Never fill gaps with estimated timestamps: untimed passages remain readable.
export function readAlongDocument(value, itemId) {
  if (!value?.available) return null;
  if (value.version !== 1 || value.itemId !== itemId || !finite(value.duration) || value.duration <= 0 || !Array.isArray(value.chapters)) {
    throw new Error('Invalid read-along document');
  }
  const ids = new Set();
  let previousEnd = 0;
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
      return { id, text: paragraph.text, start: timed ? paragraph.start : null, end: timed ? paragraph.end : null,
        page: Number.isInteger(paragraph.page) && paragraph.page > 0 ? paragraph.page : null };
    });
    return { id: String(chapter.id ?? chapterIndex), title: String(chapter.title || `Chapter ${chapterIndex + 1}`),
      start: chapter.start, end: chapter.end, paragraphs };
  });
  if (!chapters.length) throw new Error('Empty read-along document');
  return { title: String(value.title || ''), duration: value.duration, chapters };
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
