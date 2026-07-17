<script>
  import PosterCard from '../lib/components/PosterCard.svelte';
  import { library, collapseShows, searchQuery } from '../lib/stores.js';

  let { onopen, onplay } = $props();

  const PAGE = 60;
  // Bind straight to the shared store so the header search box and this
  // page's own input are always the same value.
  const q = searchQuery;
  let shown = $state(PAGE);
  let sentinel = $state(null);

  // Everything, one card per title.
  const pool = $derived(collapseShows($library));

  function haystack(i) {
    return `${i.showName || ''} ${i.title || ''} ${i.omdbTitle || ''}`
      .replace(/^\(auto\)\s*/i, '').toLowerCase();
  }

  const results = $derived.by(() => {
    const needle = $q.trim().toLowerCase();
    if (needle.length < 2) return [];
    const scored = [];
    for (const i of pool) {
      const h = haystack(i);
      const pos = h.indexOf(needle);
      if (pos === -1) continue;
      // startsWith beats word-start beats substring; newer breaks ties
      const wordStart = pos === 0 || h[pos - 1] === ' ';
      scored.push({ i, score: (pos === 0 ? 0 : wordStart ? 1 : 2) * 1e13 + pos * 1e9 - (i.addedAt || 0) / 1e3 });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.i);
  });

  $effect(() => { $q; shown = PAGE; });

  $effect(() => {
    if (!sentinel) return;
    const ob = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) shown = Math.min(shown + PAGE, results.length);
    }, { rootMargin: '900px' });
    ob.observe(sentinel);
    return () => ob.disconnect();
  });
</script>

<div class="search">
  {#if $q.trim().length >= 2}
    <p class="meta rescount">{results.length} result{results.length === 1 ? '' : 's'} for “{$q.trim()}”</p>
    <div class="grid">
      {#each results.slice(0, shown) as item (item.id)}
        <PosterCard {item} {onopen} {onplay} />
      {/each}
    </div>
    {#if shown < results.length}
      <div class="sentinel" bind:this={sentinel}></div>
    {/if}
    {#if !results.length}
      <p class="empty">Nothing matches “{$q.trim()}”.</p>
    {/if}
  {:else}
    <p class="empty hint">Search films and series from the bar above.</p>
  {/if}
</div>

<style>
  .search { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: var(--maxw); margin: 0 auto; }
  .q {
    width: 100%; max-width: 680px; display: block;
    font-size: 1.35rem; font-weight: 500;
    background: transparent; border: none;
    border-bottom: 2px solid var(--line-strong); border-radius: 0;
    padding: 10px 2px 14px;
  }
  .q:focus { border-bottom-color: var(--ink); }
  .q::-webkit-search-cancel-button { -webkit-appearance: none; }

  .rescount { margin: var(--s4) 0 var(--s4); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--s4) var(--s3);
  }
  .sentinel { height: 1px; }
  .empty { color: var(--ink-faint); padding: var(--s6) 0; }
  .hint { text-align: left; }

  @media (max-width: 640px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: var(--s3) var(--s2); }
    .q { font-size: 1.1rem; }
  }
</style>
