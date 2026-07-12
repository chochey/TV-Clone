// Hand-rolled history router — two routes don't justify a dependency.
// The v2 server SPA-falls-back every non-asset path to index.html, so
// deep links like /title/abc123 load fine.
import { writable } from 'svelte/store';

function parse(path, search) {
  const m = path.match(/^\/title\/([^/]+)/);
  if (m) return { name: 'title', id: decodeURIComponent(m[1]) };
  if (path === '/movies') return { name: 'movies' };
  if (path === '/shows') return { name: 'shows' };
  if (path === '/search') return { name: 'search' };
  if (path === '/history') return { name: 'history' };
  if (path === '/stats') return { name: 'stats' };
  if (path === '/requests') return { name: 'requests' };
  if (path === '/system') return { name: 'system' };
  if (path === '/downloads') {
    // ?q= deep-links a torrent search (used by the Episodes page).
    const q = new URLSearchParams(search || '').get('q') || '';
    return { name: 'downloads', q };
  }
  if (path === '/organizer') return { name: 'organizer' };
  if (path === '/logs') return { name: 'logs' };
  if (path === '/users') return { name: 'users' };
  if (path === '/duplicates') return { name: 'duplicates' };
  if (path === '/episodes') return { name: 'episodes' };
  return { name: 'home' };
}

export const route = writable(parse(window.location.pathname, window.location.search));

export function navigate(path) {
  window.history.pushState({}, '', path);
  route.set(parse(window.location.pathname, window.location.search));
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => {
  route.set(parse(window.location.pathname, window.location.search));
});
