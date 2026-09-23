export const moods = [
  {id:'Comedy',label:'Make me laugh',icon:'☺',color:'#f3bc50'},
  {id:'Action',label:'Action night',icon:'ϟ',color:'#ff777e'},
  {id:'Horror',label:'Something scary',icon:'☾',color:'#ba94ff'},
];
export function moodMatches(items, genre) {
  return items.filter(item => [...(item.genres || []), ...(item.genre || '').split(',')]
    .some(g => g.trim().toLowerCase() === genre.toLowerCase()));
}
export function discoveryPool(items, excludeId) {
  const movies = items.filter(i => i.type === 'movie' && i.id !== excludeId);
  const fresh = movies.filter(i => !i.watched && !(i.progress?.percent > 0));
  return fresh.length ? fresh : movies;
}
export function nextPick(items, currentId, random = Math.random) {
  const others = items.filter(i => i.id !== currentId);
  const pool = others.length ? others : items;
  return pool.length ? pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] : null;
}
