<script>
  import { api, posterUrl } from '../lib/api.js';
  import { library, catalog, watchState, collapseShows, searchFilters, searchQuery, updateWatchState, libraryLoaded, session, enrichItem, AUTO_WATCHED_PERCENT, mediaById, watchLater, toggleWatchLater, loadLibrary } from '../lib/stores.js';
  import { savedId } from '../lib/watch-later.js';
  import { navigate } from '../lib/router.js';
  import { seriesEpisodes, seriesPlayTarget, isSeriesItem, isAudioItem } from '../lib/series-playback.js';
  import { episodeTitle, episodeCode } from '../lib/format.js';
  import { deleteBatchResult } from '../lib/delete-batch-result.js';
  import { fmtBytes } from '../lib/dashboard-format.js';
  import { audioPlaybackIssue } from '../lib/audio-playback.js';
  import { audioPresentation } from '../lib/audio-presentation.js';
  import { mergeAudioDetail, audioDetailArtwork, audioDetailDuration } from '../lib/audio-detail.js';
  import SubtitleUpload from '../lib/components/SubtitleUpload.svelte';
  import FixMatch from '../lib/components/FixMatch.svelte';
  import { collections, loadCollections, collectionsOf } from '../lib/collections.js';
  import Row from '../lib/components/Row.svelte';
  import { EMPTY_FILTERS } from '../lib/search-filters.js';
  import { credits, loadHomeData } from '../lib/home-data.js';
  import { playFacts, peopleOf, alsoBy, similarTo, bookSeries, sameSeries, moreByAuthor } from '../lib/title-facts.js';
  import { timeLeft, pausedWhen } from '../lib/tonight.js';

  let { id, onopen, onplay } = $props();

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

  $effect(() => { if (item && !isAudio && !posterUrl(item)) enrichItem(item.id); });

  const playTarget = $derived(isShow ? nextUp : m);
  const resuming = $derived(playTarget?.progress?.percent > 0 && playTarget?.progress?.percent < AUTO_WATCHED_PERCENT);
  const playLabel = $derived(
    (isAudio ? (resuming ? 'Resume listening' : 'Listen') : (resuming ? 'Resume' : 'Play')) + (isShow && playTarget?.epInfo ? ` ${episodeCode(playTarget)}` : ''),
  );

  // ── Below the hero: how it plays, who made it, what's next ─────────
  $effect(() => { loadHomeData(); });
  const people = $derived(peopleOf(m));
  let quality = $state('auto');
  $effect(() => { id; try { quality = localStorage.getItem('v2Quality') || 'auto'; } catch { quality = 'auto'; } });
  const facts = $derived(!isAudio && !isShow ? playFacts(m, { quality }) : []);
  const shelf = $derived(collapseShows($catalog).map((i) => ({ ...i, ...$watchState[i.id] })));
  const director = $derived(people.directors[0] || '');
  const byDirector = $derived(isShow || isAudio ? [] : alsoBy(director, id, shelf, $credits).slice(0, 4));
  const similar = $derived(isAudio ? [] : similarTo(m, shelf, $credits, { exclude: new Set(byDirector.map((i) => i.id)) }));
  // Audiobooks: the rest of the series (read from the titles) and the author's other books.
  const series = $derived(isAudio ? bookSeries(audio.title) : null);
  const inSeries = $derived(isAudio ? sameSeries(m, shelf) : []);
  const byAuthor = $derived(isAudio ? moreByAuthor(m, shelf) : []);
  const resumeLine = $derived(resuming ? [timeLeft(playTarget.progress), pausedWhen(playTarget.progress?.updatedAt)].filter(Boolean).join(' · ') : '');

  // A name opens Search with that director or actor filled in.
  function findPerson(role, name) {
    searchQuery.set('');
    searchFilters.set({ ...EMPTY_FILTERS, [role]: name });
    navigate('/search');
  }

  // Saved for later: one entry stands for a whole show, whichever episode page saved it.
  const saved = $derived(!!savedId(m, $watchLater, $mediaById));
  const saveLabel = $derived(saved ? 'Saved' : isAudio ? 'Listen later' : 'Watch later');

  async function toggleWatched(target) {
    const newVal = !target.watched;
    try { await api.toggleWatched(target.id, newVal, $session?.profileId); } catch { return; }
    updateWatchState(target.id, { watched: newVal });
    if (full && target.id === full.id) full = { ...full, watched: newVal };
    // Finished it: it no longer needs saving for later.
    if (newVal && target.id === m.id && saved) toggleWatchLater(m);
  }

  // ── Delete ─────────────────────────────────────────────────────────
  let showDeleteConfirm = $state(false);
  let showSubtitleUpload = $state(false);
  let showFixMatch = $state(false);
  // After the admin picks another OMDb record: this page's own copy and the library both refetch.
  async function refreshDetails() {
    try { full = await api.item(id); } catch {}
    await loadLibrary($session?.profileId).catch(() => {});
  }
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
    <section class="hero" aria-labelledby="title-h">
      <!-- The poster, blurred once and never animated: an animated blur was the Firefox/Linux lag source. -->
      {#if poster}<img class="hero-bg" src={poster} alt="" aria-hidden="true" />{/if}
      <div class="scrim"></div>

      <div class="content">
        <!-- Go back where they came from (Films, Search, History), not always Home. -->
        <button class="back" onclick={() => (history.length > 1 ? history.back() : navigate('/'))} aria-label="Go back">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Back
        </button>

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
            <div class="head">
              <span class="kicker">{isShow ? 'Series' : isAudio ? 'Audiobook' : 'Film'}{!isAudio && year ? ` · ${year}` : ''}</span>
              <h1 id="title-h" class="display">{title}</h1>
              {#if isAudio && audio.artist}<p class="audio-author">{audio.artist}</p>{/if}
              {#if isAudio && audio.album}<p class="audio-album">{audio.album}</p>{/if}
              <div class="metarow">
                {#if isAudio}
                  {#if audioDuration}<span class="audio-duration">{audioDuration}</span>{/if}
                  {#if chapterCount}<span class="audio-chapters">{chapterCount} chapter{chapterCount === 1 ? '' : 's'}</span>{/if}
                {:else}
                  {#if rated}<span class="chip">{rated}</span>{/if}
                  {#if runtime}<span>{runtime}</span>{/if}
                  {#if rating}<span><span class="star" aria-hidden="true">★</span> {rating}</span>{/if}
                  {#if isShow && seasons.length}<span>{seasons.length} season{seasons.length > 1 ? 's' : ''}</span>{/if}
                  {#if genres.length}<span class="genres">{genres.slice(0, 3).join(', ')}</span>{/if}
                {/if}
              </div>
            </div>

            <div class="body">
              {#if deleteError}<p class="warn" role="alert">{deleteError}</p>{/if}
              {#if plot}<p class="plot">{plot}</p>{/if}
              {#if !isAudio && (people.directors.length || people.actors.length)}
                <p class="credits">
                  {#if people.directors.length}Directed by{' '}{#each people.directors as name, i (name)}{#if i}{', '}{/if}<a href="/search" onclick={(e) => { e.preventDefault(); findPerson('director', name); }}>{name}</a>{/each}{/if}{#if people.directors.length && people.actors.length}<span aria-hidden="true">{' · '}</span>{/if}{#if people.actors.length}With{' '}{#each people.actors as name, i (name)}{#if i}{', '}{/if}<a href="/search" onclick={(e) => { e.preventDefault(); findPerson('actor', name); }}>{name}</a>{/each}{/if}
                </p>
              {/if}
              {#if partOf.length && !isShow && !isAudio}
                <p class="partof">Part of{' '}{#each partOf as c, i (c.id)}{#if i}{', '}{/if}<a href={`/collection/${encodeURIComponent(c.id)}`} onclick={(e) => { e.preventDefault(); navigate(`/collection/${encodeURIComponent(c.id)}`); }}>{c.name}</a>{/each}</p>
              {/if}
              {#if playbackIssue}<p class="compatibility" role="status">{playbackIssue}</p>{/if}
              <div class="actions">
                <button class="play" onclick={() => playTarget && onplay?.(playTarget)}>
                  {#if playbackIssue}<span aria-hidden="true">ⓘ</span>{:else}<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>{/if}
                  {playbackIssue ? 'Playback info' : playLabel}
                </button>
                {#if !isShow}
                  <button class="ghost" class:on={m.watched} onclick={() => toggleWatched(m)}>
                    {m.watched ? (isAudio ? '✓ Listened' : '✓ Watched') : (isAudio ? 'Mark Listened' : 'Mark Watched')}
                  </button>
                {/if}
                {#if m.id}
                  <button class="ghost" class:on={saved} aria-pressed={saved} onclick={() => toggleWatchLater(m)}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>{saveLabel}
                  </button>
                {/if}
                {#if m.id && !isShow && ($session?.role === 'admin' || $session?.permissions?.includes('canSaveMedia'))}
                  <!-- "Save files" permission: the original file, with the library's clean name. -->
                  <a class="ghost" href={`/api/download/${encodeURIComponent(m.id)}`} download>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
                    Download{m.fileSize ? ` · ${fmtBytes(m.fileSize)}` : ''}
                  </a>
                {/if}
                {#if !isAudio && ($session?.role === 'admin' || $session?.permissions?.includes('canFixMatch'))}
                  <!-- "Fix film details" permission: choose the right OMDb record (lib/components/FixMatch.svelte). -->
                  <button class="ghost" onclick={() => { showFixMatch = true; }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/></svg>
                    Wrong {isShow ? 'series' : 'film'}?
                  </button>
                {/if}
                {#if !isAudio && ($session?.role === 'admin' || $session?.permissions?.includes('canSubtitles'))}
                  <button class="ghost" onclick={() => { showSubtitleUpload = true; }}>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3"/></svg>Add subtitles
                  </button>
                {/if}
                {#if $session?.role === 'admin'}
                  <button class="ghost danger" onclick={() => { showDeleteConfirm = true; }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    Delete
                  </button>
                {/if}
              </div>
              {#if resuming}
                <div class="resume">
                  <div class="resumebar" aria-hidden="true"><span style={`width:${playTarget.progress.percent}%`}></span></div>
                  {#if resumeLine}<span>{resumeLine}</span>{/if}
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="below">
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
            <h2 class="oneseason display">{seasons[0] === EXTRAS ? 'Extras' : `Season ${seasons[0]}`}</h2>
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

      {#if facts.length || byDirector.length}
        <div class="facts-row">
          {#if facts.length}
            <section class="howplay" aria-labelledby="howplay-h">
              <h2 id="howplay-h" class="display">How it will play</h2>
              <div class="facts">
                {#each facts as fact (fact.label)}
                  <div class="fact">
                    <span class="fact-label">{fact.label}</span>
                    <span class="fact-value">{fact.value}</span>
                    {#if fact.detail}<span class="fact-detail">{fact.detail}</span>{/if}
                  </div>
                {/each}
              </div>
            </section>
          {/if}
          {#if byDirector.length}
            <aside class="alsoby" aria-labelledby="alsoby-h">
              <h2 id="alsoby-h" class="display">Also by {director}</h2>
              {#each byDirector as film (film.id)}
                <button class="also" onclick={() => onopen?.(film)}>
                  <span class="also-art">{#if posterUrl(film)}<img src={posterUrl(film)} alt="" loading="lazy" />{/if}</span>
                  <span class="also-text">
                    <span class="also-title">{film.title}</span>
                    <span class="also-meta">{[film.year, film.imdbRating && film.imdbRating !== 'N/A' ? `★ ${film.imdbRating}` : '', film.watched ? 'Watched' : ''].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
              {/each}
            </aside>
          {/if}
        </div>
      {/if}

      {#if similar.length}
        <div class="similar"><Row title="If you like this one" items={similar} {onopen} {onplay} /></div>
      {/if}
      {#if inSeries.length}
        <div class="similar"><Row title={`Also in ${series.name}`} items={inSeries} {onopen} {onplay}
             subtitle={`${inSeries.length + 1} books in your library · this is book ${series.number}`} /></div>
      {/if}
      {#if byAuthor.length}
        <div class="similar"><Row title={`More by ${audio.artist}`} items={byAuthor} {onopen} {onplay} /></div>
      {/if}
    </div>
  </div>

  {#if showFixMatch}
    <FixMatch item={m} onclose={() => { showFixMatch = false; }} onchanged={refreshDetails} />
  {/if}
  {#if showSubtitleUpload}
    <SubtitleUpload {title} items={isShow ? episodes : [m]} initialId={isShow ? (nextUp?.id || episodes[0]?.id) : m.id}
                    onclose={() => { showSubtitleUpload = false; }} />
  {/if}

  {#if showDeleteConfirm}
    <div class="modal-backdrop" role="presentation" onclick={(ev) => { if (ev.target === ev.currentTarget && !deleting) showDeleteConfirm = false; }}
         onkeydown={(ev) => ev.key === 'Escape' && !deleting && (showDeleteConfirm = false)}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
        <h2 id="delete-title">Delete {isShow ? 'Show' : isAudio ? 'Audio file' : 'Movie'}</h2>
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
  .hero { position: relative; overflow: hidden; background: var(--bg); }
  .hero-bg {
    position: absolute; inset: -60px; width: calc(100% + 120px); height: calc(100% + 120px);
    object-fit: cover; object-position: center 20%;
    filter: blur(36px) saturate(1.15); opacity: 0.5; transform: scale(1.15);
  }
  .scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(14, 12, 11, 0.25) 0%, rgba(14, 12, 11, 0.75) 55%, var(--bg) 100%); }

  .content {
    position: relative;
    padding: calc(64px + var(--s4)) var(--gutter) var(--s5);
    max-width: var(--maxw); margin: 0 auto;
  }
  .back {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--ink-soft); font-size: 0.9rem; font-weight: 600;
    min-height: 40px; padding: 0 14px 0 8px; margin-left: -8px; border-radius: var(--r-pill);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .back:hover { color: var(--ink); background: rgba(243, 237, 228, 0.08); }

  .cols { display: flex; gap: 44px; align-items: flex-end; margin-top: var(--s5); }
  .posterwrap { position: relative; flex: 0 0 260px; }
  .poster {
    width: 100%; aspect-ratio: 2 / 3; object-fit: cover; display: block;
    border-radius: 10px;
    box-shadow: 0 30px 60px rgba(0, 0, 0, 0.6);
  }
  .pph {
    display: flex; align-items: flex-end; padding: var(--s4);
    background: linear-gradient(160deg, var(--bg-raised), var(--bg-sunken));
    color: var(--ink-soft); font-family: var(--font-display); font-size: 1.4rem;
  }
  .info { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .head, .body { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

  .audio-detail .posterwrap { flex-basis: clamp(190px, 22vw, 280px); }
  .audio-detail .poster { aspect-ratio: 1; object-fit: contain; background: var(--bg-sunken); }
  .audio-detail .cols { align-items: center; }
  .audio-detail h1 { font-size: clamp(1.9rem, 3.6vw, 3.4rem); overflow-wrap: anywhere; }
  .audio-author { font-size: clamp(1rem, 1.6vw, 1.25rem); color: var(--ink); overflow-wrap: anywhere; }
  .audio-album { color: var(--ink-soft); overflow-wrap: anywhere; }
  .book-placeholder { display: flex !important; flex-direction: column; align-items: center; justify-content: center; gap: var(--s3); color: #ead9bf; background: linear-gradient(145deg, #4a3826, #1d1712) !important; }
  .book-placeholder svg { width: 42%; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .book-placeholder span { font-size: 0.8rem; letter-spacing: 0.12em; text-transform: uppercase; }

  .kicker { color: var(--accent); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
  h1 {
    font-style: italic; font-size: clamp(2.6rem, 6vw, 5.2rem); line-height: 0.95; letter-spacing: -0.015em;
    text-wrap: balance;
  }
  .metarow {
    display: flex; flex-wrap: wrap; gap: var(--s2) 14px; align-items: center;
    font-size: 1rem; color: #d9d1c6;
  }
  .metarow > span + span::before { content: '·'; margin-right: 14px; color: var(--ink-faint); }
  .metarow .star { color: var(--star); }
  .metarow .chip {
    padding: 0 6px; border: 1px solid rgba(243, 237, 228, 0.3); border-radius: 4px;
    font-size: 0.76rem; font-weight: 700;
  }
  .plot { max-width: 68ch; color: #d9d1c6; font-size: 1.06rem; line-height: 1.55; }
  .credits, .partof { color: var(--ink-soft); font-size: 0.9rem; }
  .credits a, .partof a { color: var(--ink); text-decoration: underline; text-underline-offset: 4px; padding: 10px 0; }
  .credits a:hover, .partof a:hover { color: var(--accent); }
  .warn { color: var(--bad); }
  .compatibility { padding: var(--s3); border: 1px solid var(--accent); border-radius: var(--r-sm); line-height: 1.6; }

  .actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 4px; }
  .play {
    display: inline-flex; align-items: center; gap: 10px;
    background: var(--accent); color: var(--accent-ink);
    font-weight: 700; font-size: 1rem; min-height: 50px; padding: 0 26px 0 22px;
    border-radius: var(--r-pill); transition: filter var(--t-fast);
  }
  .play:hover { filter: brightness(1.07); }
  .ghost {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(243, 237, 228, 0.1); color: var(--ink);
    font-weight: 600; font-size: 0.95rem; min-height: 48px; padding: 0 20px;
    border-radius: var(--r-pill);
    transition: background var(--t-fast), color var(--t-fast);
  }
  .ghost:hover { background: rgba(243, 237, 228, 0.18); }
  a.ghost { text-decoration: none; }
  .ghost.on { color: var(--good); }
  .resume { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; color: var(--ink-soft); font-size: 0.88rem; }
  .resumebar {
    flex: 0 1 360px; height: 4px;
    background: rgba(243, 237, 228, 0.16); border-radius: 99px; overflow: hidden;
  }
  .resumebar span { display: block; height: 100%; background: var(--accent); }

  .below { max-width: var(--maxw); margin: 0 auto; padding: var(--s3) 0 var(--s7); display: flex; flex-direction: column; gap: 48px; }
  .below h2 { font-size: 1.65rem; line-height: 1; }
  .facts-row { display: flex; gap: 40px; flex-wrap: wrap; padding: 0 var(--gutter); }
  .howplay { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .fact { background: var(--bg-raised); box-shadow: inset 0 0 0 1px var(--line); border-radius: var(--r-md); padding: 16px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .fact-label { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-faint); }
  .fact-value { font-weight: 600; font-size: 1.02rem; }
  .fact-detail { color: var(--ink-soft); font-size: 0.86rem; line-height: 1.4; overflow-wrap: anywhere; }
  .alsoby { flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .alsoby h2 { margin-bottom: 4px; }
  .also { display: flex; gap: 14px; align-items: center; padding: 10px; border-radius: 10px; background: var(--bg-raised); box-shadow: inset 0 0 0 1px var(--line); text-align: left; transition: background var(--t-fast); }
  .also:hover { background: #221e1b; }
  .also-art { width: 46px; aspect-ratio: 2 / 3; border-radius: 5px; overflow: hidden; background: #2a2521; flex: 0 0 auto; }
  .also-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .also-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .also-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .also-meta { color: var(--ink-soft); font-size: 0.84rem; }
  .similar :global(.row) { margin-top: 0; }

  /* ── Episode list ── */
  .episodes { padding: 0 var(--gutter); }
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
  .oneseason { margin-bottom: var(--s4); }

  .eplist { display: flex; flex-direction: column; }
  .ep {
    display: flex; align-items: center; gap: var(--s4);
    padding: var(--s3) var(--s3);
    border-radius: var(--r-sm);
    cursor: pointer;
    border-top: 1px solid var(--line);
    transition: background var(--t-fast);
  }
  .ep:hover, .ep:focus-visible { background: rgba(243, 237, 228, 0.06); }
  .ep.nextup { background: rgba(243, 237, 228, 0.04); }
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
    background: rgba(243, 237, 228, 0.16); border-radius: 99px; overflow: hidden;
  }
  .epbar span { display: block; height: 100%; background: var(--accent); }
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

  .danger { color: var(--bad); }
  .danger:hover { background: rgba(239, 122, 107, 0.16); color: #f59484; }

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
  .modal h2 { font-family: var(--font-display); font-weight: 400; font-size: 1.5rem; margin-bottom: var(--s3); }
  .modal p { font-size: 0.92rem; line-height: 1.5; color: var(--ink-soft); margin-bottom: var(--s3); }
  .modal .warn { color: var(--bad); font-size: 0.84rem; }
  .modal-actions { display: flex; gap: var(--s3); justify-content: flex-end; margin-top: var(--s5); }
  .del-btn {
    background: var(--bad); color: var(--bg); font-weight: 700; font-size: 0.95rem;
    min-height: 44px; padding: 0 24px; border-radius: var(--r-pill);
    transition: opacity var(--t-fast);
  }
  .del-btn:hover:not(:disabled) { opacity: 0.85; }
  .del-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 900px) {
    .facts { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 720px) {
    /* Phones: a small poster beside the title, everything else full width beneath. */
    .content { padding-top: calc(60px + var(--s2)); padding-bottom: var(--s4); }
    .cols { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 16px 16px; align-items: end; margin-top: var(--s3); }
    .posterwrap, .audio-detail .posterwrap { flex: none; width: 104px; }
    .poster { border-radius: 8px; box-shadow: 0 16px 30px rgba(0, 0, 0, 0.55); }
    .info { display: contents; }
    .head { gap: 8px; }
    .body { grid-column: 1 / -1; gap: 12px; }
    h1, .audio-detail h1 { font-size: 2.1rem; }
    .metarow { font-size: 0.85rem; gap: 4px 10px; }
    .metarow > span + span::before { margin-right: 10px; }
    .metarow .genres { flex-basis: 100%; }
    .metarow .genres::before { content: none; }
    .plot { font-size: 0.95rem; }
    .actions { gap: 8px; }
    .play { flex: 1 1 100%; justify-content: center; }
    .ghost { flex: 1 1 auto; justify-content: center; min-height: 44px; padding: 0 14px; font-size: 0.88rem; }
    .below { gap: 36px; padding-top: var(--s2); }
    .below h2 { font-size: 1.4rem; }
  }
</style>
