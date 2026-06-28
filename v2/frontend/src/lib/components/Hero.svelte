<script>
  import { posterUrl } from '../api.js';
  let { item, onopen, onplay } = $props();

  const art = $derived(posterUrl(item));
  const title = $derived(item.showName || item.title || item.omdbTitle || '');
  const year = $derived(item.year || item.omdbYear || '');
  const rating = $derived(item.imdbRating && item.imdbRating !== 'N/A' ? item.imdbRating : '');
  const runtime = $derived(item.runtime && item.runtime !== 'N/A' ? item.runtime : '');
  const genres = $derived((item.genre || (item.genres || []).join(', ') || '').split(',').slice(0, 3).map((g) => g.trim()).filter(Boolean));
  const plot = $derived(item.plot && item.plot !== 'N/A' ? item.plot : '');
  const resuming = $derived(item.progress?.percent > 0 && item.progress?.percent < 95);
</script>

<section class="hero">
  <!-- Full-bleed cinematic artwork, bright and present — the theatre marquee. -->
  <div class="stage">
    <div class="art" style={`background-image:url(${art})`}></div>
    <div class="vignette"></div>
    <div class="grade"></div>
  </div>

  <!-- The poster itself, framed like a one-sheet on the wall. -->
  <div class="onesheet">
    <img src={art} alt={title} />
    <button class="bigplay" onclick={() => onplay?.(item)} aria-label="Play">▶</button>
  </div>

  <div class="content">
    <span class="kicker">{resuming ? '◖ Continue Watching' : '◖ Now Showing'}</span>
    <h1>{title}</h1>
    <div class="metarow">
      {#if year}<span>{year}</span>{/if}
      {#if item.type === 'show'}<span class="pill">Series</span>{/if}
      {#if runtime}<span>{runtime}</span>{/if}
      {#if rating}<span class="star">★ {rating}</span>{/if}
      {#each genres as g}<span class="genre">{g}</span>{/each}
    </div>
    {#if plot}<p class="plot">{plot}</p>{/if}
    <div class="actions">
      <button class="play" onclick={() => onplay?.(item)}>▶ {resuming ? 'Resume' : 'Play'}</button>
      <button class="ghost" onclick={() => onopen?.(item)}>＋ More Info</button>
    </div>
    {#if resuming}
      <div class="resumebar"><span style={`width:${item.progress.percent}%`}></span></div>
    {/if}
  </div>
</section>

<style>
  .hero {
    position: relative;
    min-height: 92vh;
    display: grid;
    grid-template-columns: 1.1fr 0.9fr;
    align-items: center;
    padding: 0 var(--gutter);
    overflow: hidden;
    isolation: isolate;
  }
  .stage { position: absolute; inset: 0; z-index: -2; }
  .art {
    position: absolute; inset: 0;
    background-size: cover;
    background-position: center 22%;
    /* bright + saturated, NOT blurred into a black void */
    filter: saturate(1.15) contrast(1.02);
    transform: scale(1.04);
    animation: slowpan 32s ease-in-out infinite alternate;
  }
  @keyframes slowpan {
    from { transform: scale(1.04) translateX(0); }
    to   { transform: scale(1.1) translateX(-2%); }
  }
  .vignette {
    position: absolute; inset: 0; z-index: -1;
    background:
      linear-gradient(90deg, var(--paper) 0%, rgba(15,14,12,0.85) 30%, rgba(15,14,12,0.25) 60%, transparent 100%),
      linear-gradient(0deg, var(--paper) 0%, rgba(15,14,12,0.4) 24%, transparent 50%);
  }
  .grade {
    position: absolute; inset: 0; z-index: -1;
    box-shadow: inset 0 0 240px 60px rgba(0,0,0,0.7);
    pointer-events: none;
  }

  .content { position: relative; max-width: 620px; padding: var(--s6) 0; }
  .kicker {
    font-size: 0.8rem; font-weight: 700;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--accent);
  }
  h1 {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: clamp(3rem, 6.5vw, 6rem);
    line-height: 0.98;
    letter-spacing: -0.02em;
    margin: var(--s4) 0;
    text-shadow: 0 6px 40px rgba(0,0,0,0.7);
  }
  .metarow {
    display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center;
    font-size: 0.92rem; color: var(--ink-soft); font-weight: 500;
  }
  .metarow .star { color: var(--accent); font-weight: 700; }
  .metarow .pill, .metarow .genre {
    padding: 3px 10px; border: 1px solid var(--line-strong); border-radius: 99px;
    font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em;
  }
  .plot {
    margin: var(--s4) 0 var(--s5);
    max-width: 52ch; color: var(--ink); font-size: 1.05rem; line-height: 1.6;
    text-shadow: 0 2px 12px rgba(0,0,0,0.6);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .actions { display: flex; gap: var(--s3); }
  .play {
    background: var(--accent); color: var(--accent-ink);
    font-weight: 700; font-size: 1.05rem; padding: 16px 34px; border-radius: var(--r-sm);
    transition: transform var(--t-fast) var(--ease), box-shadow var(--t-fast);
    box-shadow: 0 10px 30px rgba(232,163,61,0.3);
  }
  .play:hover { transform: translateY(-2px); box-shadow: 0 14px 40px rgba(232,163,61,0.45); }
  .ghost {
    background: rgba(244,239,230,0.1); color: var(--ink);
    font-size: 1.05rem; padding: 16px 28px; border-radius: var(--r-sm);
    border: 1px solid var(--line-strong); backdrop-filter: blur(10px);
    transition: background var(--t-fast);
  }
  .ghost:hover { background: rgba(244,239,230,0.18); }
  .resumebar {
    margin-top: var(--s5); height: 4px; max-width: 380px;
    background: rgba(244,239,230,0.18); border-radius: 99px; overflow: hidden;
  }
  .resumebar span { display: block; height: 100%; background: var(--accent); }

  /* Framed one-sheet poster on the right */
  .onesheet {
    position: relative; justify-self: center;
    width: min(30vw, 380px); aspect-ratio: 2/3;
    border-radius: var(--r-md); overflow: hidden;
    box-shadow: 0 40px 90px rgba(0,0,0,0.7), 0 0 0 1px rgba(244,239,230,0.12);
    transform: perspective(1400px) rotateY(-7deg);
    transition: transform var(--t-slow) var(--ease);
  }
  .onesheet:hover { transform: perspective(1400px) rotateY(0deg) scale(1.02); }
  .onesheet img { width: 100%; height: 100%; object-fit: cover; }
  .bigplay {
    position: absolute; inset: 0; margin: auto;
    width: 76px; height: 76px; border-radius: 99px;
    background: rgba(15,14,12,0.55); backdrop-filter: blur(8px);
    border: 1.5px solid rgba(244,239,230,0.5); color: var(--ink);
    font-size: 1.5rem; display: grid; place-items: center;
    opacity: 0; transition: opacity var(--t-med), transform var(--t-fast) var(--ease);
  }
  .onesheet:hover .bigplay { opacity: 1; }
  .bigplay:hover { transform: scale(1.1); background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }

  @media (max-width: 880px) {
    .hero { grid-template-columns: 1fr; }
    .onesheet { display: none; }
  }
</style>
