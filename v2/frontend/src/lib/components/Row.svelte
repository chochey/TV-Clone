<script>
  import PosterCard from './PosterCard.svelte';
  let { title, items = [], onopen, size = 'md' } = $props();
</script>

{#if items.length}
  <section class="row">
    <header>
      <h2 class="display">{title}</h2>
      <span class="count meta">{items.length}</span>
    </header>
    <div class="track" class:lg={size === 'lg'}>
      {#each items as item (item.id)}
        <div class="cell"><PosterCard {item} {onopen} /></div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .row { margin: var(--s6) 0; }
  header {
    display: flex;
    align-items: baseline;
    gap: var(--s3);
    padding: 0 var(--gutter);
    margin-bottom: var(--s4);
  }
  h2 { font-size: clamp(1.4rem, 2.6vw, 2.1rem); font-weight: 600; }
  .count { transform: translateY(-2px); }
  .track {
    display: flex;
    gap: var(--s4);
    overflow-x: auto;
    padding: 0 var(--gutter) var(--s2);
    scroll-snap-type: x proximity;
    scrollbar-width: thin;
  }
  .cell {
    flex: 0 0 clamp(132px, 13vw, 168px);
    scroll-snap-align: start;
  }
  .track.lg .cell { flex-basis: clamp(168px, 17vw, 220px); }
</style>
