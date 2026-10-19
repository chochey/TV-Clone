// Presentation helpers for the Organizer page's activity feed (entries come from
// the server's lib/organizer-activity.js).
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

export function groupByDay(entries, now = Date.now()) {
  const today = dayKey(now), yesterday = dayKey(now - 86400000);
  const groups = [];
  for (const entry of entries) {
    const key = entry.at ? dayKey(entry.at) : 'undated';
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday'
        : entry.at ? new Date(entry.at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : 'Undated';
      group = { key, label, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

export function kindLabel(entry) {
  switch (entry.kind) {
    case 'import': return entry.type === 'show' ? 'Series imported' : 'Film imported';
    case 'skip': return 'Skipped';
    case 'review': return 'Needs review';
    case 'problem': return 'Problem';
    case 'backfill': return 'Episode titles';
    default: return 'Organizer';
  }
}

export function countLabel(entry) {
  const word = entry.kind === 'import' && entry.type === 'show' ? 'episode' : 'file';
  return `${entry.count} ${word}${entry.count === 1 ? '' : 's'}`;
}

// "Seen 13 times" for an outcome that repeats every scan; "Restarted 3 more times" for a run of restarts.
export function repeatLabel(entry) {
  const n = entry.count || 1;
  if (n < 2) return '';
  if (entry.kind === 'start') return `Restarted ${n - 1} more time${n - 1 === 1 ? '' : 's'}`;
  if (['skip', 'review', 'problem'].includes(entry.kind)) return `Seen ${n} times`;
  return '';
}
