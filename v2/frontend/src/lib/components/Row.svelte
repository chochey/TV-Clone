<script>
  import PosterCard from './PosterCard.svelte';
  // card: optional snippet to render each item instead of a poster; onmore adds a "See all" link.
  let { title, items = [], onopen, onplay, size = 'md', resume = false, wide = false, added = false, card = null, onmore = null, moreLabel = 'See all', subtitle = '' } = $props();

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
      {#if subtitle}<span class="sub">{subtitle}</span>{:else}<span class="count">{items.length}</span>{/if}
      {#if onmore}<button class="more" onclick={onmore}>{moreLabel} →</button>{/if}
    </header>
    <div class="trackwrap">
      {#if !atStart}
        <button class="page left" aria-label={`Scroll ${title} left`} onclick={() => page(-1)}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
      {/if}
      <div class="track" class:lg={size === 'lg'} class:wide={wide} bind:this={track} onscroll={measure}>
        {#each items as item (item.id)}
          <div class="cell">{#if card}{@render card(item)}{:else}<PosterCard {item} {onopen} {onplay} {resume} {wide} {added} />{/if}</div>
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
  .more { margin-left: auto; font-size: 0.84rem; font-weight: 600; color: var(--ink-soft); padding: 12px 0; margin-top: -12px; margin-bottom: -12px; }
  .more:hover { color: var(--ink); }
  .row { margin: var(--s5) 0; }
  header {
    display: flex; align-items: baseline; gap: var(--s3);
    padding: 0 var(--gutter); margin-bottom: var(--s3);
  }
  h2 {
    font-family: var(--font-display); font-weight: 400;
    font-size: clamp(1.5rem, 2.4vw, 1.9rem); line-height: 1; letter-spacing: -0.01em;
  }
  .count { font-size: 0.8rem; color: var(--ink-faint); font-weight: 600; }
  .sub { font-size: 0.88rem; color: var(--ink-soft); }

  .trackwrap { position: relative; }
  .track {
    display: flex; gap: 18px;
    overflow-x: auto; overflow-y: visible;
    padding: var(--s2) var(--gutter) var(--s3);
    scroll-snap-type: x proximity;
    scroll-padding-inline: var(--gutter);
    scrollbar-width: none;
  }
  .track::-webkit-scrollbar { display: none; }
  .cell {
    /* min-width: 0 so a long one-line title can't widen (and, through the poster's aspect ratio, heighten) a cell. */
    flex: 0 0 clamp(124px, 11.5vw, 164px); min-width: 0;
    scroll-snap-align: start;
  }
  .track.lg .cell { flex-basis: clamp(140px, 13vw, 184px); }

  .track.wide .cell { flex-basis:clamp(260px,31vw,470px); }

  /* Full-height grab targets at the row edges, revealed on hover like the
     cards themselves. Hidden on touch, where swiping is the natural gesture. */
  .page {
    position: absolute; top: var(--s2); bottom: 52px;
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
