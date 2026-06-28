<script>
  import Hero from '../lib/components/Hero.svelte';
  import Row from '../lib/components/Row.svelte';
  import { continueWatching, recentlyAdded, genreClusters } from '../lib/stores.js';

  let { onopen, onplay } = $props();

  // Featured: prefer something in progress, else the newest arrival.
  const featured = $derived($continueWatching[0] || $recentlyAdded[0] || null);
</script>

<div class="home">
  {#if featured}
    <Hero item={featured} {onopen} {onplay} />
  {/if}

  <Row title="Continue Watching" items={$continueWatching} {onopen} />
  <Row title="Recently Added" items={$recentlyAdded} {onopen} size="lg" />

  {#each $genreClusters as cluster (cluster.name)}
    <Row title={cluster.name} items={cluster.items} {onopen} />
  {/each}
</div>

<style>
  .home { padding-bottom: var(--s7); }
</style>
