<script>
  import { posterUrl, backdropUrl } from '../api.js';
  import { seriesIndex, watchState, enrichItem, observeAudioCard, dismissFromContinue, AUTO_WATCHED_PERCENT } from '../stores.js';
  import { episodeCode } from '../format.js';
  import { cardPlayback, seriesSummary, isSeriesItem, isAudioItem, mediaTitle } from '../series-playback.js';
  import { audioPlaybackIssue } from '../audio-playback.js';
  import { audioPresentation } from '../audio-presentation.js';
  // resume: rendered in the Continue Watching row — show which episode and how
  // much is left, and offer a way to drop it from the row.
  let { item, onopen, onplay, resume = false, wide = false } = $props();

  // No poster? Ask OMDb once — the store patch re-renders this card.
  $effect(() => { if (!isAudioItem(item) && !posterUrl(item)) enrichItem(item.id); });

  let cardElement = $state(null);
  // Audio tags and covers load on sight, never by walking the full catalog.
  $effect(() => {
    const value = item;
    if (!cardElement || !isAudioItem(value) || audioPlaybackIssue(value)) return;
    let release = null;
    if (typeof IntersectionObserver === 'undefined') return observeAudioCard(value);
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) release ||= observeAudioCard(value);
      else { release?.(); release = null; }
    }, { rootMargin: '160px' });
    observer.observe(cardElement);
    return () => { observer.disconnect(); release?.(); };
  });

  const audio = $derived(isAudioItem(item));
  const audioInfo = $derived(audio ? audioPresentation(item) : null);
  const current = $derived({ ...item, ...$watchState[item.id] });
  const summary = $derived(item.seriesCard && isSeriesItem(item) ? seriesSummary(item, $seriesIndex, $watchState) : null);
  const watched = $derived(summary ? summary.allWatched : current.watched);
  const poster = $derived(audio ? item.posterUrl || '' : posterUrl(item));
  const embeddedCover = $derived(audioInfo?.coverUrl || '');
  const backdrop = $derived(audio ? '' : backdropUrl(item));
  const title = $derived(audio ? audioInfo.title : mediaTitle(item));
  const playbackIssue = $derived(isAudioItem(item) ? audioPlaybackIssue(item) : '');
  const continueLabel = $derived(isAudioItem(item) ? 'Continue Listening' : 'Continue Watching');
  const year = $derived(item.year || item.omdbYear || '');
  const rating = $derived(item.imdbRating && item.imdbRating !== 'N/A' ? item.imdbRating : '');
  const pct = $derived(item.seriesCard && !resume ? 0 : current.progress?.percent || 0);
  const minsLeft = $derived.by(() => {
    const p = current.progress;
    if (!p?.duration || !p?.currentTime) return 0;
    return Math.max(0, Math.round((p.duration - p.currentTime) / 60));
  });
  // "S3 · E7 · 24 min left" beats repeating "2008 · Series" on a resume card.
  const resumeLine = $derived(
    [isSeriesItem(item) && item.epInfo ? episodeCode(item) : '', minsLeft ? `${minsLeft} min left` : '']
      .filter(Boolean).join(' · '),
  );

  // Art ladder: poster -> frame extracted from the file itself (cropped to
  // 2:3 by object-fit) -> typographic placeholder. Never a broken image.
  let posterFailed = $state(false);
  let backdropFailed = $state(false);
  let embeddedFailed = $state(false);
  $effect(() => { poster; backdrop; embeddedCover; posterFailed = false; backdropFailed = false; embeddedFailed = false; });
  const artSrc = $derived(
    audio ? (poster && !posterFailed ? poster : embeddedCover && !embeddedFailed ? embeddedCover : '')
      : wide && backdrop && !backdropFailed ? backdrop : (poster && !posterFailed ? poster : (backdrop && !backdropFailed ? backdrop : '')),
  );
  function artError() {
    if (audio) {
      if (poster && !posterFailed) posterFailed = true;
      else embeddedFailed = true;
      return;
    }
    if (wide && backdrop && !backdropFailed) backdropFailed = true;
    else if (poster && !posterFailed) posterFailed = true;
    else backdropFailed = true;
  }
</script>

<div class="card" class:wide class:audio bind:this={cardElement} role="button" tabindex="0"
     onclick={() => onopen?.(item)}
     onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onopen?.(item); } }}>
  <div class="art">
    {#if artSrc}
      <img src={artSrc} alt={audio ? '' : title} loading="lazy" decoding="async" onerror={artError} />
    {:else if audio}
      <div class="audio-placeholder" aria-hidden="true">
        <svg viewBox="0 0 64 64" fill="none"><path d="M12 16c8-3 15-2 20 3 5-5 12-6 20-3v33c-8-3-15-2-20 3-5-5-12-6-20-3V16Z" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M32 19v33M18 24c3-1 6 0 9 2M18 31c3-1 6 0 9 2M37 26c3-2 6-3 9-2M37 33c3-2 6-3 9-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <span>AUDIOBOOK</span>
      </div>
    {:else}
      <div class="placeholder">
        <span class="ptitle">{title}</span>
        {#if year}<span class="pyear">{year}</span>{/if}
      </div>
    {/if}

    {#if watched}<span class="badge watched" title={summary ? 'All available episodes watched' : isAudioItem(item) ? 'Listened' : 'Watched'}>✓</span>{/if}

    <!-- Hover: play button -->
    <div class="hover-overlay">
      <button class="play" onclick={(e) => { e.stopPropagation(); onplay?.(resume ? current : cardPlayback(item, $seriesIndex, $watchState)); }} aria-label={`${playbackIssue ? 'Playback info for' : isAudioItem(item) ? 'Listen to' : 'Play'} ${title}`}>
        {#if playbackIssue}<span aria-hidden="true">ⓘ</span>{:else}<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>{/if}
      </button>
    </div>

    {#if resume}
      <button class="dismiss" title={`Remove from ${continueLabel}`}
              aria-label={`Remove ${title} from ${continueLabel}`}
              onclick={(e) => { e.stopPropagation(); dismissFromContinue(item); }}>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    {/if}

    <!-- Always-visible info strip -->
    {#if !audio}<div class="info-strip">
      <span class="t">{title}</span>
      <span class="y">
        {#if resume && resumeLine}
          {resumeLine}
        {:else}
          {year}{isSeriesItem(item) ? ' · Series' : isAudioItem(item) ? ' · Audio' : ''}{rating ? ` · ★ ${rating}` : ''}
          {#if playbackIssue}<span class="compatibility-label">Compatible copy needed</span>{/if}
          {#if summary && summary.watched}<span class="series-progress">{summary.watched} of {summary.total} watched</span>{/if}
        {/if}
      </span>
    </div>{/if}

    {#if pct > 0 && pct < AUTO_WATCHED_PERCENT}
      <div class="progress"><span style={`width:${pct}%`}></span></div>
    {/if}
  </div>
  {#if audio}
    <div class="audio-info">
      <span class="audio-title" title={title}>{title}</span>
      {#if audioInfo.artist}<span class="audio-author">{audioInfo.artist}</span>{/if}
      {#if resume && resumeLine}<span class="audio-resume">{resumeLine}</span>{/if}
      {#if playbackIssue}<span class="compatibility-label">Compatible copy needed</span>{/if}
    </div>
  {/if}
</div>

<style>
  .wide .art { aspect-ratio:16 / 8; border-radius:11px; }
  .wide .info-strip { padding-bottom:16px; }
  .wide .hover-overlay {opacity:1;background:none;place-items:end;padding:16px 14px 54px;}
  .wide .play {width:36px;height:36px;background:#0b0b0ebf;color:white;border:1px solid #fff8;}
  .wide .progress span {background:var(--cta);}
  .wide .t {font-size:1rem;}
  @media(prefers-reduced-motion:reduce){.card .art,.card .play{transition:none;transform:none;}}
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
  .series-progress { display: block; margin-top: 3px; }
  .compatibility-label { display: block; margin-top: 3px; color: #c5a6ff; }

  .progress {
    position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: rgba(0, 0, 0, 0.6);
  }
  .progress span { display: block; height: 100%; background: var(--ink); }

  .audio .art { aspect-ratio: 1; border-radius: 10px; }
  .audio .art img { object-fit: contain; background: #121019; }
  .audio .hover-overlay { place-items: center; padding: 0; }
  .audio-placeholder {
    height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; color: #dfc7f0; position: relative;
    background: linear-gradient(145deg, #5a346c, #2b1a3d 65%, #191521);
  }
  .audio-placeholder::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 9px; background: #ffffff0b; border-right: 1px solid #ffffff17; }
  .audio-placeholder svg { width: 48%; max-width: 96px; }
  .audio-placeholder span { font-size: .58rem; letter-spacing: .18em; color: #d8c2e6; }
  .audio-info { padding: 10px 1px 2px; }
  .audio-title { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    font-size: .92rem; font-weight: 600; line-height: 1.35; color: var(--ink); overflow-wrap: anywhere; }
  .audio-author { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    color: var(--ink-soft); font-size: .76rem; line-height: 1.4; margin-top: 4px; }
  .audio-resume { display: block; color: var(--ink-faint); font-size: .7rem; margin-top: 4px; }
  .audio .compatibility-label { font-size: .7rem; line-height: 1.4; }
  @media(max-width:640px) { .audio-title { font-size: .86rem; } .audio-author { font-size: .71rem; } }
</style>
