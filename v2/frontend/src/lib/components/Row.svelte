<script>
  import PosterCard from './PosterCard.svelte';
  let { title, items = [], onopen, onplay, size = 'md', resume = false, wide = false } = $props();

  // The track hides its scrollbar, and a plain mouse has no horizontal wheel —
  // without these arrows the row is only reachable by trackpad or touch.
  let track = $state(null);
  let atStart = $state(true);
  let atEnd = $state(false);

  function measure() {
    if (!track) return;
    const max = track.scrollWidth - track.clientWidth;
    atStart = track.scrollLeft <= 1;
    atEnd = max <= 1 || track.scrollLeft >= max - 1;
  }
  function page(dir) {
    if (!track) return;
    track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: 'smooth' });
  }

  $effect(() => {
    if (!track) return;
    items; // re-measure when the row's contents change
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  });
</script>

{#if items.length}
  <section class="row">
    <header>
      <h2>{title}</h2>
      <span class="count">{items.length}</span>
    </header>
    <div class="trackwrap">
      {#if !atStart}
        <button class="page left" aria-label={`Scroll ${title} left`} onclick={() => page(-1)}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
      {/if}
      <div class="track" class:lg={size === 'lg'} class:wide={wide} bind:this={track} onscroll={measure}>
        {#each items as item (item.id)}
          <div class="cell"><PosterCard {item} {onopen} {onplay} {resume} {wide} /></div>
        {/each}
      </div>
      {#if !atEnd}
        <button class="page right" aria-label={`Scroll ${title} right`} onclick={() => page(1)}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        </button>
      {/if}
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
    font-weight: 700;
    font-size: clamp(1.05rem, 1.8vw, 1.35rem); letter-spacing: -0.01em;
  }
  .count { font-size: 0.72rem; color: var(--ink-faint); font-weight: 600; }

  .trackwrap { position: relative; }
  .track {
    display: flex; gap: var(--s3);
    overflow-x: auto; overflow-y: visible;
    padding: var(--s3) var(--gutter) var(--s4);
    scroll-snap-type: x proximity;
    scroll-padding-inline: var(--gutter);
    scrollbar-width: none;
  }
  .track::-webkit-scrollbar { display: none; }
  .cell {
    flex: 0 0 clamp(118px, 11vw, 150px);
    scroll-snap-align: start;
  }
  .track.lg .cell { flex-basis: clamp(150px, 14vw, 188px); }

  .track.wide .cell { flex-basis:clamp(260px,31vw,470px); }

  /* Full-height grab targets at the row edges, revealed on hover like the
     cards themselves. Hidden on touch, where swiping is the natural gesture. */
  .page {
    position: absolute; top: var(--s3); bottom: var(--s4);
    width: calc(var(--gutter) + 12px);
    z-index: 4;
    display: grid; place-items: center;
    color: var(--ink);
    cursor: pointer;
    opacity: 0; transition: opacity var(--t-fast);
  }
  .page.left { left: 0; background: linear-gradient(90deg, var(--bg) 35%, transparent); }
  .page.right { right: 0; background: linear-gradient(270deg, var(--bg) 35%, transparent); }
  .trackwrap:hover .page, .page:focus-visible { opacity: 1; }
  .page:hover { color: var(--ink); }
  @media (hover: none) { .page { display: none; } }
</style>
