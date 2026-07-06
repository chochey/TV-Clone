<script>
  import Hero from '../lib/components/Hero.svelte';
  import Row from '../lib/components/Row.svelte';
  import { continueWatching, recentlyAdded, genreClusters, libraryStats } from '../lib/stores.js';
  import { navigate } from '../lib/router.js';

  let { onopen, onplay } = $props();

  // Featured: prefer something in progress, else the newest arrival.
  const featured = $derived($continueWatching[0] || $recentlyAdded[0] || null);
  // Rows below the hero exclude the featured item so it isn't shown twice.
  const cont = $derived($continueWatching.filter((i) => i.id !== featured?.id));
</script>

<div class="home">
  {#if featured}
    <div class="herowrap">
      <Hero item={featured} {onopen} {onplay} />

      <!-- Library at a glance — v1's home-stat stack, riding the hero's right edge -->
      <aside class="herostats" aria-label="Library statistics">
        <div class="stat"><span>{$libraryStats.total.toLocaleString()}</span><small class="meta">Total titles</small></div>
        <button class="stat" onclick={() => navigate('/movies')}>
          <span>{$libraryStats.movies.toLocaleString()}</span><small class="meta">Movies</small>
        </button>
        <button class="stat" onclick={() => navigate('/shows')}>
          <span>{$libraryStats.shows.toLocaleString()}</span><small class="meta">Shows</small>
        </button>
        <div class="stat"><span class="accent">{$libraryStats.inProgress.toLocaleString()}</span><small class="meta">In progress</small></div>
        <div class="stat"><span class="accent">{$libraryStats.unwatched.toLocaleString()}</span><small class="meta">Unwatched</small></div>
      </aside>
    </div>
  {/if}

  <div class="rows">
    <Row title="Continue Watching" items={cont} {onopen} {onplay} />
    <Row title="Recently Added" items={$recentlyAdded} {onopen} {onplay} size="lg" />
    {#each $genreClusters as cluster (cluster.name)}
      <Row title={cluster.name} items={cluster.items} {onopen} {onplay} />
    {/each}
  </div>
</div>

<style>
  .home { padding-bottom: var(--s7); }
  .herowrap { position: relative; }
  /* pull the rows up to overlap the hero's fade — cinematic, fills space */
  .rows { position: relative; margin-top: -8vh; z-index: 2; }

  .herostats {
    position: absolute; right: var(--gutter); top: 50%;
    transform: translateY(-52%);
    z-index: 3;
    display: flex; flex-direction: column; gap: var(--s2);
    width: 172px;
  }
  .stat {
    display: flex; flex-direction: column; gap: 2px;
    padding: var(--s3) var(--s4);
    background: rgba(11, 11, 14, 0.55);
    backdrop-filter: blur(12px);
    border-radius: var(--r-md);
    box-shadow: inset 0 0 0 1px var(--line);
    text-align: left;
  }
  .stat span { font-size: 1.45rem; font-weight: 800; letter-spacing: -0.02em; }
  .stat .accent { color: #6db3ff; }
  .stat small { font-size: 0.64rem; }
  button.stat { cursor: pointer; transition: background var(--t-fast), box-shadow var(--t-fast); }
  button.stat:hover { background: rgba(11, 11, 14, 0.75); box-shadow: inset 0 0 0 1px var(--line-strong); }

  /* The hero gets crowded below this — the stack bows out */
  @media (max-width: 1100px) {
    .herostats { display: none; }
  }
</style>
