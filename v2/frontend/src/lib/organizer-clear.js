// Wording for the "clear leftover files" action in the organizer's review screen.

const plural = (count, one, many) => (count === 1 ? one : many);

export function describeClearResult(result) {
  const cleared = result?.cleared || [];
  const left = result?.skipped?.length || 0;
  const files = cleared.reduce((sum, entry) => sum + (entry.files || 0), 0);
  const removed = files
    ? `Removed ${files} leftover ${plural(files, 'file', 'files')} from ${cleared.length} ${plural(cleared.length, 'folder', 'folders')}.`
    : 'Nothing was removed.';
  return left ? `${removed} ${left} ${plural(left, 'was', 'were')} left alone because ${plural(left, 'it', 'they')} changed.` : removed;
}

export function leftoverSummary(entries) {
  const count = entries.length;
  return `Delete the leftover text, image and link files from ${count} ${plural(count, 'folder', 'folders')}? `
    + 'The imported movies and episodes are not touched.';
}
