<script>
  import { posterUrl, backdropUrl } from '../api.js';
  import { library, enrichItem, dismissFromContinue, AUTO_WATCHED_PERCENT } from '../stores.js';
  import { episodeCode } from '../format.js';
  import { seriesPlayTarget } from '../series-playback.js';
  // resume: rendered in the Continue Watching row — show which episode and how
  // much is left, and offer a way to drop it from the row.
  let { item, onopen, onplay, resume = false } = $props();

  // No poster? Ask OMDb once — the store patch re-renders this card.
  $effect(() => { if (!posterUrl(item)) enrichItem(item.id); });

  const playTarget = $derived(resume ? item : seriesPlayTarget(item, $library));
  const poster = $derived(posterUrl(item));
  const backdrop = $derived(backdropUrl(item));
  const title = $derived(item.showName || item.title || item.omdbTitle || 'Untitled');
  const year = $derived(item.year || item.omdbYear || '');
  const rating = $derived(item.imdbRating && item.imdbRating !== 'N/A' ? item.imdbRating : '');
  const pct = $derived(item.progress?.percent || 0);
  const minsLeft = $derived.by(() => {
    const p = item.progress;
    if (!p?.duration || !p?.currentTime) return 0;
    return Math.max(0, Math.round((p.duration - p.currentTime) / 60));
  });
  // "S3 · E7 · 24 min left" beats repeating "2008 · Series" on a resume card.
  const resumeLine = $derived(
    [item.epInfo ? episodeCode(item) : '', minsLeft ? `${minsLeft} min left` : '']
      .filter(Boolean).join(' · '),
  );

  // Art ladder: poster -> frame extracted from the file itself (cropped to
  // 2:3 by object-fit) -> typographic placeholder. Never a broken image.
  let posterFailed = $state(false);
  let backdropFailed = $state(false);
  $effect(() => { poster; backdrop; posterFailed = false; backdropFailed = false; });
  const artSrc = $derived(
    poster && !posterFailed ? poster : (backdrop && !backdropFailed ? backdrop : ''),
  );
  function artError() {
    if (poster && !posterFailed) posterFailed = true;
    else backdropFailed = true;
  }
</script>

<div class="card" role="button" tabindex="0"
     onclick={() => onopen?.(item)}
     onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onopen?.(item); } }}>
  <div class="art">
    {#if artSrc}
      <img src={artSrc} alt={title} loading="lazy" decoding="async" onerror={artError} />
    {:else}
      <div class="placeholder">
        <span class="ptitle">{title}</span>
        {#if year}<span class="pyear">{year}</span>{/if}
      </div>
    {/if}

    {#if item.watched}<span class="badge watched" title="Watched">✓</span>{/if}

    <!-- Hover: play button -->
    <div class="hover-overlay">
      <button class="play" onclick={(e) => { e.stopPropagation(); onplay?.(playTarget); }} aria-label={`Play ${title}`}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
      </button>
    </div>

    {#if resume}
      <button class="dismiss" title="Remove from Continue Watching"
              aria-label={`Remove ${title} from Continue Watching`}
              onclick={(e) => { e.stopPropagation(); dismissFromContinue(item); }}>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    {/if}

    <!-- Always-visible info strip -->
    <div class="info-strip">
      <span class="t">{title}</span>
      <span class="y">
        {#if resume && resumeLine}
          {resumeLine}
        {:else}
          {year}{item.type === 'show' ? ' · Series' : ''}{rating ? ` · ★ ${rating}` : ''}
        {/if}
      </span>
    </div>

    {#if pct > 0 && pct < AUTO_WATCHED_PERCENT}
      <div class="progress"><span style={`width:${pct}%`}></span></div>
    {/if}
  </div>
</div>

<style>
  .card { display: block; cursor: pointer; }
  .art {
    position: relative;
    aspect-ratio: 2 / 3;
    border-radius: var(--r-sm);
    overflow: hidden;
    background: var(--bg-raised);
    box-shadow: 0 0 0 1px var(--line);
    transition: transform var(--t-med) var(--ease), box-shadow var(--t-med) var(--ease);
  }
  .card:hover .art, .card:focus-visible .art {
    transform: translateY(-6px) scale(1.03);
    box-shadow: 0 22px 44px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--line-strong);
    z-index: 5;
  }
  .art img { width: 100%; height: 100%; object-fit: cover; }

  /* No art: set the title itself, quietly — reads like a spine label */
  .placeholder {
    display: flex; flex-direction: column; justify-content: flex-end;
    gap: var(--s1);
    width: 100%; height: 100%;
    padding: var(--s3);
    background: linear-gradient(160deg, var(--bg-raised), var(--bg-sunken));
  }
  .ptitle {
    font-weight: 600; font-size: 0.88rem; line-height: 1.25; color: var(--ink-soft);
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pyear { font-size: 0.72rem; color: var(--ink-faint); }

  .badge.watched {
    position: absolute; top: 7px; right: 7px;
    width: 22px; height: 22px; border-radius: 99px;
    display: grid; place-items: center;
    font-size: 0.7rem; font-weight: 700;
    background: rgba(11, 11, 14, 0.88); color: var(--ink);
    box-shadow: 0 0 0 1px var(--line-strong);
  }

  /* Sits opposite the watched badge. Hidden until the card is hovered or
     focused so it doesn't clutter the row, but always present on touch, where
     there is no hover to reveal it. */
  .dismiss {
    position: absolute; top: 7px; left: 7px; z-index: 2;
    width: 22px; height: 22px; border-radius: 99px;
    display: grid; place-items: center;
    background: rgba(11, 11, 14, 0.88); color: var(--ink-soft);
    box-shadow: 0 0 0 1px var(--line-strong);
    opacity: 0; transition: opacity var(--t-fast), color var(--t-fast);
    cursor: pointer;
  }
  .card:hover .dismiss, .card:focus-within .dismiss, .dismiss:focus-visible { opacity: 1; }
  .dismiss:hover { color: var(--ink); }
  @media (hover: none) { .dismiss { opacity: 1; } }

  .hover-overlay {
    position: absolute; inset: 0;
    display: grid; place-items: center;
    background: rgba(11, 11, 14, 0.4);
    opacity: 0; transition: opacity var(--t-med);
    pointer-events: none;
  }
  /* On touch there is no hover to reveal this, but `.play` re-enables pointer
     events inside it — which left an invisible 48px play button in the middle
     of every poster that hijacked the tap. Remove it where hover can't happen. */
  @media (hover: none) {
    .hover-overlay { display: none; }
  }
  .card:hover .hover-overlay, .card:focus-within .hover-overlay { opacity: 1; }
  .play {
    width: 48px; height: 48px; border-radius: 99px;
    background: var(--cta); color: var(--cta-ink);
    display: grid; place-items: center;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    transform: scale(0.85);
    transition: transform var(--t-fast) var(--ease);
    pointer-events: auto;
  }
  .card:hover .play { transform: scale(1); }
  .play:hover { transform: scale(1.1); }

  .info-strip {
    position: absolute; left: 0; right: 0; bottom: 0;
    padding: var(--s3);
    padding-top: var(--s5);
    background: linear-gradient(0deg, rgba(11, 11, 14, 0.92) 0%, rgba(11, 11, 14, 0.5) 60%, transparent 100%);
  }
  .t {
    display: block; font-weight: 600; font-size: 0.82rem; line-height: 1.2;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .y { display: block; font-size: 0.68rem; color: var(--ink-soft); margin-top: 2px; }

  .progress {
    position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: rgba(0, 0, 0, 0.6);
  }
  .progress span { display: block; height: 100%; background: var(--ink); }
</style>
