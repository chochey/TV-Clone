<script>
  import PosterCard from '../lib/components/PosterCard.svelte';
  import { library, collapseShows } from '../lib/stores.js';

  let { kind, onopen, onplay } = $props(); // kind: 'movie' | 'show'

  const PAGE = 60;
  let sort = $state('added');
  let genre = $state('');
  let shown = $state(PAGE);
  let sentinel = $state(null);

  const heading = $derived(kind === 'movie' ? 'Films' : 'Series');

  // One card per title: movies as-is, shows collapsed to a representative.
  const pool = $derived.by(() => {
    const of = $library.filter((i) => i.type === kind);
    return kind === 'show' ? collapseShows(of) : of;
  });

  const genreOptions = $derived.by(() => {
    const counts = new Map();
    for (const i of pool) {
      const gs = [];
      if (Array.isArray(i.genres)) gs.push(...i.genres);
      if (i.genre) gs.push(...i.genre.split(','));
      for (const g of gs.map((x) => x.trim()).filter(Boolean)) {
        counts.set(g, (counts.get(g) || 0) + 1);
      }
    }
    return [...counts.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).map(([g]) => g);
  });

  function displayTitle(i) {
    return (i.showName || i.title || i.omdbTitle || '').replace(/^\(auto\)\s*/i, '');
  }
  function ratingOf(i) {
    const r = parseFloat(i.imdbRating);
    return isNaN(r) ? -1 : r;
  }
  function yearOf(i) {
    const y = parseInt(i.year || i.omdbYear, 10);
    return isNaN(y) ? 0 : y;
  }

  const items = $derived.by(() => {
    let out = pool;
    if (genre) {
      out = out.filter((i) => {
        const gs = `${(i.genres || []).join(',')},${i.genre || ''}`.toLowerCase();
        return gs.includes(genre.toLowerCase());
      });
    }
    out = [...out];
    switch (sort) {
      case 'title': out.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b))); break;
      case 'year': out.sort((a, b) => yearOf(b) - yearOf(a)); break;
      case 'rating': out.sort((a, b) => ratingOf(b) - ratingOf(a)); break;
      default: out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }
    return out;
  });

  // Reset pagination when the view changes.
  $effect(() => { kind; sort; genre; shown = PAGE; });

  // Grow the grid as the sentinel scrolls into view.
  $effect(() => {
    if (!sentinel) return;
    const ob = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) shown = Math.min(shown + PAGE, items.length);
    }, { rootMargin: '900px' });
    ob.observe(sentinel);
    return () => ob.disconnect();
  });
</script>

<div class="browse">
  <header>
    <h1 class="display">{heading}</h1>
    <span class="count meta">{items.length}</span>
    <div class="controls">
      <select bind:value={genre} aria-label="Genre">
        <option value="">All genres</option>
        {#each genreOptions as g (g)}
          <option value={g}>{g}</option>
        {/each}
      </select>
      <select bind:value={sort} aria-label="Sort">
        <option value="added">Recently added</option>
        <option value="title">Title A–Z</option>
        <option value="year">Newest</option>
        <option value="rating">Top rated</option>
      </select>
    </div>
  </header>

  <div class="grid">
    {#each items.slice(0, shown) as item (item.id)}
      <PosterCard {item} {onopen} {onplay} />
    {/each}
  </div>

  {#if shown < items.length}
    <div class="sentinel" bind:this={sentinel}></div>
  {/if}
  {#if !items.length}
    <p class="empty">Nothing here{genre ? ` under “${genre}”` : ''}.</p>
  {/if}
</div>

<style>
  .browse { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: var(--maxw); margin: 0 auto; }
  header {
    display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap;
    margin-bottom: var(--s5);
  }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .count { transform: translateY(-2px); }
  .controls { margin-left: auto; display: flex; gap: var(--s2); }
  select {
    font-family: inherit; font-size: 0.88rem; font-weight: 500; color: var(--ink);
    background: var(--bg-raised); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm); padding: 8px 12px; outline: none; cursor: pointer;
  }
  select:focus { border-color: var(--ink-soft); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--s4) var(--s3);
  }
  .sentinel { height: 1px; }
  .empty { color: var(--ink-faint); padding: var(--s6) 0; text-align: center; }

  @media (max-width: 640px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: var(--s3) var(--s2); }
    .controls { margin-left: 0; width: 100%; }
    .controls select { flex: 1; }
  }
</style>
