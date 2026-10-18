<script>
  import { onMount } from 'svelte';
  import CollectionCard from '../lib/components/CollectionCard.svelte';
  import { library } from '../lib/stores.js';
  import { navigate } from '../lib/router.js';
  import { collections, loadCollections, collectionCards } from '../lib/collections.js';

  let loaded = $state(false);
  onMount(() => { loadCollections().finally(() => { loaded = true; }); });
  const cards = $derived(collectionCards($collections, $library));
</script>

<div class="page">
  <header>
    <h1 class="display">Collections</h1>
    {#if cards.length}<span class="count meta">{cards.length}</span>{/if}
  </header>
  {#if cards.length}
    <div class="grid">
      {#each cards as card (card.id)}
        <CollectionCard {card} onopen={c => navigate(`/collection/${encodeURIComponent(c.id)}`)} />
      {/each}
    </div>
  {:else if loaded}
    <p class="empty">No collections yet. Films are matched with Wikidata once a day, so new films join their series within a day.</p>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: var(--maxw); margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: var(--s3); margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--s5) var(--s4); }
  .empty { color: var(--ink-faint); padding: var(--s6) 0; }
  @media (max-width: 640px) { .grid { grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: var(--s4) var(--s3); } }
</style>
