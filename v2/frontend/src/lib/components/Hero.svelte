<script>
  import { posterUrl } from '../api.js';
  let { item, onopen, onplay } = $props();

  const art = $derived(posterUrl(item));
  const title = $derived(item.showName || item.title || item.omdbTitle || '');
  const year = $derived(item.year || item.omdbYear || '');
  const rating = $derived(item.imdbRating && item.imdbRating !== 'N/A' ? item.imdbRating : '');
  const genres = $derived((item.genre || (item.genres || []).join(', ') || '').split(',').slice(0, 3).map((g) => g.trim()).filter(Boolean));
  const plot = $derived(item.plot && item.plot !== 'N/A' ? item.plot : '');
  const resuming = $derived(item.progress?.percent > 0 && item.progress?.percent < 95);
</script>

<section class="hero">
  <!-- The one blurred-backdrop depth effect, paid for once on home only. -->
  <div class="backdrop" style={`background-image:url(${art})`}></div>
  <div class="scrim"></div>

  <div class="content">
    <span class="kicker meta">{resuming ? 'Continue Watching' : 'Featured'}</span>
    <h1 class="display">{title}</h1>
    <div class="metarow meta">
      {#if year}<span>{year}</span>{/if}
      {#if item.type === 'show'}<span>Series</span>{/if}
      {#if rating}<span class="star">★ {rating}</span>{/if}
      {#each genres as g}<span>{g}</span>{/each}
    </div>
    {#if plot}<p class="plot">{plot}</p>{/if}
    <div class="actions">
      <button class="play" onclick={() => onplay?.(item)}>
        ▶ {resuming ? 'Resume' : 'Play'}
      </button>
      <button class="ghost" onclick={() => onopen?.(item)}>Details</button>
    </div>
  </div>
</section>

<style>
  .hero {
    position: relative;
    min-height: min(72vh, 680px);
    display: flex;
    align-items: flex-end;
    padding: var(--s7) var(--gutter) var(--s6);
    overflow: hidden;
  }
  .backdrop {
    position: absolute;
    inset: -8%;
    background-size: cover;
    background-position: center 30%;
    filter: blur(26px) saturate(1.1) brightness(0.62);
    transform: scale(1.08);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(90deg, var(--paper) 4%, rgba(15, 14, 12, 0.55) 46%, rgba(15, 14, 12, 0.1) 78%),
      linear-gradient(0deg, var(--paper) 2%, transparent 42%);
  }
  .content { position: relative; max-width: 680px; }
  .kicker { color: var(--accent); }
  h1 {
    font-size: clamp(2.6rem, 7vw, 5.4rem);
    margin: var(--s3) 0 var(--s4);
    text-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  }
  .metarow {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s3);
    align-items: center;
  }
  .metarow .star { color: var(--accent); }
  .plot {
    margin: var(--s4) 0 var(--s5);
    max-width: 56ch;
    color: var(--ink-soft);
    font-size: 1.02rem;
    line-height: 1.6;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .actions { display: flex; gap: var(--s3); }
  .play {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    font-size: 1rem;
    padding: 14px 28px;
    border-radius: var(--r-sm);
    transition: transform var(--t-fast) var(--ease), background var(--t-fast);
  }
  .play:hover { transform: translateY(-2px); background: #f2b256; }
  .ghost {
    background: rgba(244, 239, 230, 0.08);
    color: var(--ink);
    font-size: 1rem;
    padding: 14px 24px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line-strong);
    transition: background var(--t-fast);
  }
  .ghost:hover { background: rgba(244, 239, 230, 0.14); }
</style>
