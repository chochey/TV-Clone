<script>
  import { api, posterUrl, backdropUrl } from '../lib/api.js';
  import { library, updateWatchState, libraryLoaded, session, enrichItem, AUTO_WATCHED_PERCENT } from '../lib/stores.js';
  import { navigate } from '../lib/router.js';
  import { seriesEpisodes, seriesPlayTarget, isSeriesItem, isAudioItem } from '../lib/series-playback.js';
  import { episodeTitle, episodeCode } from '../lib/format.js';
  import { deleteBatchResult } from '../lib/delete-batch-result.js';
  import { audioPlaybackIssue } from '../lib/audio-playback.js';
  import { audioPresentation } from '../lib/audio-presentation.js';
  import { mergeAudioDetail, audioDetailArtwork, audioDetailDuration } from '../lib/audio-detail.js';
  import SubtitleUpload from '../lib/components/SubtitleUpload.svelte';
  import { collections, loadCollections, collectionsOf } from '../lib/collections.js';

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
  const m = $derived(mergeAudioDetail(item, full));
  $effect(() => { loadCollections(); });
  const partOf = $derived(collectionsOf(id, $collections));

  const isShow = $derived(isSeriesItem(m));
  const isAudio = $derived(isAudioItem(m));
  const audio = $derived(audioPresentation(m));
  const playbackIssue = $derived(isAudio ? audioPlaybackIssue(m) : '');
  const title = $derived(isShow ? m.showName : isAudio ? audio.title : (m.title || m.omdbTitle || ''));
  const artwork = $derived(isAudio ? audioDetailArtwork(m) : [posterUrl(m)].filter(Boolean));
  const artworkKey = $derived(`${id}\n${artwork.join('\n')}`);
  let artworkIndex = $state(0);
  $effect(() => { artworkKey; artworkIndex = 0; });
  const poster = $derived(artwork[artworkIndex] || '');
  const audioDuration = $derived(audioDetailDuration(audio.duration));
  const chapterCount = $derived(Array.isArray(m.audioMetadata?.chapters) ? m.audioMetadata.chapters.length : 0);
  const year = $derived(m.year || m.omdbYear || '');
  const rating = $derived(m.imdbRating && m.imdbRating !== 'N/A' ? m.imdbRating : '');
  // OMDb reports a per-episode runtime for some series and gets it badly wrong
  // — Top Gear, Reacher, Fringe and eleven others come back as "1 min", which
  // then leads the metadata row. Nothing real is under five minutes, so treat
  // anything shorter as missing rather than printing a number we know is false.
  const runtime = $derived.by(() => {
    const raw = m.runtime;
    if (!raw || raw === 'N/A') return '';
    const mins = parseInt(String(raw), 10);
    return !isAudio && Number.isFinite(mins) && mins < 5 ? '' : raw;
  });
  const rated = $derived(m.rated && m.rated !== 'N/A' ? m.rated : '');
  const genres = $derived((m.genre || (m.genres || []).join(', ') || '').split(',').map((g) => g.trim()).filter(Boolean));
  const plot = $derived(m.plot && m.plot !== 'N/A' ? m.plot : '');

  // ── Episodes (shows only) ──────────────────────────────────────────
  const episodes = $derived(isShow ? seriesEpisodes(m, $library) : []);
  // Episodes whose season never parsed (specials, movies, oddly-named files)
  // used to have no tab they could appear under, so they were in the library
  // but unreachable from the show. Give them a home.
  const EXTRAS = 'extras';
  const hasExtras = $derived(episodes.some((e) => e.epInfo?.season == null));
  const seasons = $derived([
    ...[...new Set(episodes.map((e) => e.epInfo?.season).filter((s) => s != null))].sort((a, b) => a - b),
    ...(hasExtras ? [EXTRAS] : []),
  ]);
  const nextUp = $derived(isShow ? seriesPlayTarget(m, $library) : null);

  let season = $state(null);
  $effect(() => { id; season = null; });
  $effect(() => {
    if (season == null && seasons.length) season = nextUp?.epInfo?.season ?? seasons[0];
  });
  const seasonEpisodes = $derived(
    season === EXTRAS
      ? episodes.filter((e) => e.epInfo?.season == null)
      : episodes.filter((e) => e.epInfo?.season === season),
  );

  // ── Backdrop stage (same ladder as the home hero) ──────────────────
  const artItem = $derived(isShow ? (nextUp || item) : item);
  let backdropSrc = $state('');
  $effect(() => {
    const url = !isAudio && artItem?.id ? backdropUrl(artItem) : '';
    backdropSrc = '';
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.onload = () => { if (alive) backdropSrc = url; };
    img.src = url;
    return () => { alive = false; };
  });
  $effect(() => { if (item && !isAudio && !posterUrl(item)) enrichItem(item.id); });

  const playTarget = $derived(isShow ? nextUp : m);
  const resuming = $derived(playTarget?.progress?.percent > 0 && playTarget?.progress?.percent < AUTO_WATCHED_PERCENT);
  const playLabel = $derived(
    (isAudio ? (resuming ? 'Resume listening' : 'Listen') : (resuming ? 'Resume' : 'Play')) + (isShow && playTarget?.epInfo ? ` ${episodeCode(playTarget)}` : ''),
  );

  async function toggleWatched(target) {
    const newVal = !target.watched;
    try { await api.toggleWatched(target.id, newVal, $session?.profileId); } catch { return; }
    updateWatchState(target.id, { watched: newVal });
    if (full && target.id === full.id) full = { ...full, watched: newVal };
  }

  // ── Delete ─────────────────────────────────────────────────────────
  let showDeleteConfirm = $state(false);
  let showSubtitleUpload = $state(false);
  let deleting = $state(false);
  let deleteError = $state('');

  const deleteTargets = $derived(isShow ? episodes : (m.id ? [m] : []));
  const deleteCount = $derived(deleteTargets.length);

  async function confirmDelete() {
    deleting = true; deleteError = '';
    try {
      // One batched request for the whole show — the server pays the
      // library-cache rewrite once instead of once per episode.
      const result = deleteBatchResult(deleteTargets.map((t) => t.id), await api.deleteMediaBatch(deleteTargets.map((t) => t.id)));
      library.update((list) => {
        const ids = new Set(result.deletedIds);
        return list.filter((i) => !ids.has(i.id));
      });
      showDeleteConfirm = false;
      if (result.failed.length) deleteError = result.error;
      else navigate('/');
    } catch (err) {
      deleteError = err.body?.error || err.message || 'Could not delete this title. Please try again.';
      showDeleteConfirm = false;
    } finally { deleting = false; }
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
  <div class="detail" class:audio-detail={isAudio}>
    <div class="stage">
      <!-- Ambient wash is the FALLBACK for a missing backdrop. Once the real
           backdrop loads it covers this completely, so painting a 64px blur
           underneath is invisible work on every title page. -->
      {#if poster && !backdropSrc}
        <div class="ambient" style={`background-image:url(${poster})`}></div>
      {/if}
      {#if backdropSrc}
        <img class="backdrop" src={backdropSrc} alt="" />
      {/if}
      <div class="scrim"></div>
    </div>

    <div class="content">
      <!-- Go back where they came from (Films, Search, History), not always Home. -->
      <button class="back" onclick={() => (history.length > 1 ? history.back() : navigate('/'))} aria-label="Go back">← Back</button>

      <div class="cols">
        <div class="posterwrap">
          {#if poster}
            <img class="poster" src={poster} alt={title} onerror={() => { artworkIndex += 1; }} />
          {:else if isAudio}
            <div class="poster book-placeholder" aria-label="Audiobook cover unavailable">
              <svg viewBox="0 0 80 80" aria-hidden="true"><path d="M40 20c-8-6-20-8-30-5v42c10-3 22-1 30 5 8-6 20-8 30-5V15c-10-3-22-1-30 5Zm0 0v42"/><path d="M18 26c5-1 10 0 15 2m-15 9c5-1 10 0 15 2m14-11c5-2 10-3 15-2m-15 13c5-2 10-3 15-2"/></svg>
              <span>Audiobook</span>
            </div>
          {:else}
            <div class="poster pph"><span>{title}</span></div>
          {/if}
        </div>

        <div class="info">
          <span class="kicker meta">{isShow ? 'Series' : isAudio ? 'Audiobook' : 'Film'}{!isAudio && year ? ` · ${year}` : ''}</span>
          <h1 class="display">{title}</h1>
          {#if isAudio && audio.artist}<p class="audio-author">{audio.artist}</p>{/if}
          {#if isAudio && audio.album}<p class="audio-album">{audio.album}</p>{/if}
          <div class="metarow">
            {#if isAudio}
              {#if audioDuration}<span class="audio-duration">{audioDuration}</span>{/if}
              {#if chapterCount}<span class="audio-chapters">{chapterCount} chapter{chapterCount === 1 ? '' : 's'}</span>{/if}
            {:else}
              {#if runtime}<span>{runtime}</span>{/if}
              {#if rating}<span class="star">★ {rating}</span>{/if}
              {#if rated}<span class="chip">{rated}</span>{/if}
              {#if isShow && seasons.length}<span>{seasons.length} season{seasons.length > 1 ? 's' : ''}</span>{/if}
              {#if genres.length}<span>{genres.slice(0, 4).join(', ')}</span>{/if}
            {/if}
          </div>
          {#if partOf.length && !isShow && !isAudio}
            <p class="partof">Part of {#each partOf as c, i (c.id)}{#if i}, {/if}<a href={`/collection/${encodeURIComponent(c.id)}`} onclick={(e) => { e.preventDefault(); navigate(`/collection/${encodeURIComponent(c.id)}`); }}>{c.name}</a>{/each}</p>
          {/if}
          {#if deleteError}<p class="warn" role="alert">{deleteError}</p>{/if}
          {#if plot}<p class="plot">{plot}</p>{/if}
          {#if playbackIssue}<p class="compatibility" role="status">{playbackIssue}</p>{/if}
          <div class="actions">
            <button class="play" onclick={() => playTarget && onplay?.(playTarget)}>
              {#if playbackIssue}<span aria-hidden="true">ⓘ</span>{:else}<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>{/if}
              {playbackIssue ? 'Playback info' : playLabel}
            </button>
            {#if !isShow}
              <button class="ghost" onclick={() => toggleWatched(m)}>
                {m.watched ? (isAudio ? '✓ Listened' : '✓ Watched') : (isAudio ? 'Mark Listened' : 'Mark Watched')}
              </button>
            {/if}
            {#if $session?.role === 'admin' && !isAudio}
              <button class="ghost" onclick={() => { showSubtitleUpload = true; }}>Add subtitles</button>
            {/if}
            {#if $session?.role === 'admin'}
              <button class="ghost danger" onclick={() => { showDeleteConfirm = true; }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                Delete
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
                >{s === EXTRAS ? 'Extras' : `Season ${s}`}</button>
              {/each}
            </div>
          {:else}
            <h2 class="oneseason">{seasons[0] === EXTRAS ? 'Extras' : `Season ${seasons[0]}`}</h2>
          {/if}

          <div class="eplist">
            {#each seasonEpisodes as e (e.id)}
              {@const pct = e.progress?.percent || 0}
              <div class="ep" class:nextup={e.id === nextUp?.id} role="button" tabindex="0"
                   onclick={() => onplay?.(e)}
                   onkeydown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); onplay?.(e); } }}>
                <span class="num">{e.epInfo?.episode === 0 ? 'SP' : (e.epInfo?.episode ?? '·')}</span>
                <div class="eptext">
                  <span class="eptitle">{episodeTitle(e)}</span>
                  {#if pct > 0 && pct < AUTO_WATCHED_PERCENT}
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

  {#if showSubtitleUpload}
    <SubtitleUpload {title} items={isShow ? episodes : [m]} initialId={isShow ? (nextUp?.id || episodes[0]?.id) : m.id}
                    onclose={() => { showSubtitleUpload = false; }} />
  {/if}

  {#if showDeleteConfirm}
    <div class="modal-backdrop" onclick={() => { if (!deleting) showDeleteConfirm = false; }}
         onkeydown={(ev) => ev.key === 'Escape' && !deleting && (showDeleteConfirm = false)}>
      <div class="modal" onclick={(ev) => ev.stopPropagation()}>
        <h2>Delete {isShow ? 'Show' : isAudio ? 'Audio file' : 'Movie'}</h2>
        <p>Permanently delete <strong>{title}</strong>{isShow ? ` (${deleteCount} episode${deleteCount !== 1 ? 's' : ''})` : ''} from the server?</p>
        <p class="warn">This removes the file{deleteCount > 1 ? 's' : ''} from disk. This cannot be undone.</p>
        <div class="modal-actions">
          <button class="ghost" onclick={() => { showDeleteConfirm = false; }} disabled={deleting}>Cancel</button>
          <button class="del-btn" onclick={confirmDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .partof { margin: var(--s2) 0 0; color: var(--ink-soft); font-size: 0.92rem; }
  .partof a { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
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

  .audio-detail .cols { grid-template-columns: minmax(190px, 280px) minmax(0, 1fr); align-items: center; margin-top: clamp(28px, 8vh, 100px); }
  .audio-detail .poster { display: block; aspect-ratio: 1; object-fit: contain; background: var(--bg-sunken); }
  .audio-detail .info { min-width: 0; }
  .audio-detail h1 { font-size: clamp(1.8rem, 3.4vw, 3.1rem); overflow-wrap: anywhere; margin-bottom: var(--s3); }
  .audio-author { font-size: clamp(1rem, 1.6vw, 1.25rem); color: var(--ink); margin: 0 0 var(--s2); overflow-wrap: anywhere; }
  .audio-album { color: var(--ink-soft); margin: 0 0 var(--s3); overflow-wrap: anywhere; }
  .audio-detail .metarow { margin: var(--s3) 0 var(--s5); }
  .book-placeholder { display: flex !important; flex-direction: column; align-items: center; justify-content: center; gap: var(--s3); color: #d4c7ee; background: linear-gradient(145deg, #44315b, #201b2c) !important; }
  .book-placeholder svg { width: 42%; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .book-placeholder span { font-size: 0.8rem; letter-spacing: 0.12em; text-transform: uppercase; }

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
  .compatibility { margin: var(--s4) 0; padding: var(--s3); border: 1px solid #bd9cff; border-radius: var(--r-sm); line-height: 1.6; }

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

  .danger { color: #e5484d; }
  .danger:hover { background: rgba(229, 72, 77, 0.16); color: #f2555a; }
  .danger svg { vertical-align: -3px; margin-right: 4px; }

  /* ── Delete confirmation modal ── */
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 9000;
    background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(6px);
    display: grid; place-items: center;
    animation: fadeIn 0.15s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } }
  .modal {
    background: var(--bg-raised); border: 1px solid var(--line-strong);
    border-radius: var(--r-md); padding: var(--s5);
    max-width: 420px; width: calc(100% - 32px);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }
  .modal h2 { font-size: 1.2rem; font-weight: 700; margin-bottom: var(--s3); }
  .modal p { font-size: 0.92rem; line-height: 1.5; color: var(--ink-soft); margin-bottom: var(--s3); }
  .modal .warn { color: #e5484d; font-size: 0.84rem; }
  .modal-actions { display: flex; gap: var(--s3); justify-content: flex-end; margin-top: var(--s5); }
  .del-btn {
    background: #e5484d; color: #fff; font-weight: 700; font-size: 0.95rem;
    padding: 10px 24px; border-radius: var(--r-sm);
    transition: opacity var(--t-fast);
  }
  .del-btn:hover:not(:disabled) { opacity: 0.85; }
  .del-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 900px) {
    .cols { grid-template-columns: 1fr; margin-top: 26vh; }
    .posterwrap { display: none; }
    .audio-detail .posterwrap { display: block; }
    .audio-detail .cols { grid-template-columns: 210px minmax(0, 1fr); gap: var(--s4); margin-top: var(--s4); }
  }
  @media (max-width: 640px) {
    .audio-detail .cols { grid-template-columns: minmax(0, 1fr); gap: var(--s5); }
    .audio-detail .posterwrap { width: min(62vw, 260px); margin: 0 auto; }
    .audio-detail .actions { gap: var(--s2); }
    .audio-detail .play, .audio-detail .ghost { flex: 1 1 auto; justify-content: center; padding: 13px 18px; }
  }
</style>
