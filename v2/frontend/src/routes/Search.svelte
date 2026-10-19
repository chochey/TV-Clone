<script>
  import PosterCard from '../lib/components/PosterCard.svelte';
  import { catalog, collapseShows, searchQuery, searchFilters } from '../lib/stores.js';
  import { searchLibrary } from '../lib/search.js';
  import { api } from '../lib/api.js';
  import { EMPTY_FILTERS, filtersActive, genreOptions, creditsIndex, applyFilters, sortResults, nameSuggestions } from '../lib/search-filters.js';

  let { onopen, onplay } = $props();

  const PAGE = 60;
  // Bind straight to the shared store so the header search box and this
  // page's own input are always the same value.
  const q = searchQuery;
  const filters = searchFilters;
  let shown = $state(PAGE);
  let sentinel = $state(null);
  let panelOpen = $state(filtersActive($searchFilters));
  let sort = $state('');

  // Directors and cast are fetched once, the first time they are needed.
  let credits = $state(null);
  let creditsError = $state('');
  let creditsLoading = false;
  async function loadCredits() {
    if (credits || creditsLoading) return;
    creditsLoading = true; creditsError = '';
    try { credits = creditsIndex(await api.libraryCredits()); }
    catch { creditsError = 'Could not load directors and cast. Try again.'; }
    finally { creditsLoading = false; }
  }
  $effect(() => { if (panelOpen || $filters.director.trim() || $filters.actor.trim()) loadCredits(); });

  // Everything, one card per title.
  const pool = $derived(collapseShows($catalog));
  const genres = $derived(genreOptions(pool));
  const typed = $derived($q.trim().length >= 2);
  const filtering = $derived(filtersActive($filters));
  const sortBy = $derived(sort || (typed ? 'relevance' : 'rating'));
  const results = $derived(sortResults(applyFilters(typed ? searchLibrary(pool, $q) : pool, $filters, credits), sortBy));
  const directorHints = $derived(nameSuggestions(credits, 'director', $filters.director));
  const actorHints = $derived(nameSuggestions(credits, 'actor', $filters.actor));

  $effect(() => { $q; $filters; sortBy; shown = PAGE; });
  $effect(() => { if (!typed && sort === 'relevance') sort = ''; });

  $effect(() => {
    if (!sentinel) return;
    const ob = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) shown = Math.min(shown + PAGE, results.length);
    }, { rootMargin: '900px' });
    ob.observe(sentinel);
    return () => ob.disconnect();
  });

  const set = patch => filters.update(f => ({ ...f, ...patch }));
  const toggleGenre = g => set({ genres: $filters.genres.includes(g) ? $filters.genres.filter(x => x !== g) : [...$filters.genres, g] });
  const yearValue = v => { const y = parseInt(v, 10); return Number.isFinite(y) ? y : null; };
  const RATINGS = [0, 5, 6, 6.5, 7, 7.5, 8, 8.5, 9];
  const summary = $derived([
    $filters.type === 'movie' ? 'films' : $filters.type === 'show' ? 'series' : '',
    ...$filters.genres,
    $filters.minRating > 0 || $filters.maxRating < 10 ? `rated ${$filters.minRating}–${$filters.maxRating}` : '',
    $filters.yearFrom != null || $filters.yearTo != null ? `${$filters.yearFrom ?? '…'}–${$filters.yearTo ?? '…'}` : '',
    $filters.director.trim() ? `directed by ${$filters.director.trim()}` : '',
    $filters.actor.trim() ? `with ${$filters.actor.trim()}` : '',
  ].filter(Boolean).join(' · '));
</script>

<div class="search">
  <div class="bar">
    <p class="meta rescount" role="status">
      {#if typed || filtering}
        {results.length} result{results.length === 1 ? '' : 's'}{#if typed} for “{$q.trim()}”{/if}{#if filtering}<span class="sum"> · {summary}</span>{/if}
      {:else}
        Search films and series from the bar above, or narrow the library with filters.
      {/if}
    </p>
    <div class="tools">
      {#if typed || filtering}
        <select bind:value={sort} aria-label="Sort">
          {#if typed}<option value="">Best match</option>{:else}<option value="">Top rated</option>{/if}
          {#if typed}<option value="rating">Top rated</option>{/if}
          <option value="year">Newest</option>
          <option value="recent">Recently added</option>
          <option value="title">Title A–Z</option>
        </select>
      {/if}
      <button class="ftoggle" class:on={filtering} aria-expanded={panelOpen} aria-controls="search-filters"
              onclick={() => { panelOpen = !panelOpen; }}>
        Filters{#if filtering}&nbsp;•{/if}
      </button>
    </div>
  </div>

  {#if panelOpen}
    <section id="search-filters" class="panel" aria-label="Search filters">
      <div class="row">
        <span class="label" id="f-type">Show</span>
        <div class="seg" role="group" aria-labelledby="f-type">
          {#each [['all', 'Everything'], ['movie', 'Films'], ['show', 'Series']] as [value, label] (value)}
            <button aria-pressed={$filters.type === value} onclick={() => set({ type: value })}>{label}</button>
          {/each}
        </div>
      </div>

      {#if genres.length}
        <div class="row">
          <span class="label" id="f-genre">Genre</span>
          <div class="chips" role="group" aria-labelledby="f-genre">
            {#each genres as g (g)}
              <button class="chip" aria-pressed={$filters.genres.includes(g)} onclick={() => toggleGenre(g)}>{g}</button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="grid2">
        <label class="field">
          <span class="label">IMDb rating from</span>
          <select value={$filters.minRating} onchange={e => set({ minRating: parseFloat(e.target.value) })}>
            {#each RATINGS as r (r)}<option value={r}>{r === 0 ? 'Any' : r}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span class="label">to</span>
          <select value={$filters.maxRating} onchange={e => set({ maxRating: parseFloat(e.target.value) })}>
            {#each [...RATINGS.slice(1), 10] as r (r)}<option value={r}>{r === 10 ? 'Any' : r}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span class="label">Year from</span>
          <input type="number" inputmode="numeric" min="1900" max="2100" placeholder="Any" value={$filters.yearFrom ?? ''}
                 oninput={e => set({ yearFrom: yearValue(e.target.value) })} />
        </label>
        <label class="field">
          <span class="label">to</span>
          <input type="number" inputmode="numeric" min="1900" max="2100" placeholder="Any" value={$filters.yearTo ?? ''}
                 oninput={e => set({ yearTo: yearValue(e.target.value) })} />
        </label>
        <label class="field wide">
          <span class="label">Director</span>
          <input type="search" list="director-names" placeholder="e.g. Michael Mann" autocomplete="off" value={$filters.director}
                 oninput={e => set({ director: e.target.value })} />
          <datalist id="director-names">{#each directorHints as n (n)}<option value={n}></option>{/each}</datalist>
        </label>
        <label class="field wide">
          <span class="label">Actor</span>
          <input type="search" list="actor-names" placeholder="e.g. Al Pacino" autocomplete="off" value={$filters.actor}
                 oninput={e => set({ actor: e.target.value })} />
          <datalist id="actor-names">{#each actorHints as n (n)}<option value={n}></option>{/each}</datalist>
        </label>
      </div>
      {#if creditsError}
        <p class="err" role="alert">{creditsError} <button onclick={loadCredits}>Retry</button></p>
      {/if}
      {#if filtering}
        <button class="clear" onclick={() => filters.set({ ...EMPTY_FILTERS })}>Clear filters</button>
      {/if}
    </section>
  {/if}

  {#if typed || filtering}
    <div class="grid">
      {#each results.slice(0, shown) as item (item.id)}
        <PosterCard {item} {onopen} {onplay} />
      {/each}
    </div>
    {#if shown < results.length}
      <div class="sentinel" bind:this={sentinel}></div>
    {/if}
    {#if !results.length}
      <p class="empty">{typed ? `Nothing matches “${$q.trim()}”${filtering ? ' with these filters' : ''}.` : 'Nothing matches these filters.'}</p>
    {/if}
  {/if}
</div>

<style>
  .search { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: var(--maxw); margin: 0 auto; }
  .bar { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; margin: 0 0 var(--s4); }
  .rescount { margin: 0; flex: 1 1 260px; font-size: 0.92rem; text-transform: none; letter-spacing: normal; }
  .sum { color: var(--ink-faint); }
  .tools { display: flex; gap: var(--s2); margin-left: auto; }
  select, input {
    font-family: inherit; font-size: 0.88rem; font-weight: 500; color: var(--ink);
    background: var(--bg-raised); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm); padding: 8px 12px; outline: none;
  }
  select { cursor: pointer; }
  select:focus, input:focus { border-color: var(--ink-soft); }
  .ftoggle {
    font-size: 0.88rem; font-weight: 600; padding: 8px 16px; border-radius: var(--r-sm);
    background: var(--bg-raised); border: 1px solid var(--line-strong); color: var(--ink);
  }
  .ftoggle.on { border-color: var(--cta); }

  .panel {
    display: flex; flex-direction: column; gap: var(--s4);
    background: var(--bg-raised); border: 1px solid var(--line-strong); border-radius: var(--r-md);
    padding: var(--s4); margin-bottom: var(--s5);
  }
  .row { display: flex; gap: var(--s3); align-items: flex-start; flex-wrap: wrap; }
  .label { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-faint); }
  .row > .label { min-width: 64px; padding-top: 8px; }
  .seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 99px; overflow: hidden; }
  .seg button { padding: 7px 16px; font-size: 0.86rem; font-weight: 600; color: var(--ink-soft); }
  .seg button[aria-pressed='true'] { background: var(--ink); color: var(--bg); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
  .chip {
    font-size: 0.82rem; font-weight: 600; padding: 6px 12px; border-radius: 99px;
    border: 1px solid var(--line-strong); color: var(--ink-soft);
  }
  .chip[aria-pressed='true'] { background: var(--cta); border-color: var(--cta); color: var(--cta-ink); }
  .grid2 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s3); }
  .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field.wide { grid-column: span 2; }
  .field input, .field select { width: 100%; box-sizing: border-box; }
  .err { color: var(--ink-soft); margin: 0; }
  .err button, .clear { text-decoration: underline; color: var(--ink-soft); font-size: 0.88rem; }
  .clear { align-self: flex-start; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--s4) var(--s3);
  }
  .sentinel { height: 1px; }
  .empty { color: var(--ink-faint); padding: var(--s6) 0; }

  @media (max-width: 640px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: var(--s3) var(--s2); }
    .grid2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tools { margin-left: 0; width: 100%; }
    .tools select { flex: 1; }
    .row > .label { min-width: 100%; padding-top: 0; }
  }
</style>
