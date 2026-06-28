<script>
  import PosterCard from './PosterCard.svelte';
  let { title, items = [], onopen, onplay, size = 'md' } = $props();
</script>

{#if items.length}
  <section class="row">
    <header>
      <h2>{title}</h2>
      <span class="count">{items.length}</span>
    </header>
    <div class="track" class:lg={size === 'lg'}>
      {#each items as item (item.id)}
        <div class="cell"><PosterCard {item} {onopen} {onplay} /></div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .row { margin: var(--s5) 0; }
  header {
    display: flex; align-items: baseline; gap: var(--s3);
    padding: 0 var(--gutter); margin-bottom: var(--s3);
  }
  h2 {
    font-family: var(--font-display); font-weight: 600;
    font-size: clamp(1.2rem, 2.2vw, 1.7rem); letter-spacing: -0.01em;
  }
  .count {
    font-size: 0.7rem; color: var(--ink-faint); font-weight: 600;
    background: var(--paper-raised); padding: 2px 8px; border-radius: 99px;
    transform: translateY(-3px);
  }
  .track {
    display: flex; gap: var(--s3);
    overflow-x: auto; overflow-y: visible;
    padding: var(--s3) var(--gutter) var(--s4);
    scroll-snap-type: x proximity;
    scrollbar-width: none;
  }
  .track::-webkit-scrollbar { display: none; }
  .cell {
    flex: 0 0 clamp(118px, 11vw, 150px);
    scroll-snap-align: start;
  }
  .track.lg .cell { flex-basis: clamp(150px, 14vw, 188px); }
</style>
