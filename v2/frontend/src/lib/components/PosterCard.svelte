<script>
  import { posterUrl } from '../api.js';
  let { item, onopen, onplay } = $props();

  const poster = $derived(posterUrl(item));
  const title = $derived(item.showName || item.title || item.omdbTitle || 'Untitled');
  const year = $derived(item.year || item.omdbYear || '');
  const rating = $derived(item.imdbRating && item.imdbRating !== 'N/A' ? item.imdbRating : '');
  const pct = $derived(item.progress?.percent || 0);
</script>

<div class="card" role="button" tabindex="0"
     onclick={() => onopen?.(item)}
     onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onopen?.(item)}>
  <div class="art">
    {#if poster}
      <img src={poster} alt={title} loading="lazy" />
    {:else}
      <div class="placeholder">{title.slice(0, 1)}</div>
    {/if}

    {#if item.watched}<span class="badge watched">✓</span>{/if}
    {#if rating}<span class="badge rating">★ {rating}</span>{/if}

    <!-- Interactive overlay: revealed on hover, like a marquee lighting up -->
    <div class="overlay">
      <button class="play" onclick={(e) => { e.stopPropagation(); onplay?.(item); }} aria-label={`Play ${title}`}>▶</button>
      <div class="info">
        <span class="t">{title}</span>
        <span class="y">{year}{item.type === 'show' ? ' · Series' : ''}</span>
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
    background: var(--paper-raised);
    box-shadow: 0 0 0 1px var(--line);
    transition: transform var(--t-med) var(--ease), box-shadow var(--t-med) var(--ease);
  }
  .card:hover .art, .card:focus-visible .art {
    transform: translateY(-8px) scale(1.03);
    box-shadow: 0 26px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(232,163,61,0.4);
    z-index: 5;
  }
  .art img { width: 100%; height: 100%; object-fit: cover; }
  .placeholder {
    display: grid; place-items: center; width: 100%; height: 100%;
    font-family: var(--font-display); font-size: 3rem; color: var(--ink-faint);
  }
  .badge {
    position: absolute; top: 7px;
    font-size: 0.68rem; font-weight: 700;
    padding: 3px 7px; border-radius: 5px;
    background: rgba(15,14,12,0.78); backdrop-filter: blur(6px);
  }
  .rating { left: 7px; color: var(--accent); }
  .watched { right: 7px; background: var(--accent); color: var(--accent-ink); border-radius: 99px; width: 22px; height: 22px; display: grid; place-items: center; padding: 0; }

  .overlay {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; justify-content: flex-end;
    padding: var(--s3);
    background: linear-gradient(0deg, rgba(15,14,12,0.92) 0%, rgba(15,14,12,0.3) 45%, transparent 70%);
    opacity: 0; transition: opacity var(--t-med);
  }
  .card:hover .overlay, .card:focus-within .overlay { opacity: 1; }
  .play {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.8);
    width: 54px; height: 54px; border-radius: 99px;
    background: var(--accent); color: var(--accent-ink);
    font-size: 1.1rem; display: grid; place-items: center;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    transition: transform var(--t-fast) var(--ease);
  }
  .card:hover .play { transform: translate(-50%, -50%) scale(1); }
  .play:hover { transform: translate(-50%, -50%) scale(1.12); }
  .info { position: relative; }
  .t {
    display: block; font-weight: 600; font-size: 0.9rem; line-height: 1.2;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .y { display: block; font-size: 0.72rem; color: var(--ink-soft); margin-top: 2px; }

  .progress {
    position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: rgba(0,0,0,0.6);
  }
  .progress span { display: block; height: 100%; background: var(--accent); }
</style>
