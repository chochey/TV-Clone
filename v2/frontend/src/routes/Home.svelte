<script>
  // Tonight: what you're in the middle of first (the newest video as a big
  // Resume card, the newest audiobook as a strip), one pick with a reason, then
  // the shelves. Logic lives in lib/tonight.js.
  import { untrack } from 'svelte';
  import Row from '../lib/components/Row.svelte';
  import PosterCard from '../lib/components/PosterCard.svelte';
  import CollectionCard from '../lib/components/CollectionCard.svelte';
  import { continueWatching, recentlyAdded, genreClusters, libraryStats, catalog, watchState, collapseShows,
    dismissFromContinue, observeAudioCard, requestAudioCard, session, mediaById, watchLater, toggleWatchLater } from '../lib/stores.js';
  import { watchLaterItems } from '../lib/watch-later.js';
  import { posterUrl } from '../lib/api.js';
  import { navigate } from '../lib/router.js';
  import { moods, moodMatches, discoveryPool, nextPick } from '../lib/home-discovery.js';
  import { mediaKindOf, isAudioItem, isSeriesItem } from '../lib/series-playback.js';
  import { continuePreview, filterContinue } from '../lib/continue-preview.js';
  import { audioPresentation, audioChapters, activeAudioChapter } from '../lib/audio-presentation.js';
  import { episodeCode, episodeTitle } from '../lib/format.js';
  import { collections, loadCollections, collectionCards } from '../lib/collections.js';
  import { credits, readAlongIds, bookChapters, loadHomeData } from '../lib/home-data.js';
  import { greeting, summaryLine, timeLeft, pausedWhen, splitInProgress, rankPicks, pickReason } from '../lib/tonight.js';
  let { onopen, onplay } = $props();

  $effect(() => { loadCollections(); loadHomeData(); });

  // ── In progress ──
  const split = $derived(splitInProgress($continueWatching));
  const watching = $derived(split.watching);
  const listening = $derived(split.listening);
  const addedThisWeek = $derived(collapseShows($catalog.filter(i => !isAudioItem(i) && i.addedAt && Date.now() - i.addedAt < 7 * 86400000)).length);
  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => { now = Date.now(); }, 60000); return () => clearInterval(t); });
  const heading = $derived(greeting(now));
  const summary = $derived(summaryLine({ ...split, addedThisWeek }));

  const leadTitle = $derived(watching ? (isSeriesItem(watching) ? watching.showName : watching.title) : '');
  const leadSub = $derived(watching && isSeriesItem(watching) && watching.epInfo ? `${episodeCode(watching)} — ${episodeTitle(watching)}` : '');
  const leadPoster = $derived(watching ? posterUrl(watching) : '');
  const leadPct = $derived(watching?.progress?.percent || 0);
  const leadPaused = $derived(watching ? pausedWhen(watching.progress?.updatedAt, now) : '');
  const leadLeft = $derived(watching ? timeLeft(watching.progress) : '');
  let leadArtFailed = $state(false);
  $effect(() => { leadPoster; leadArtFailed = false; });

  // The audiobook strip loads its tags (title, author, chapters, cover) on sight.
  $effect(() => { if (listening) return observeAudioCard(listening); });
  // Chapters come from the book's detail lookup, which the shelf skips once the catalog has a cover.
  const listeningId = $derived(listening?.id || '');
  $effect(() => { if (listeningId) untrack(() => { if (!$bookChapters.has(listeningId)) requestAudioCard(listening); }); });
  const book = $derived(listening ? audioPresentation(listening) : null);
  const bookCover = $derived(book?.coverUrl || listening?.posterUrl || '');
  const bookChapter = $derived.by(() => {
    const chapters = audioChapters($bookChapters.get(listening?.id), book?.duration);
    if (chapters.length < 2) return '';
    return `Chapter ${activeAudioChapter(chapters, listening.progress?.currentTime) + 1} of ${chapters.length}`;
  });
  const hasReadAlong = $derived(!!listening && $readAlongIds.has(listening.id));

  // Everything in progress besides the two featured above.
  const continued = $derived(continuePreview(split.others));
  let allContinue = $state(false), continueKind = $state('all');
  const allInProgress = $derived(continuePreview($continueWatching).recent);
  const continueItems = $derived(filterContinue(allInProgress, continueKind));

  // ── Tonight's pick ──
  const movies = $derived($catalog.filter(i => mediaKindOf(i) === 'movie').map(i => ({ ...i, ...$watchState[i.id] })));
  const pickContext = $derived({ library: movies, collections: $collections, credits: $credits });
  const ranked = $derived(rankPicks(discoveryPool(movies, watching?.id), pickContext).slice(0, 12));
  let pickIndex = $state(0);
  const pick = $derived(ranked.length ? ranked[pickIndex % ranked.length] : null);
  const reason = $derived(pick ? pickReason(pick, pickContext) : '');
  let pickArtFailed = $state(false);
  $effect(() => { pick?.id; pickArtFailed = false; });
  const pickMeta = $derived(pick ? [pick.year, pick.imdbRating && pick.imdbRating !== 'N/A' ? `★ ${pick.imdbRating}` : '', String(pick.genre || '').split(',')[0]].filter(Boolean).join(' · ') : '');

  // ── Shelves ──
  const collectionRow = $derived(collectionCards($collections, $catalog));
  let mood = $state('');
  const moodItems = $derived(mood ? collapseShows(moodMatches($catalog.filter(i => !isAudioItem(i)), mood)).slice(0, 40) : []);
  function surprise() {
    const choice = nextPick(ranked.length ? ranked : movies, pick?.id);
    if (choice) onopen?.(choice);
  }
  const audioCount = $derived($catalog.filter(isAudioItem).length);
  const saved = $derived(watchLaterItems($watchLater, $mediaById, $watchState));
  const canDashboard = $derived($session?.role === 'admin' || ($session?.permissions || []).includes('canDashboard'));
</script>

<div class="home">
  <section class="top" aria-labelledby="tonight-h">
    <header class="top-head">
      <h1 id="tonight-h" class="display">{heading}</h1>
      <span class="summary">{summary}</span>
    </header>

    <div class="lead-row">
      {#if watching}
        <article class="lead" aria-label="Pick up where you left off">
          {#if leadPoster && !leadArtFailed}<img class="lead-bg" src={leadPoster} alt="" aria-hidden="true" />{/if}
          <div class="lead-body">
            <button class="lead-poster" onclick={() => onopen?.(watching)} aria-label={`Details for ${leadTitle}`}>
              {#if leadPoster && !leadArtFailed}<img src={leadPoster} alt="" onerror={() => { leadArtFailed = true; }} />
              {:else}<span class="art-fallback">{leadTitle}</span>{/if}
            </button>
            <div class="lead-text">
              <span class="kicker">Pick up<span class="wide-inline">{' where you left off'}</span></span>
              <h2 class="display lead-title">{leadTitle}</h2>
              {#if leadSub}<p class="lead-sub">{leadSub}</p>{/if}
              <p class="lead-meta">{#if leadPaused}<span class="paused">{leadPaused}{#if leadLeft}<span aria-hidden="true">{' · '}</span>{/if}</span>{/if}{leadLeft}</p>
              {#if leadPct > 0}<div class="bar" aria-hidden="true"><span style={`width:${Math.min(100, leadPct)}%`}></span></div>{/if}
              <div class="lead-actions">
                <button class="btn primary" onclick={() => onplay?.(watching)}>
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg><span class="lbl">Resume</span>
                </button>
                <button class="btn wide-only" onclick={() => onopen?.(watching)}>Details</button>
                <button class="textbtn" onclick={() => dismissFromContinue(watching)}>Not tonight</button>
              </div>
            </div>
          </div>
        </article>
      {/if}

      {#if pick}
        <aside class="pick" class:big={!watching} aria-label="Tonight's pick">
          <button class="pick-poster" onclick={() => onopen?.(pick)} aria-label={`Details for ${pick.title}`}>
            {#if posterUrl(pick) && !pickArtFailed}<img src={posterUrl(pick)} alt="" onerror={() => { pickArtFailed = true; }} />
            {:else}<span class="art-fallback">{pick.title}</span>{/if}
          </button>
          <div class="pick-text">
            <span class="kicker quiet">Tonight's pick</span>
            <h2 class="display pick-title">{pick.title}</h2>
            {#if pickMeta}<p class="pick-meta">{pickMeta}</p>{/if}
            <p class="pick-reason">{reason}</p>
            <div class="pick-actions">
              <button class="btn wide-only" class:primary={!watching} onclick={() => onplay?.(pick)}>
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>Play
              </button>
              <button class="textbtn wide-only" onclick={() => onopen?.(pick)}>Details</button>
              <button class="textbtn" onclick={() => { pickIndex++; }} disabled={ranked.length < 2} aria-label="Choose another tonight's pick">Another</button>
            </div>
          </div>
        </aside>
      {/if}

      {#if listening}
        <article class="listen" aria-label="Continue listening">
          <button class="listen-cover" onclick={() => onopen?.(listening)} aria-label={`Details for ${book.title}`}>
            {#if bookCover}<img src={bookCover} alt="" />
            {:else}<svg aria-hidden="true" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>{/if}
          </button>
          <div class="listen-head">
            <span class="kicker">Continue listening</span>
            <h2 class="display listen-title">{book.title}</h2>
          </div>
          <div class="listen-info">
            <p class="listen-meta">{[book.artist, bookChapter, timeLeft(listening.progress), hasReadAlong ? 'Read-along ready' : ''].filter(Boolean).join(' · ')}</p>
            {#if listening.progress?.percent}<div class="bar" aria-hidden="true"><span style={`width:${Math.min(100, listening.progress.percent)}%`}></span></div>{/if}
          </div>
          <div class="listen-actions">
            <button class="btn primary" onclick={() => onplay?.(listening)}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg><span class="lbl">Resume</span>
            </button>
            {#if hasReadAlong}
              <button class="btn" onclick={() => onplay?.(listening, { reading: true })}>
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H4z"/><path d="M20 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z"/></svg><span class="lbl">Read along</span>
              </button>
            {/if}
          </div>
        </article>
      {/if}
    </div>

  </section>

  {#if split.others.length}
    <div class="continue-controls">
      <p>{allContinue ? 'Everything you have in progress' : 'Also in progress'}</p>
      <button aria-expanded={allContinue} onclick={() => { allContinue = !allContinue; }}>{allContinue ? 'Show recent' : `View all (${allInProgress.length})`}</button>
    </div>
    {#if allContinue}
      <section class="continue-all" aria-label="All in-progress titles">
        <div class="continue-tabs" aria-label="Filter titles in progress">
          {#each [['all', 'All'], ['watching', 'Watching'], ['listening', 'Listening']] as [value, label]}
            <button aria-pressed={continueKind === value} onclick={() => { continueKind = value; }}>{label}</button>
          {/each}
        </div>
        <div class="continue-grid">{#each continueItems as item (item.id)}<PosterCard {item} {onopen} {onplay} resume />{/each}</div>
        {#if !continueItems.length}<p class="continue-empty">No {continueKind === 'listening' ? 'audiobooks' : 'films or series'} in progress.</p>{/if}
      </section>
    {:else}
      <Row title="Also watching" items={continued.watching} {onopen} {onplay} resume />
      <Row title="Also listening" items={continued.listening} {onopen} {onplay} resume />
    {/if}
  {/if}

  <Row title="Saved for later" items={saved} {onopen} {onplay} onremove={toggleWatchLater}
       subtitle={saved.length ? 'Titles you set aside from their pages' : ''} />
  <Row title="Fresh on your shelf" items={$recentlyAdded} {onopen} {onplay} added onmore={() => navigate('/movies')} moreLabel="All films" />
  <Row title="Collections" items={collectionRow} card={collectionCell} onmore={() => navigate('/collections')}
       subtitle={collectionRow.length ? `${collectionRow.length} series and franchises, found for you` : ''} />

  <section class="moods" aria-labelledby="mood-h">
    <div class="moods-head">
      <h2 id="mood-h" class="display">What are you in the mood for?</h2>
      <div class="mood-pills" role="group" aria-label="Moods">
        {#each moods as m (m.id)}
          <button aria-pressed={mood === m.id} onclick={() => { mood = mood === m.id ? '' : m.id; }}>{m.label}</button>
        {/each}
        <button onclick={surprise} disabled={!movies.length}>Surprise me</button>
      </div>
    </div>
    {#if mood}
      <div aria-live="polite">
        {#if moodItems.length}<Row title="From your library" items={moodItems} {onopen} {onplay} />
        {:else}<p class="mood-empty">Nothing tagged {mood.toLowerCase()} yet. Try another mood.</p>{/if}
      </div>
    {/if}
  </section>

  {#each $genreClusters as cluster (cluster.name)}
    <Row title={cluster.name} items={cluster.items} {onopen} {onplay} />
  {/each}

  <footer>
    <span>{$libraryStats.movies.toLocaleString()} films · {$libraryStats.shows.toLocaleString()} series{audioCount ? ` · ${audioCount} audiobooks` : ''}</span>
    <span class="quiet">Everything here is on your own server.</span>
    {#if canDashboard}<button onclick={() => navigate('/system')}>Dashboard →</button>{/if}
  </footer>
</div>

{#snippet collectionCell(card)}
  <CollectionCard {card} onopen={c => navigate(`/collection/${encodeURIComponent(c.id)}`)} />
{/snippet}

<style>
  .home { padding: calc(64px + var(--s5)) 0 var(--s6); }
  .top { padding: 0 var(--gutter); display: flex; flex-direction: column; gap: 18px; }
  .top-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  .top-head h1 { font-size: clamp(2.2rem, 4vw, 2.9rem); }
  .summary { color: var(--ink-soft); font-size: 0.95rem; }

  .kicker { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent); }
  .kicker.quiet { color: var(--ink-soft); }
  .art-fallback { display: grid; place-items: center; height: 100%; padding: 10px; text-align: center; font-family: var(--font-display); font-size: 1.1rem; color: var(--ink-soft); background: var(--bg-raised); }
  .bar { height: 4px; background: rgba(243, 237, 228, 0.16); border-radius: 999px; overflow: hidden; max-width: 460px; }
  .bar span { display: block; height: 100%; background: var(--accent); }

  .btn { display: inline-flex; align-items: center; gap: 9px; min-height: 44px; padding: 0 20px; border-radius: var(--r-pill);
    background: rgba(243, 237, 228, 0.1); color: var(--ink); font-weight: 600; font-size: 0.95rem; transition: background var(--t-fast), filter var(--t-fast); }
  .btn:hover { background: rgba(243, 237, 228, 0.18); }
  .btn.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
  .btn.primary:hover { filter: brightness(1.07); }
  .textbtn { min-height: 44px; padding: 0 6px; color: var(--ink-soft); font-size: 0.92rem; text-decoration: underline; text-underline-offset: 4px; }
  .textbtn:hover { color: var(--ink); }
  .textbtn:disabled { opacity: 0.45; cursor: default; }

  .lead-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .lead { flex: 2 1 560px; min-width: 0; position: relative; overflow: hidden; border-radius: var(--r-lg); background: var(--bg-raised); min-height: 320px; display: flex; align-items: flex-end; }
  /* Static blur, never animated: an animated blur was the Firefox/Linux lag source. */
  .lead-bg { position: absolute; inset: -40px; width: calc(100% + 80px); height: calc(100% + 80px); object-fit: cover; filter: blur(28px) saturate(1.1); opacity: 0.5; }
  .lead::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(14, 12, 11, 0.94) 0%, rgba(14, 12, 11, 0.72) 55%, rgba(14, 12, 11, 0.38) 100%); }
  .lead-body { position: relative; z-index: 1; padding: 30px; display: flex; gap: 28px; align-items: flex-end; width: 100%; }
  .lead-poster { width: 150px; aspect-ratio: 2 / 3; border-radius: var(--r-sm); overflow: hidden; flex: 0 0 auto; box-shadow: 0 18px 40px rgba(0, 0, 0, 0.55); }
  .lead-poster img { width: 100%; height: 100%; object-fit: cover; }
  .lead-text { display: flex; flex-direction: column; gap: 10px; min-width: 0; flex: 1; }
  .lead-title { font-style: italic; font-size: clamp(2.2rem, 4vw, 3.1rem); line-height: 1; }
  .lead-sub { color: var(--ink); font-size: 1rem; }
  .lead-meta { color: var(--ink-soft); font-size: 0.95rem; }
  .lead-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
  .lead-actions .textbtn { margin-left: auto; }

  .pick { flex: 1 1 320px; min-width: 0; border-radius: var(--r-lg); background: var(--bg-raised); box-shadow: inset 0 0 0 1px var(--line); padding: 22px; display: flex; gap: 20px; }
  .pick-poster { align-self: flex-start; width: 118px; aspect-ratio: 2 / 3; border-radius: var(--r-sm); overflow: hidden; flex: 0 0 auto; box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5); }
  .pick-poster img { width: 100%; height: 100%; object-fit: cover; }
  .pick-text { display: flex; flex-direction: column; gap: 7px; min-width: 0; flex: 1; }
  .pick-title { font-style: italic; font-size: 2rem; line-height: 1.05; }
  .pick-meta { color: var(--ink-soft); font-size: 0.88rem; }
  .pick-reason { color: var(--ink); font-size: 0.92rem; line-height: 1.5; opacity: 0.9; }
  .pick-actions { display: flex; gap: 6px 10px; align-items: center; margin-top: auto; flex-wrap: wrap; padding-top: 6px; }
  .pick.big { flex: 2 1 560px; padding: 30px; }
  .pick.big .pick-poster { width: 150px; }
  .pick.big .pick-title { font-size: clamp(2.2rem, 4vw, 3.1rem); }

  /* The audiobook card is a full-width strip under the other two, or a third card
     beside them on wide screens. Without an audiobook the other two fill the row. */
  .listen { flex: 1 1 100%; min-width: 0; display: grid; grid-template-columns: 72px minmax(0, 1fr) auto;
    grid-template-areas: "cover head actions" "cover info actions"; column-gap: 20px; row-gap: 4px; align-items: center;
    background: var(--bg-raised); box-shadow: inset 0 0 0 1px var(--line); border-radius: var(--r-lg); padding: 16px 20px; }
  .listen-cover { grid-area: cover; width: 72px; height: 72px; border-radius: var(--r-sm); overflow: hidden; display: grid; place-items: center; background: #2a2018; color: #ead9bf; box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45); }
  .listen-cover img { width: 100%; height: 100%; object-fit: cover; }
  .listen-head { grid-area: head; display: flex; flex-direction: column; gap: 4px; min-width: 0; align-self: end; }
  .listen-info { grid-area: info; display: flex; flex-direction: column; gap: 4px; min-width: 0; align-self: start; }
  .listen-title { font-style: italic; font-size: 1.75rem; line-height: 1.05; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listen-meta { color: var(--ink-soft); font-size: 0.88rem; }
  .listen .bar { margin-top: 4px; max-width: 420px; }
  .listen-actions { grid-area: actions; display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  @media (min-width: 1700px) {
    .listen { flex: 1 1 300px; grid-template-columns: 118px minmax(0, 1fr); grid-template-rows: auto auto 1fr;
      grid-template-areas: "cover head" "info info" "actions actions"; column-gap: 20px; row-gap: 14px; align-items: start; padding: 22px; }
    .listen-cover { width: 118px; height: 118px; }
    .listen-head { align-self: center; }
    .listen-title { font-size: 1.6rem; white-space: normal; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; }
    .listen .bar { max-width: none; }
    .listen-actions { justify-content: flex-start; align-self: end; }
  }

  .continue-controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 40px var(--gutter) 0; color: var(--ink-soft); font-size: 0.88rem; }
  .continue-controls button { color: var(--ink-soft); min-height: 44px; font-weight: 600; text-decoration: underline; text-underline-offset: 4px; white-space: nowrap; }
  .continue-controls button:hover { color: var(--ink); }
  .continue-all { margin: 12px var(--gutter) 32px; }
  .continue-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .continue-tabs button { min-height: 40px; padding: 0 16px; border-radius: var(--r-pill); box-shadow: inset 0 0 0 1px var(--line-strong); color: var(--ink-soft); font-weight: 600; font-size: 0.88rem; }
  .continue-tabs button[aria-pressed='true'] { background: var(--ink); color: var(--bg); box-shadow: none; }
  .continue-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 24px 18px; }
  .continue-empty { color: var(--ink-soft); padding: 24px 0; }

  .moods { margin: var(--s5) 0; }
  .moods-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; padding: 0 var(--gutter); margin-bottom: var(--s2); }
  .moods-head h2 { font-size: clamp(1.5rem, 2.4vw, 1.9rem); line-height: 1; }
  .mood-pills { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
  .mood-pills button { min-height: 36px; padding: 0 14px; border-radius: var(--r-pill); box-shadow: inset 0 0 0 1px var(--line-strong); color: var(--ink-soft); font-size: 0.85rem; font-weight: 600; transition: background var(--t-fast), color var(--t-fast); }
  .mood-pills button:hover { color: var(--ink); }
  .mood-pills button[aria-pressed='true'] { background: var(--accent); color: var(--accent-ink); box-shadow: none; }
  .mood-pills button:disabled { opacity: 0.45; cursor: default; }
  .mood-empty { color: var(--ink-soft); padding: 12px var(--gutter); }

  footer { display: flex; gap: 20px; flex-wrap: wrap; align-items: center; margin: 48px var(--gutter) 0; padding-top: 22px; border-top: 1px solid var(--line); color: var(--ink-faint); font-size: 0.85rem; }
  footer .quiet { margin-right: auto; }
  footer button { color: var(--ink-soft); }
  footer button:hover { color: var(--ink); }

  @media (max-width: 720px) {
    /* Phones follow the compact mockup: round play buttons, one line of facts, no second-row buttons. */
    .home { padding-top: calc(60px + var(--s4)); }
    .top { gap: 14px; }
    .top-head h1 { font-size: 2.1rem; }
    .summary { font-size: 0.88rem; }
    .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .listen-actions .btn, .lead-actions .btn.primary { width: 48px; min-height: 48px; padding: 0; justify-content: center; }
    .wide-only, .wide-inline, .paused { display: none; }

    .lead { min-height: 0; border-radius: 14px; }
    .lead-body { padding: 14px 76px 14px 14px; gap: 14px; align-items: center; }
    .lead-poster { width: 74px; border-radius: 6px; }
    .lead-text { gap: 6px; }
    .kicker { font-size: 0.68rem; letter-spacing: 0.14em; }
    .lead-title { font-size: 1.65rem; }
    .lead-sub, .lead-meta { font-size: 0.82rem; }
    .lead .bar { height: 3px; }
    .lead-actions { margin: 0; gap: 0; }
    .lead-actions .btn.primary { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); }
    .lead-actions .textbtn { min-height: 32px; padding: 0; margin: 0; font-size: 0.8rem; }

    .pick { background: none; box-shadow: none; padding: 0; gap: 14px; align-items: center; flex-basis: 100%; }
    .pick-poster { width: 64px; align-self: center; border-radius: 6px; box-shadow: none; }
    .pick-text { gap: 3px; }
    .pick-title { font-size: 1.5rem; }
    .pick-meta, .pick-reason { font-size: 0.82rem; }
    .pick-reason { color: var(--ink-soft); }
    .pick-actions { margin: 0; padding: 0; }
    .pick-actions .textbtn { min-height: 36px; padding: 0; font-size: 0.82rem; }
    .pick.big { background: var(--bg-raised); padding: 14px; border-radius: 14px; }
    .pick.big .pick-poster { width: 74px; }
    .pick.big .pick-title { font-size: 1.65rem; }
    .pick.big .wide-only { display: inline-flex; }
    .pick.big .btn { min-height: 40px; padding: 0 16px; font-size: 0.88rem; }

    .listen { grid-template-columns: 52px minmax(0, 1fr) auto; column-gap: 12px; row-gap: 3px; padding: 10px 12px; border-radius: 12px; }
    .listen-cover { width: 52px; height: 52px; border-radius: 6px; }
    .listen-head, .listen-info { gap: 3px; }
    .listen-title { font-size: 1.25rem; }
    .listen-meta { font-size: 0.78rem; }
    .listen .bar { height: 3px; }
    .listen-actions { gap: 8px; flex-wrap: nowrap; }
    .listen-actions .btn { width: 44px; min-height: 44px; }

    .mood-pills { margin-left: 0; }
  }
</style>
