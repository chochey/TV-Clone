// Hand-rolled history router — two routes don't justify a dependency.
// The v2 server SPA-falls-back every non-asset path to index.html, so
// deep links like /title/abc123 load fine.
import { writable } from 'svelte/store';

function parse(path) {
  const m = path.match(/^\/title\/([^/]+)/);
  if (m) return { name: 'title', id: decodeURIComponent(m[1]) };
  if (path === '/movies') return { name: 'movies' };
  if (path === '/shows') return { name: 'shows' };
  if (path === '/search') return { name: 'search' };
  return { name: 'home' };
}

export const route = writable(parse(window.location.pathname));

export function navigate(path) {
  window.history.pushState({}, '', path);
  route.set(parse(window.location.pathname));
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => {
  route.set(parse(window.location.pathname));
});
