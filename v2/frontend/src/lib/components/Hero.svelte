<script>
  import { posterUrl, backdropUrl } from '../api.js';
  import { enrichItem } from '../stores.js';
  let { item, onopen, onplay } = $props();

  $effect(() => { if (!posterUrl(item)) enrichItem(item.id); });

  const poster = $derived(posterUrl(item));
  const title = $derived(item.showName || item.title || item.omdbTitle || '');
  const year = $derived(item.year || item.omdbYear || '');
  const rating = $derived(item.imdbRating && item.imdbRating !== 'N/A' ? item.imdbRating : '');
  const runtime = $derived(item.runtime && item.runtime !== 'N/A' ? item.runtime : '');
  const genres = $derived((item.genre || (item.genres || []).join(', ') || '').split(',').slice(0, 3).map((g) => g.trim()).filter(Boolean));
  const plot = $derived(item.plot && item.plot !== 'N/A' ? item.plot : '');
  const resuming = $derived(item.progress?.percent > 0 && item.progress?.percent < 95);

  // The real star of the hero: a landscape still from the actual file.
  // Preload it off-DOM; until it lands (or if it 404s) the blurred poster
  // carries the frame as an ambient color wash — never a stretched poster.
  let backdropSrc = $state('');
  $effect(() => {
    const url = backdropUrl(item);
    backdropSrc = '';
    if (!url) return;
    const img = new Image();
    img.onload = () => { backdropSrc = url; };
    img.src = url;
  });
</script>

<section class="hero">
  <div class="stage">
    {#if poster}
      <div class="ambient" style={`background-image:url(${poster})`}></div>
    {/if}
    {#if backdropSrc}
      <img class="backdrop" src={backdropSrc} alt="" />
    {/if}
    <div class="scrim"></div>
  </div>

  <div class="content">
    <span class="kicker meta">{resuming ? 'Continue Watching' : 'Now Playing'}</span>
    <h1 class="display">{title}</h1>
    <div class="metarow">
      {#if year}<span>{year}</span>{/if}
      {#if item.type === 'show'}<span>Series</span>{/if}
      {#if runtime}<span>{runtime}</span>{/if}
      {#if rating}<span class="star">★ {rating}</span>{/if}
      {#if genres.length}<span>{genres.join(', ')}</span>{/if}
    </div>
    {#if plot}<p class="plot">{plot}</p>{/if}
    <div class="actions">
      <button class="play" onclick={() => onplay?.(item)}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        {resuming ? 'Resume' : 'Play'}
      </button>
      <button class="ghost" onclick={() => onopen?.(item)}>More Info</button>
    </div>
    {#if resuming}
      <div class="resumebar"><span style={`width:${item.progress.percent}%`}></span></div>
    {/if}
  </div>
</section>

<style>
  .hero {
    position: relative;
    min-height: 58vh;
    display: flex;
    align-items: flex-end;
    padding: 0 var(--gutter) 9vh;
    overflow: hidden;
    isolation: isolate;
  }
  .stage { position: absolute; inset: 0; z-index: -1; background: var(--bg-sunken); }

  /* Fallback layer: the poster as pure ambience — blurred beyond recognition
     so its baked-in text can never fight the UI. */
  .ambient {
    position: absolute; inset: -8%;
    background-size: cover; background-position: center 20%;
    filter: blur(64px) saturate(1.2) brightness(0.5);
    transform: scale(1.25);
  }

  .backdrop {
    position: absolute; inset: 0;
    width: 100%; height: 100%; object-fit: cover; object-position: center 25%;
    animation: reveal var(--t-slow) var(--ease) both, drift 24s ease-in-out infinite alternate;
  }
  @keyframes reveal { from { opacity: 0; } to { opacity: 1; } }
  @keyframes drift { from { transform: scale(1); } to { transform: scale(1.05); } }

  /* One scrim, three jobs: keep the topbar, the left column and the row
     seam readable while the middle of the still stays bright. */
  .scrim {
    position: absolute; inset: 0;
    background:
      linear-gradient(0deg, var(--bg) 0%, var(--scrim-soft) 22%, transparent 46%),
      linear-gradient(90deg, var(--scrim) 0%, var(--scrim-soft) 34%, transparent 62%),
      linear-gradient(rgba(11, 11, 14, 0.5), transparent 18%);
  }

  .content { position: relative; max-width: 640px; }
  .kicker { color: var(--ink-soft); }
  h1 {
    font-size: clamp(2rem, 3.8vw, 3.4rem);
    margin: var(--s2) 0 var(--s3);
    text-wrap: balance;
  }
  .metarow {
    display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); align-items: center;
    font-size: 0.94rem; color: var(--ink-soft); font-weight: 500;
  }
  .metarow > span + span::before {
    content: '·';
    margin-right: var(--s3);
    color: var(--ink-faint);
  }
  .metarow .star { color: var(--star); font-weight: 600; }
  .plot {
    margin: var(--s3) 0 var(--s4);
    max-width: 56ch; color: var(--ink); font-size: 0.98rem; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .actions { display: flex; gap: var(--s3); }
  .play {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--cta); color: var(--cta-ink);
    font-weight: 700; font-size: 1.02rem; padding: 13px 30px 13px 24px;
    border-radius: var(--r-sm);
    transition: opacity var(--t-fast);
  }
  .play:hover { opacity: 0.86; }
  .ghost {
    background: rgba(242, 242, 244, 0.14); color: var(--ink);
    font-weight: 600; font-size: 1.02rem; padding: 13px 26px;
    border-radius: var(--r-sm); backdrop-filter: blur(10px);
    transition: background var(--t-fast);
  }
  .ghost:hover { background: rgba(242, 242, 244, 0.24); }
  .resumebar {
    margin-top: var(--s5); height: 3px; max-width: 360px;
    background: rgba(242, 242, 244, 0.2); border-radius: 99px; overflow: hidden;
  }
  .resumebar span { display: block; height: 100%; background: var(--ink); }

  @media (max-width: 640px) {
    .hero { min-height: 52vh; padding-bottom: 8vh; }
  }
</style>
