<script>
  import { posterUrl, backdropUrl } from '../api.js';
  import { enrichItem } from '../stores.js';
  let { item, onopen, onplay } = $props();

  // No poster? Ask OMDb once — the store patch re-renders this card.
  $effect(() => { if (!posterUrl(item)) enrichItem(item.id); });

  const poster = $derived(posterUrl(item));
  const backdrop = $derived(backdropUrl(item));
  const title = $derived(item.showName || item.title || item.omdbTitle || 'Untitled');
  const year = $derived(item.year || item.omdbYear || '');
  const rating = $derived(item.imdbRating && item.imdbRating !== 'N/A' ? item.imdbRating : '');
  const pct = $derived(item.progress?.percent || 0);

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
     onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onopen?.(item)}>
  <div class="art">
    {#if artSrc}
      <img src={artSrc} alt={title} loading="lazy" onerror={artError} />
    {:else}
      <div class="placeholder">
        <span class="ptitle">{title}</span>
        {#if year}<span class="pyear">{year}</span>{/if}
      </div>
    {/if}

    {#if item.watched}<span class="badge watched" title="Watched">✓</span>{/if}

    <!-- Hover: darken the base, surface title/meta and a play affordance -->
    <div class="overlay">
      <button class="play" onclick={(e) => { e.stopPropagation(); onplay?.(item); }} aria-label={`Play ${title}`}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div class="info">
        <span class="t">{title}</span>
        <span class="y">
          {year}{item.type === 'show' ? ' · Series' : ''}{rating ? ` · ★ ${rating}` : ''}
        </span>
      </div>
    </div>

    {#if pct > 0 && pct < 95}
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
    background: rgba(11, 11, 14, 0.75); color: var(--ink);
    backdrop-filter: blur(6px);
    box-shadow: 0 0 0 1px var(--line-strong);
  }

  .overlay {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; justify-content: flex-end;
    padding: var(--s3);
    background: linear-gradient(0deg, rgba(11, 11, 14, 0.92) 0%, rgba(11, 11, 14, 0.35) 45%, transparent 70%);
    opacity: 0; transition: opacity var(--t-med);
  }
  .card:hover .overlay, .card:focus-within .overlay { opacity: 1; }
  .play {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.85);
    width: 48px; height: 48px; border-radius: 99px;
    background: var(--cta); color: var(--cta-ink);
    display: grid; place-items: center;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    transition: transform var(--t-fast) var(--ease);
  }
  .card:hover .play { transform: translate(-50%, -50%) scale(1); }
  .play:hover { transform: translate(-50%, -50%) scale(1.1); }
  .info { position: relative; }
  .t {
    display: block; font-weight: 600; font-size: 0.88rem; line-height: 1.2;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .y { display: block; font-size: 0.72rem; color: var(--ink-soft); margin-top: 2px; }

  .progress {
    position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: rgba(0, 0, 0, 0.6);
  }
  .progress span { display: block; height: 100%; background: var(--ink); }
</style>
