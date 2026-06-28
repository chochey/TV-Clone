<script>
  import Hero from '../lib/components/Hero.svelte';
  import Row from '../lib/components/Row.svelte';
  import { continueWatching, recentlyAdded, genreClusters } from '../lib/stores.js';

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
</div>

<style>
  .home { padding-bottom: var(--s7); }
  /* pull the rows up to overlap the hero's fade — cinematic, fills space */
  .rows { position: relative; margin-top: -8vh; z-index: 2; }
</style>
