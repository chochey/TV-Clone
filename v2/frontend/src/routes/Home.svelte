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
    <Hero item={featured} {onopen} {onplay} />
  {/if}

  <div class="rows">
    <Row title="Continue Watching" items={cont} {onopen} {onplay} />
    <Row title="Recently Added" items={$recentlyAdded} {onopen} {onplay} size="lg" />
    {#each $genreClusters as cluster (cluster.name)}
      <Row title={cluster.name} items={cluster.items} {onopen} {onplay} />
    {/each}
  </div>

  <!-- Library at a glance (v1's home-stat panel) -->
  <section class="stats" aria-label="Library statistics">
    <div class="stat"><span>{$libraryStats.total.toLocaleString()}</span><small class="meta">Total titles</small></div>
    <button class="stat" onclick={() => navigate('/movies')}>
      <span>{$libraryStats.movies.toLocaleString()}</span><small class="meta">Movies</small>
    </button>
    <button class="stat" onclick={() => navigate('/shows')}>
      <span>{$libraryStats.shows.toLocaleString()}</span><small class="meta">Shows</small>
    </button>
    <div class="stat"><span>{$libraryStats.inProgress.toLocaleString()}</span><small class="meta">In progress</small></div>
    <div class="stat"><span>{$libraryStats.unwatched.toLocaleString()}</span><small class="meta">Unwatched</small></div>
  </section>
</div>

<style>
  .home { padding-bottom: var(--s7); }
  /* pull the rows up to overlap the hero's fade — cinematic, fills space */
  .rows { position: relative; margin-top: -8vh; z-index: 2; }

  .stats {
    display: flex; flex-wrap: wrap; gap: var(--s3);
    padding: var(--s6) var(--gutter) 0;
    max-width: var(--maxw); margin: 0 auto;
  }
  .stat {
    flex: 1 1 140px;
    display: flex; flex-direction: column; gap: 4px;
    padding: var(--s4);
    background: var(--bg-raised); border-radius: var(--r-md);
    box-shadow: inset 0 0 0 1px var(--line);
    text-align: left;
  }
  .stat span { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.02em; }
  button.stat { cursor: pointer; transition: background var(--t-fast); }
  button.stat:hover { background: rgba(242, 242, 244, 0.08); }
</style>
