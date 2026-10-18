<script>
  import { onMount } from 'svelte';
  import PosterCard from '../lib/components/PosterCard.svelte';
  import { library } from '../lib/stores.js';
  import { navigate } from '../lib/router.js';
  import { collections, loadCollections, collectionCards } from '../lib/collections.js';

  let { id, onopen, onplay } = $props();
  let loaded = $state(false);
  onMount(() => { loadCollections().finally(() => { loaded = true; }); });
  const card = $derived(collectionCards($collections, $library).find(c => c.id === id) || null);
  const watched = $derived(card ? card.films.filter(f => f.watched).length : 0);
</script>

<div class="page">
  <button class="back" onclick={() => navigate('/collections')}>‹ All collections</button>
  {#if card}
    <header>
      <h1 class="display">{card.name}</h1>
      <span class="meta">{card.films.length} films{watched ? ` · ${watched} watched` : ''}</span>
    </header>
    <div class="grid">
      {#each card.films as item (item.id)}
        <PosterCard {item} {onopen} {onplay} />
      {/each}
    </div>
  {:else if loaded}
    <p class="empty">This collection is not in your library.</p>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: var(--maxw); margin: 0 auto; }
  .back { color: var(--ink-soft); font-size: 0.9rem; margin-bottom: var(--s3); }
  header { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--s4) var(--s3); }
  .empty { color: var(--ink-faint); padding: var(--s6) 0; }
  @media (max-width: 640px) { .grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: var(--s3) var(--s2); } }
</style>
