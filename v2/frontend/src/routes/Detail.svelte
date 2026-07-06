<script>
  import { api, posterUrl, backdropUrl } from '../lib/api.js';
  import { library, libraryLoaded, session } from '../lib/stores.js';
  import { navigate } from '../lib/router.js';
  import { episodeTitle, episodeCode } from '../lib/format.js';

  let { id, onplay } = $props();

  // Library snapshot is instant; /api/item fills in runtime + fresh progress.
  const item = $derived($library.find((i) => i.id === id) || null);
  let full = $state(null);
  $effect(() => {
    full = null;
    if (!id) return;
    let alive = true;
    api.item(id).then((d) => { if (alive) full = d; }).catch(() => {});
    return () => { alive = false; };
  });
  const m = $derived({ ...(item || {}), ...(full || {}) });

  const isShow = $derived(m.type === 'show' && !!m.showName);
  const title = $derived(isShow ? m.showName : (m.title || m.omdbTitle || ''));
  const poster = $derived(posterUrl(m));
  const year = $derived(m.year || m.omdbYear || '');
  const rating = $derived(m.imdbRating && m.imdbRating !== 'N/A' ? m.imdbRating : '');
  const runtime = $derived(m.runtime && m.runtime !== 'N/A' ? m.runtime : '');
  const rated = $derived(m.rated && m.rated !== 'N/A' ? m.rated : '');
  const genres = $derived((m.genre || (m.genres || []).join(', ') || '').split(',').map((g) => g.trim()).filter(Boolean));
  const plot = $derived(m.plot && m.plot !== 'N/A' ? m.plot : '');

  // ── Episodes (shows only) ──────────────────────────────────────────
  // The library is one entry per FILE; duplicate copies of an episode
  // ("...Pilot.mkv" + "...Pilot-2.mkv") must collapse to one row. Keep the
  // copy that carries state (progress, watched), else the original file.
  function betterCopy(a, b) {
    const ap = a.progress?.percent > 0, bp = b.progress?.percent > 0;
    if (ap !== bp) return ap ? a : b;
    if (!!a.watched !== !!b.watched) return a.watched ? a : b;
    return (a.filename || '').length <= (b.filename || '').length ? a : b;
  }
  const episodes = $derived.by(() => {
    if (!isShow) return [];
    const byEp = new Map();
    for (const i of $library) {
      if (i.type !== 'show' || i.showName !== m.showName) continue;
      const key = i.epInfo?.season != null && i.epInfo?.episode != null
        ? `${i.epInfo.season}x${i.epInfo.episode}` : i.id;
      const prev = byEp.get(key);
      byEp.set(key, prev ? betterCopy(prev, i) : i);
    }
    return [...byEp.values()].sort((a, b) =>
      (a.epInfo?.season ?? 999) - (b.epInfo?.season ?? 999) ||
      (a.epInfo?.episode ?? 999) - (b.epInfo?.episode ?? 999));
  });
  const seasons = $derived(
    [...new Set(episodes.map((e) => e.epInfo?.season).filter((s) => s != null))].sort((a, b) => a - b),
  );
  const inProgressEp = $derived(
    episodes
      .filter((e) => e.progress?.percent > 0 && e.progress?.percent < 95)
      .sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0))[0] || null,
  );
  // What the big Play button should start: mid-episode > first unwatched > pilot.
  const nextUp = $derived(inProgressEp || episodes.find((e) => !e.watched) || episodes[0] || null);

  let season = $state(null);
  $effect(() => { id; season = null; });
  $effect(() => {
    if (season == null && seasons.length) season = nextUp?.epInfo?.season ?? seasons[0];
  });
  const seasonEpisodes = $derived(episodes.filter((e) => e.epInfo?.season === season));

  // ── Backdrop stage (same ladder as the home hero) ──────────────────
  const artItem = $derived(isShow ? (nextUp || item) : item);
  let backdropSrc = $state('');
  $effect(() => {
    const url = artItem?.id ? backdropUrl(artItem) : '';
    backdropSrc = '';
    if (!url) return;
    const img = new Image();
    img.onload = () => { backdropSrc = url; };
    img.src = url;
  });
  let posterFailed = $state(false);
  $effect(() => { poster; posterFailed = false; });

  const playTarget = $derived(isShow ? nextUp : m);
  const resuming = $derived(playTarget?.progress?.percent > 0 && playTarget?.progress?.percent < 95);
  const playLabel = $derived(
    (resuming ? 'Resume' : 'Play') + (isShow && playTarget?.epInfo ? ` ${episodeCode(playTarget)}` : ''),
  );

  async function toggleWatched(target) {
    const newVal = !target.watched;
    try { await api.toggleWatched(target.id, newVal, $session?.profileId); } catch { return; }
    library.update((list) => list.map((i) => (i.id === target.id ? { ...i, watched: newVal } : i)));
    if (full && target.id === full.id) full = { ...full, watched: newVal };
  }
</script>

{#if !item && !full}
  {#if $libraryLoaded}
    <div class="void">
      <p>That title isn't in the library.</p>
      <button class="ghost" onclick={() => navigate('/')}>Back to Home</button>
    </div>
  {:else}
    <div class="void"><div class="spinner"></div></div>
  {/if}
{:else}
  <div class="detail">
    <div class="stage">
      {#if poster && !posterFailed}
        <div class="ambient" style={`background-image:url(${poster})`}></div>
      {/if}
      {#if backdropSrc}
        <img class="backdrop" src={backdropSrc} alt="" />
      {/if}
      <div class="scrim"></div>
    </div>

    <div class="content">
      <button class="back" onclick={() => navigate('/')} aria-label="Back to home">← Home</button>

      <div class="cols">
        <div class="posterwrap">
          {#if poster && !posterFailed}
            <img class="poster" src={poster} alt={title} onerror={() => { posterFailed = true; }} />
          {:else}
            <div class="poster pph"><span>{title}</span></div>
          {/if}
        </div>

        <div class="info">
          <span class="kicker meta">{isShow ? 'Series' : 'Film'}{year ? ` · ${year}` : ''}</span>
          <h1 class="display">{title}</h1>
          <div class="metarow">
            {#if runtime}<span>{runtime}</span>{/if}
            {#if rating}<span class="star">★ {rating}</span>{/if}
            {#if rated}<span class="chip">{rated}</span>{/if}
            {#if isShow && seasons.length}<span>{seasons.length} season{seasons.length > 1 ? 's' : ''}</span>{/if}
            {#if genres.length}<span>{genres.slice(0, 4).join(', ')}</span>{/if}
          </div>
          {#if plot}<p class="plot">{plot}</p>{/if}
          <div class="actions">
            <button class="play" onclick={() => playTarget && onplay?.(playTarget)}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
              {playLabel}
            </button>
            {#if !isShow}
              <button class="ghost" onclick={() => toggleWatched(m)}>
                {m.watched ? '✓ Watched' : 'Mark Watched'}
              </button>
            {/if}
          </div>
          {#if resuming}
            <div class="resumebar"><span style={`width:${playTarget.progress.percent}%`}></span></div>
          {/if}
        </div>
      </div>

      {#if isShow && seasons.length}
        <div class="episodes">
          {#if seasons.length > 1}
            <div class="seasons" role="tablist">
              {#each seasons as s (s)}
                <button
                  role="tab" aria-selected={s === season}
                  class:active={s === season}
                  onclick={() => { season = s; }}
                >Season {s}</button>
              {/each}
            </div>
          {:else}
            <h2 class="oneseason">Season {seasons[0]}</h2>
          {/if}

          <div class="eplist">
            {#each seasonEpisodes as e (e.id)}
              {@const pct = e.progress?.percent || 0}
              <div class="ep" class:nextup={e.id === nextUp?.id} role="button" tabindex="0"
                   onclick={() => onplay?.(e)}
                   onkeydown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && onplay?.(e)}>
                <span class="num">{e.epInfo?.episode === 0 ? 'SP' : e.epInfo?.episode}</span>
                <div class="eptext">
                  <span class="eptitle">{episodeTitle(e)}</span>
                  {#if pct > 0 && pct < 95}
                    <span class="epbar"><span style={`width:${pct}%`}></span></span>
                  {/if}
                </div>
                <button
                  class="epwatched" class:on={e.watched}
                  title={e.watched ? 'Watched — click to unmark' : 'Mark watched'}
                  aria-label={e.watched ? 'Unmark watched' : 'Mark watched'}
                  onclick={(ev) => { ev.stopPropagation(); toggleWatched(e); }}
                >✓</button>
                <span class="epplay" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .void {
    min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: var(--s4);
    color: var(--ink-soft);
  }
  .spinner {
    width: 30px; height: 30px;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .detail { position: relative; min-height: 100vh; }
  .stage {
    position: absolute; top: 0; left: 0; right: 0; height: 74vh;
    overflow: hidden; background: var(--bg-sunken);
  }
  .ambient {
    position: absolute; inset: -8%;
    background-size: cover; background-position: center 20%;
    filter: blur(64px) saturate(1.2) brightness(0.5);
    transform: scale(1.25);
  }
  .backdrop {
    position: absolute; inset: 0;
    width: 100%; height: 100%; object-fit: cover; object-position: center 25%;
    animation: reveal var(--t-slow) var(--ease) both;
  }
  @keyframes reveal { from { opacity: 0; } to { opacity: 1; } }
  /* Detail carries more text than the home hero — leans darker overall */
  .scrim {
    position: absolute; inset: 0;
    background:
      linear-gradient(0deg, var(--bg) 0%, var(--scrim-soft) 34%, rgba(11,11,14,0.3) 60%, transparent 90%),
      linear-gradient(90deg, var(--scrim) 0%, var(--scrim-soft) 40%, rgba(11,11,14,0.25) 75%, transparent 100%),
      linear-gradient(rgba(11, 11, 14, 0.55), transparent 20%);
  }

  .content {
    position: relative;
    padding: calc(64px + var(--s5)) var(--gutter) var(--s7);
    max-width: var(--maxw); margin: 0 auto;
  }
  .back {
    color: var(--ink-soft); font-size: 0.9rem; font-weight: 600;
    padding: 8px 14px; margin-left: -14px; border-radius: var(--r-sm);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .back:hover { color: var(--ink); background: rgba(242, 242, 244, 0.08); }

  .cols {
    display: grid; grid-template-columns: 250px 1fr;
    gap: var(--s6); align-items: end;
    margin-top: 20vh;
  }
  .posterwrap { position: relative; }
  .poster {
    width: 100%; aspect-ratio: 2 / 3; object-fit: cover;
    border-radius: var(--r-md);
    box-shadow: 0 30px 70px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-strong);
  }
  .pph {
    display: flex; align-items: flex-end; padding: var(--s4);
    background: linear-gradient(160deg, var(--bg-raised), var(--bg-sunken));
    color: var(--ink-soft); font-weight: 600;
  }

  .kicker { color: var(--ink-soft); }
  h1 {
    font-size: clamp(2.2rem, 4.6vw, 4rem);
    margin: var(--s3) 0 var(--s4);
    text-wrap: balance;
  }
  .metarow {
    display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); align-items: center;
    font-size: 0.94rem; color: var(--ink-soft); font-weight: 500;
  }
  .metarow > span + span::before { content: '·'; margin-right: var(--s3); color: var(--ink-faint); }
  .metarow .star { color: var(--star); font-weight: 600; }
  .metarow .chip {
    padding: 1px 8px; border: 1px solid var(--line-strong); border-radius: 4px;
    font-size: 0.76rem; font-weight: 600;
  }
  .metarow .chip::before { content: none !important; }
  .plot { margin: var(--s4) 0 var(--s5); max-width: 68ch; line-height: 1.6; }

  .actions { display: flex; gap: var(--s3); flex-wrap: wrap; }
  .play {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--cta); color: var(--cta-ink);
    font-weight: 700; font-size: 1.02rem; padding: 13px 30px 13px 24px;
    border-radius: var(--r-sm); transition: opacity var(--t-fast);
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
    margin-top: var(--s4); height: 3px; max-width: 360px;
    background: rgba(242, 242, 244, 0.2); border-radius: 99px; overflow: hidden;
  }
  .resumebar span { display: block; height: 100%; background: var(--ink); }

  /* ── Episode list ── */
  .episodes { margin-top: var(--s6); }
  .seasons {
    display: flex; gap: var(--s2); flex-wrap: wrap;
    margin-bottom: var(--s4);
  }
  .seasons button {
    padding: 8px 16px; border-radius: 99px;
    font-size: 0.88rem; font-weight: 600; color: var(--ink-soft);
    background: transparent; box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .seasons button:hover { color: var(--ink); }
  .seasons button.active { background: var(--cta); color: var(--cta-ink); box-shadow: none; }
  .oneseason { font-size: 1.1rem; font-weight: 700; margin-bottom: var(--s4); }

  .eplist { display: flex; flex-direction: column; }
  .ep {
    display: flex; align-items: center; gap: var(--s4);
    padding: var(--s3) var(--s3);
    border-radius: var(--r-sm);
    cursor: pointer;
    border-top: 1px solid var(--line);
    transition: background var(--t-fast);
  }
  .ep:hover, .ep:focus-visible { background: rgba(242, 242, 244, 0.06); }
  .ep.nextup { background: rgba(242, 242, 244, 0.04); }
  .num {
    flex: 0 0 2.2ch; text-align: right;
    font-weight: 700; font-size: 1.05rem; color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .ep.nextup .num { color: var(--ink); }
  .eptext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .eptitle {
    font-weight: 500; font-size: 0.95rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .epbar {
    display: block; height: 3px; max-width: 220px;
    background: rgba(242, 242, 244, 0.16); border-radius: 99px; overflow: hidden;
  }
  .epbar span { display: block; height: 100%; background: var(--ink); }
  .epwatched {
    flex: 0 0 auto; width: 26px; height: 26px; border-radius: 99px;
    display: grid; place-items: center; font-size: 0.72rem; font-weight: 700;
    color: var(--ink-faint); box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: color var(--t-fast), background var(--t-fast), opacity var(--t-fast);
    opacity: 0;
  }
  .ep:hover .epwatched, .epwatched.on { opacity: 1; }
  .epwatched:hover { color: var(--ink); }
  .epwatched.on { background: var(--cta); color: var(--cta-ink); box-shadow: none; }
  .epplay {
    flex: 0 0 auto; width: 34px; height: 34px; border-radius: 99px;
    display: grid; place-items: center;
    background: var(--cta); color: var(--cta-ink);
    opacity: 0; transform: scale(0.85);
    transition: opacity var(--t-fast), transform var(--t-fast) var(--ease);
  }
  .ep:hover .epplay, .ep:focus-visible .epplay { opacity: 1; transform: scale(1); }

  @media (max-width: 900px) {
    .cols { grid-template-columns: 1fr; margin-top: 26vh; }
    .posterwrap { display: none; }
  }
</style>
