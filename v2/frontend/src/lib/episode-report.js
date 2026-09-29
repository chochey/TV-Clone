export const epCode = (s,e) => `S${String(s).padStart(2,'0')}E${String(e).padStart(2,'0')}`;
export function recentEpisodes(show, now = Date.now()) {
  return (show.seasons || []).flatMap(s => (s.missing || []).map(e => ({...e, season:s.season})))
    .filter(e => {const t=Date.parse(e.released); return Number.isFinite(t) && t <= now && t >= now-30*86400000;});
}
export function filterShows(report, filter, query, now = Date.now()) {
  const shows = [...(report?.shows || []), ...(report?.unmatched || []).map(show => ({show,unmatched:true,needsCheck:true,seasons:[],missingCount:0}))];
  return shows.filter(s => s.show.toLowerCase().includes(query.trim().toLowerCase()) && (
    filter==='all' || filter==='new' && recentEpisodes(s,now).length || filter==='missing' && s.missingCount>0 ||
    filter==='complete' && s.complete || filter==='check' && s.needsCheck));
}
const normalize = s => s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
// Deliberately conservative: a name match is only a possible download, not proof
// a season pack contains every episode. Never disable Search based on a guess.
export function episodeDownload(torrents, show, season, episode) {
  const title=normalize(show.replace(/\s*\(\d{4}\)\s*$/,''));
  const year=show.match(/\((\d{4})\)\s*$/)?.[1];
  return (torrents || []).find(t => {
    const name=t.name || ''; const match=/\bS(\d{1,2})(?:E(\d{1,3})(?:[- ]?E?(\d{1,3}))?)?\b/i.exec(name);
    if (!match || Number(match[1])!==season) return false;
    let prefix=normalize(name.slice(0,match.index));
    const downloadYear=prefix.match(/\b(19\d{2}|20\d{2})$/)?.[1];
    if (year && downloadYear && year!==downloadYear) return false;
    if(downloadYear) prefix=prefix.replace(/\s*\d{4}$/,'');
    if(prefix!==title) return false;
    if (!match[2]) return true;
    const first=Number(match[2]),last=Number(match[3] || first);
    return episode>=first && episode<=last && last-first<=12;
  });
}
export function downloadLabel(t) {
  if(t.reviewReason || t.importStatus?.label==='Needs review') return 'Needs review';
  if(['error','missingFiles'].includes(t.state)) return 'Download error';
  if(t.progress>=1) return t.importStatus?.label || 'Downloaded — awaiting library';
  if(/paused|stopped/i.test(t.state)) return 'Paused';
  return `Downloading ${Math.round(Math.max(0,Math.min(1,t.progress || 0))*100)}%`;
}
