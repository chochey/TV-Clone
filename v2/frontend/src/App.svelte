<script>
  import { onMount, tick, untrack } from 'svelte';
  import { api } from './lib/api.js';
  import { library, catalog, session, loadLibrary, resetSessionState, searchQuery, searchFilters, collapseShows } from './lib/stores.js';
  import { searchLibrary } from './lib/search.js';
  import { collections, loadCollections } from './lib/collections.js';
  import { autofocus } from './lib/autofocus.js';
  import { EMPTY_FILTERS } from './lib/search-filters.js';
  import { posterUrl } from './lib/api.js';
  import { route, navigate } from './lib/router.js';
  import { nextEpisodeOf, prevEpisodeOf } from './lib/format.js';
  import Home from './routes/Home.svelte';
  import Detail from './routes/Detail.svelte';
  import Browse from './routes/Browse.svelte';
  import Search from './routes/Search.svelte';
  import Collections from './routes/Collections.svelte';
  import Collection from './routes/Collection.svelte';
  import History from './routes/History.svelte';
  import Requests from './routes/Requests.svelte';
  import Dashboard from './routes/Dashboard.svelte';
  import Libraries from './routes/Libraries.svelte';
  import Downloads from './routes/Downloads.svelte';
  import Organizer from './routes/Organizer.svelte';
  import Conversion from './routes/Conversion.svelte';
  import Logs from './routes/Logs.svelte';
  import Users from './routes/Users.svelte';
  import Duplicates from './routes/Duplicates.svelte';
  import Episodes from './routes/Episodes.svelte';
  import Stats from './routes/Stats.svelte';
  import Player from './lib/components/Player.svelte';
  import AudioPlayer from './lib/components/AudioPlayer.svelte';
  import { isAudioItem, isSeriesItem } from './lib/series-playback.js';
  import { loadedAppVersion, createAppUpdateMonitor, canRefreshApp } from './lib/app-updates.js';
  import { notifications, unreadCount, markAllRead, clearNotifications, setNotificationsEnabled, loadNotifications } from './lib/notifications.js';

  let phase = $state('loading'); // loading | login | ready
  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  let scrollY = $state(0);

  let toast = $state('');
  let toastTimer;
  function showToast(msg) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; }, 5000);
  }

  // Fullscreen renders ONLY the fullscreened element (the player), so a toast
  // mounted at the app root is invisible while watching fullscreen — the exact
  // moment downloads finish. This action re-parents the toast into the
  // fullscreen element (and back out when fullscreen ends). Svelte tracks the
  // node by reference, so text updates and {#if} teardown survive the move.
  function portalToFullscreen(node) {
    const move = () => {
      const fs = document.fullscreenElement;
      if (fs && node.parentElement !== fs) fs.appendChild(node);
    };
    move();
    document.addEventListener('fullscreenchange', move);
    return { destroy() { document.removeEventListener('fullscreenchange', move); } };
  }

  // Why this is a named function and not just onMount: if anything in here
  // throws, the splash has to stop spinning and offer a way out. loadLibrary
  // was previously awaited bare, so a 500 — or the 502 you get for a few
  // seconds after restarting the server from the account menu — left the app
  // on the loading screen forever with no error and no retry.
  let bootMsg = $state('');
  async function boot() {
    phase = 'loading';
    bootMsg = '';
    try {
      let health = await api.health();
      for (let i = 0; i < 30 && !(health && health.ready); i++) {
        // health() resolves null when the server is unreachable, but returns
        // {ready:false} while it is merely starting. Say which.
        bootMsg = health ? 'Server is starting…' : 'Waiting for the server…';
        await new Promise((r) => setTimeout(r, 1500));
        health = await api.health();
      }
      const me = await api.me();
      if (!me || !me.loggedIn) { phase = 'login'; return; }
      session.set(me);
      await loadLibrary(me.profileId);
      phase = 'ready';
    } catch {
      phase = 'offline';
    }
  }

  onMount(boot);
  // The Collections menu entry appears once Wikidata has found some.
  $effect(() => { if (phase === 'ready') loadCollections(); });

  // v1 auth is username + password (profiles stay hidden until signed in).
  async function signIn(e) {
    e.preventDefault();
    if (busy || !username.trim()) return;
    busy = true;
    error = '';
    try {
      await api.login(username.trim(), password);
      const me = await api.me();
      session.set(me);
      await loadLibrary(me.profileId);
      phase = 'ready';
    } catch (err) {
      // Surface the server's own message (wrong password, rate limit, ...)
      error = err.body?.error || 'Could not sign in. Check the connection to the server.';
    } finally {
      busy = false;
    }
  }

  let playing = $state(null);
  let audioMinimized = $state(false), updateAvailable = $state(false);
  const playingNext = $derived(playing ? nextEpisodeOf(playing, $library) : null);
  const playingPrev = $derived(playing ? prevEpisodeOf(playing, $library) : null);

  function openItem(item) {
    searchExpanded = false;
    browseWhileListening();
    navigate(`/title/${encodeURIComponent(item.id)}`);
  }
  // opts.reading: an audiobook opened with its read-along text showing.
  let startReading = $state(false);
  function playItem(item, opts = {}) {
    audioMinimized = false;
    startReading = !!opts.reading;
    playing = item;
  }

  $effect(() => {
    if (phase !== 'ready') return;
    const monitor = createAppUpdateMonitor({ initialVersion: loadedAppVersion(document),
      load: () => api.appVersion(), onUpdate: available => { updateAvailable = available; } });
    const check = () => { if (document.visibilityState !== 'hidden') monitor.check(); };
    check();
    const timer = setInterval(check, 60000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => { monitor.stop(); clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  });
  function refreshApp() {
    if (canRefreshApp(updateAvailable, !!playing)) window.location.reload();
  }

  // Section summaries contain labels/counts only. Server paths stay in the
  // administrator's manager, and empty locations remain navigable.
  let sections = $state([]);
  let sectionsReady = $state(false);
  let sectionsError = $state('');
  let sectionRequest = 0;
  const customSections = $derived(sections.filter(section => !['movie', 'show'].includes(section.type)));
  const selectedSection = $derived(sections.find(section => section.id === $route.id) || null);
  async function refreshSections() {
    const request = ++sectionRequest;
    const profile = $session?.profileId;
    if (!profile) return;
    try {
      const data = await api.librarySections();
      if (!data?.ok || !Array.isArray(data.sections)) throw new Error('Invalid library sections');
      if (request !== sectionRequest || $session?.profileId !== profile) return;
      sections = data.sections; sectionsReady = true; sectionsError = '';
    } catch {
      if (request === sectionRequest && $session?.profileId === profile) {
        sectionsError = 'Library sections could not be loaded.';
      }
    }
  }
  $effect(() => {
    if (phase !== 'ready') return;
    // This structural store stays stable during playback progress updates.
    // A same-size scan can still add/remove an empty configured section.
    $catalog; $session?.profileId;
    untrack(refreshSections);
  });
  $effect(() => {
    if (phase !== 'ready') return;
    const onVisible = () => { if (document.visibilityState === 'visible') refreshSections(); };
    const timer = setInterval(refreshSections, 300000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  });
  async function locationsChanged() {
    const results = await Promise.allSettled([loadLibrary($session?.profileId), refreshSections()]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Catalog refresh failed');
  }

  // ── Header live search: results drop down as you type, no page jump ───
  let searchFocused = $state(false);
  const searchPool = $derived(collapseShows($catalog));
  const searchMatches = $derived(searchLibrary(searchPool, $searchQuery));
  const searchSuggestions = $derived(searchMatches.slice(0, 8));
  const searchMore = $derived(searchMatches.length - searchSuggestions.length);
  const searchDropOpen = $derived(
    searchFocused && $searchQuery.trim().length >= 2 && searchMatches.length > 0
  );
  function pickResult(item) {
    searchFocused = false;
    openItem(item);
  }
  function clearSearch() {
    searchQuery.set('');
    searchFocused = true;
  }
  function seeAllResults() {
    searchFocused = false;
    navigate('/search');
  }
  // Arrow keys move through the suggestions; Enter opens the highlighted one
  // if you picked it deliberately, otherwise the full results page. Enter used
  // to jump straight to whatever ranked first, which turns the web's most
  // universal keypress into a guess.
  let searchHighlight = $state(-1);
  $effect(() => { $searchQuery; searchHighlight = -1; });
  function onSearchKey(e) {
    if (e.key === 'Escape') { searchFocused = false; e.currentTarget.blur(); return; }
    if (e.key === 'ArrowDown' && searchSuggestions.length) {
      e.preventDefault();
      searchHighlight = Math.min(searchHighlight + 1, searchSuggestions.length - 1);
    } else if (e.key === 'ArrowUp' && searchSuggestions.length) {
      e.preventDefault();
      searchHighlight = Math.max(searchHighlight - 1, -1);
    } else if (e.key === 'Enter') {
      if (searchHighlight >= 0 && searchSuggestions[searchHighlight]) pickResult(searchSuggestions[searchHighlight]);
      else if ($searchQuery.trim().length >= 2) seeAllResults();
    }
  }

  // ── User menu: history/requests + permission-gated system pages ──────
  let menuOpen = $state(false);
  let pendingCount = $state(0);
  let scanBusy = $state(false);
  let scanSnapshot = $state(null);
  let scanGeneration = 0, scanSubmitting = false;
  let confirmRestart = $state(false);
  let searchExpanded = $state(false);
  let searchInput = $state(null), accountButton = $state(null);
  async function openMobileSearch() {
    menuOpen = false; bellOpen = false; searchExpanded = true;
    await tick(); searchInput?.focus();
  }
  function dismissPanels(e) {
    if (e.key !== 'Escape') return;
    if (menuOpen) { menuOpen = false; confirmRestart = false; accountButton?.focus(); }
    bellOpen = false; searchExpanded = false;
  }

  const isAdmin = $derived($session?.role === 'admin');
  const can = (p) => $session?.role === 'admin' || ($session?.permissions || []).includes(p);

  // ── Notifications ────────────────────────────────────────────────────
  let bellOpen = $state(false);
  const ICON = { download: '↓', complete: '✓', added: '✚', organizer: '⚠', storage: '▤', vpn: '⛨', episode: '◈' };
  // Notifications come from the server's history (/api/notifications) and
  // are gated by the canNotify permission. The first list that arrives after
  // login is the baseline (no toast for old history); anything appended
  // after that — pushed live via the notifications-updated SSE event — toasts.
  const canNotify = $derived(can('canNotify'));
  let notifReady = false;
  let lastSeenNotifId = null; // null = baseline not yet established
  $effect(() => { setNotificationsEnabled(canNotify); });
  $effect(() => {
    if (phase === 'ready' && !notifReady) {
      notifReady = true;
      if (canNotify) loadNotifications();
    }
  });
  $effect(() => {
    const list = $notifications;
    if (!notifReady || !list.length) return;
    const newest = list[0];
    if (lastSeenNotifId === null) { lastSeenNotifId = newest.id; return; } // baseline load
    if (newest.id > lastSeenNotifId) {
      lastSeenNotifId = newest.id;
      showToast(`${ICON[newest.type] || '•'} ${newest.title}${newest.body ? ' — ' + newest.body : ''}`);
    }
  });
  function openBell() {
    bellOpen = !bellOpen;
    if (bellOpen) markAllRead();
  }
  function notifClick(n) {
    bellOpen = false;
    if (n.itemId) navigate(`/title/${encodeURIComponent(n.itemId)}`);
    else if (n.type === 'download' || n.type === 'complete' || n.type === 'vpn') navigate('/downloads');
    else if (n.type === 'episode') navigate('/episodes');
    else if (n.type === 'organizer') navigate('/organizer');
    else if (n.type === 'storage') navigate('/system');
  }
  function agoShort(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
  }

  async function refreshPending() {
    try {
      const d = await api.requests();
      pendingCount = (d.requests || []).filter((r) => r.status === 'pending').length;
    } catch { pendingCount = 0; }
  }
  $effect(() => { if (phase === 'ready') refreshPending(); });

  // Navigating with the full audiobook player open tucks it into the mini player; the audio keeps going.
  const browseWhileListening = () => { if (playing && isAudioItem(playing) && !audioMinimized) audioMinimized = true; };
  function go(path) {
    searchExpanded = false;
    menuOpen = false;
    confirmRestart = false;
    browseWhileListening();
    navigate(path);
  }
  async function scanLibrary() {
    if (scanBusy) return;
    scanGeneration++; scanSubmitting = true;
    scanBusy = true;
    menuOpen = false;
    showToast('Library scan started…');
    try {
      const r = await api.scan();
      scanSnapshot = r.status || null;
      showToast(r.queued ? 'Library scan queued…' : 'Library scan started…');
    } catch (e) {
      scanBusy = false;
      showToast(e.body?.error || 'Scan failed.');
    } finally { scanSubmitting = false; }
  }
  $effect(() => {
    if (phase !== 'ready' || !can('canScan')) return;
    const profile = $session?.profileId;
    let active = true, pending = false;
    async function poll() {
      if (pending || scanSubmitting) return;
      const generation = scanGeneration;
      pending = true;
      try {
        const status = await api.scanStatus();
        if (!active || $session?.profileId !== profile || generation !== scanGeneration || scanSubmitting) return;
        const wasBusy = scanBusy;
        scanSnapshot = status;
        scanBusy = !!(status.running || status.queued);
        if (wasBusy && !scanBusy) {
          showToast(status.error ? `Scan failed: ${status.error}` : status.enriching ? 'Library scan complete. Details are still updating.' : 'Library scan complete.');
          await loadLibrary(profile);
        }
      } catch { /* keep a queued scan visible while the connection recovers */ }
      finally { pending = false; }
    }
    poll();
    const timer = setInterval(() => { if (scanBusy) poll(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  });
  async function restartServer() {
    menuOpen = false;
    confirmRestart = false;
    showToast('Restarting the server…');
    try { await api.restart(); } catch {}
    // Poll health until v1 is back, then reload state.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const h = await api.health();
      if (h?.ready) { showToast('Server is back.'); await loadLibrary($session?.profileId); return; }
    }
    showToast('Server has not come back yet — check the dashboard.');
  }
  async function signOut() {
    menuOpen = false;
    sectionRequest++;
    sections = []; sectionsReady = false; sectionsError = '';
    notifReady = false;
    lastSeenNotifId = null;
    playing = null;
    await tick(); // let the outgoing player save/stop while its cookie still exists
    resetSessionState();
    await api.logout();
    session.set(null);
    username = ''; password = '';
    searchQuery.set('');   // don't leak the last user's search to the next
    searchFilters.set({ ...EMPTY_FILTERS });
    navigate('/');
    phase = 'login';
  }
</script>

<!-- A click anywhere closes the header menus, except inside a panel marked data-keep-open. -->
<svelte:window bind:scrollY onkeydown={dismissPanels} onclick={(e) => { if (e.target.closest?.('[data-keep-open]')) return; menuOpen = false; confirmRestart = false; bellOpen = false; }} />

{#if phase === 'loading'}
  <div class="splash">
    <div class="mark display"><span class="wordmark"><span class="wm">Chochey</span><span class="brandtv">TV</span></span></div>
    <div class="marksub meta">Media Server</div>
    <div class="spinner"></div>
    {#if bootMsg}<p class="meta bootmsg">{bootMsg}</p>{/if}
  </div>
{:else if phase === 'offline'}
  <div class="splash">
    <div class="mark display"><span class="wordmark"><span class="wm">Chochey</span><span class="brandtv">TV</span></span></div>
    <div class="marksub meta">Media Server</div>
    <p class="err">Can't reach the server.</p>
    <p class="meta bootmsg">It may still be restarting — give it a moment, then try again.</p>
    <button class="cta retry" onclick={boot}>Try again</button>
  </div>
{:else if phase === 'login'}
  <div class="splash">
    <form class="login" onsubmit={signIn}>
      <div class="mark display"><span class="wordmark"><span class="wm">Chochey</span><span class="brandtv">TV</span></span></div>
      <div class="marksub meta">Media Server</div>
      <input
        type="text" placeholder="Username" autocomplete="username"
        bind:value={username} use:autofocus
      />
      <input
        type="password" placeholder="Password" autocomplete="current-password"
        bind:value={password}
      />
      <button class="cta" type="submit" disabled={busy || !username.trim()}>
        {busy ? 'Signing in…' : 'Sign In'}
      </button>
      {#if error}<p class="err">{error}</p>{/if}
    </form>
  </div>
{:else}
  <header class="topbar" class:solid={scrollY > 24} class:searching={searchExpanded}>
    <button class="brand display" onclick={() => go('/')}>
      <span class="wordmark"><span class="wm">Chochey</span><span class="brandtv">TV</span></span>
    </button>
    <nav aria-label="Main navigation">
      <!-- Icons show only in the phone tab bar. -->
      <a class:active={$route.name === 'home'} href="/" onclick={(e) => { e.preventDefault(); go('/'); }}><svg class="nicon-svg" aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg><span>Tonight</span></a>
      <a class:active={$route.name === 'movies'} href="/movies" onclick={(e) => { e.preventDefault(); go('/movies'); }}><svg class="nicon-svg" aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/></svg><span>Films</span></a>
      <a class:active={$route.name === 'shows'} href="/shows" onclick={(e) => { e.preventDefault(); go('/shows'); }}><svg class="nicon-svg" aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/></svg><span>Series</span></a>
      {#each customSections as section (section.id)}
        <a class:active={$route.name === 'section' && $route.id === section.id} href={`/library/${encodeURIComponent(section.id)}`} title={section.available === false ? `${section.label} — location unavailable` : section.label} onclick={(e) => { e.preventDefault(); go(`/library/${encodeURIComponent(section.id)}`); }}>{#if section.mediaKind === 'audio'}<svg class="nicon-svg" aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>{:else}<svg class="nicon-svg" aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>{/if}<span>{section.label}</span></a>
      {/each}
      {#if $collections.length}<a class="desk-only" class:active={$route.name === 'collections' || $route.name === 'collection'} href="/collections" onclick={(e) => { e.preventDefault(); go('/collections'); }}><span>Collections</span></a>{/if}
      {#if sectionsError}<button class="nav-retry" title={sectionsError} onclick={refreshSections}>Retry libraries</button>
      {:else if !sectionsReady}<span class="nav-status" role="status">Loading libraries…</span>{/if}
      <button class="mobile-search" onclick={openMobileSearch}><svg class="nicon-svg" aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><span>Search</span></button>
    </nav>
    <div class="searchbox" class:open={searchDropOpen} data-keep-open>
      <svg class="sicon" viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
      <input
        class="searchinput" type="search" placeholder="Search your library" enterkeyhint="search"
        aria-label="Search your library" bind:this={searchInput}
        autocomplete="off" spellcheck="false"
        bind:value={$searchQuery}
        onfocus={() => { searchFocused = true; }}
        onblur={() => { setTimeout(() => { searchFocused = false; }, 140); }}
        onkeydown={onSearchKey}
      />
      {#if searchExpanded}<button class="search-close" aria-label="Close search" onclick={() => { searchExpanded = false; }}>✕</button>{/if}
      {#if $searchQuery.trim()}
        <button class="sclear" aria-label="Clear search" onclick={clearSearch}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      {/if}

      {#if searchDropOpen}
        <div class="search-drop" role="listbox">
          {#each searchSuggestions as item, i (item.id)}
            {@const t = (isSeriesItem(item) ? item.showName : '') || item.title || item.omdbTitle || 'Untitled'}
            <button class="sresult" class:hi={i === searchHighlight} onclick={() => pickResult(item)}>
              {#if posterUrl(item)}
                <img src={posterUrl(item)} alt="" loading="lazy" />
              {:else}
                <span class="sthumb"></span>
              {/if}
              <span class="sr-text">
                <span class="sr-title">{t}</span>
                <span class="sr-meta">{(item.year || item.omdbYear || '')} · {isAudioItem(item) ? 'Audio' : isSeriesItem(item) ? 'Series' : 'Film'}</span>
              </span>
            </button>
          {/each}
          {#if searchMore > 0}
            <button class="sresult see-all" onclick={seeAllResults}>See all {searchMatches.length} results</button>
          {/if}
        </div>
      {/if}
    </div>
    {#if canNotify}
    <div class="bell">
      <button class="bellbtn" aria-label="Notifications" aria-expanded={bellOpen}
              onclick={(e) => { e.stopPropagation(); openBell(); }}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm6-6v-5a6 6 0 0 0-4.5-5.8V4a1.5 1.5 0 0 0-3 0v1.2A6 6 0 0 0 6 11v5l-1.7 1.7c-.6.6-.2 1.7.7 1.7h14c.9 0 1.3-1.1.7-1.7L18 16z"/></svg>
        {#if $unreadCount > 0}<span class="ndot">{$unreadCount > 9 ? '9+' : $unreadCount}</span>{/if}
      </button>
      {#if bellOpen}
        <div class="npanel" data-keep-open>
          <div class="nhead">
            <span class="meta">Notifications</span>
            {#if $notifications.length}<button class="nclear" onclick={clearNotifications}>Clear</button>{/if}
          </div>
          {#if !$notifications.length}
            <p class="nempty">Nothing yet. New downloads and library additions show up here.</p>
          {:else}
            <div class="nlist">
              {#each $notifications as n (n.id)}
                <button class="nitem" onclick={() => notifClick(n)}>
                  <span class={`nicon ${n.type}`}>{ICON[n.type] || '•'}</span>
                  <span class="ntext">
                    <span class="ntitle">{n.title}</span>
                    {#if n.body}<span class="nbody">{n.body}</span>{/if}
                  </span>
                  <span class="nago">{agoShort(n.ts)}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
    {/if}
    <div class="usermenu">
      <button class="avatar" aria-label="Account menu" aria-expanded={menuOpen} aria-controls="account-menu" bind:this={accountButton}
              onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; if (menuOpen) refreshPending(); }}>
        {($session?.name || '?').slice(0, 1)}
        {#if pendingCount > 0}<span class="badge">{pendingCount}</span>{/if}
      </button>
      {#if menuOpen}
        <div class="dropdown" id="account-menu" data-keep-open>
          <div class="who meta">{$session?.name}</div>
          <button onclick={() => go('/history')}>History</button>
          <button onclick={() => go('/stats')}>Watch Stats</button>
          <button onclick={() => go('/requests')}>
            Requests {#if pendingCount > 0}<span class="badge inline">{pendingCount}</span>{/if}
          </button>
          {#if isAdmin || can('canDownload') || can('canLogs') || can('canDashboard') || can('canOrganizer')}
            <div class="divider"></div>
            <div class="who meta">Settings</div>
            {#if can('canDashboard')}<button onclick={() => go('/system')}>Dashboard</button>{/if}
            {#if isAdmin}<button onclick={() => go('/libraries')}>Libraries</button>{/if}
            {#if isAdmin}<button onclick={() => go('/users')}>Users</button>{/if}
            {#if isAdmin}<button onclick={() => go('/duplicates')}>Duplicates</button>{/if}
            {#if isAdmin}<button onclick={() => go('/conversion')}>Conversion</button>{/if}
            {#if can('canDownload')}<button onclick={() => go('/episodes')}>Episodes</button>{/if}
            {#if can('canDownload')}<button onclick={() => go('/downloads')}>Downloads</button>{/if}
            {#if can('canOrganizer')}<button onclick={() => go('/organizer')}>Organizer</button>{/if}
            {#if can('canLogs')}<button onclick={() => go('/logs')}>Logs</button>{/if}
          {/if}
          {#if can('canScan') || can('canRestart')}
            <div class="divider"></div>
            {#if can('canScan')}
              <button onclick={scanLibrary} disabled={scanBusy}>{scanBusy ? 'Scanning…' : 'Scan Library'}</button>
            {/if}
            {#if can('canRestart')}
              {#if confirmRestart}
                <button class="danger" onclick={restartServer}>Really restart?</button>
              {:else}
                <button onclick={() => { confirmRestart = true; }}>Restart Server</button>
              {/if}
            {/if}
          {/if}
          <div class="divider"></div>
          <button onclick={signOut}>Sign Out</button>
        </div>
      {/if}
    </div>
  </header>
  <main class:with-mini={playing && isAudioItem(playing) && audioMinimized} class:with-update={updateAvailable}>
    {#if scanBusy}<div class="scan-progress" role="status">{scanSnapshot?.queued ? 'Library scan queued…' : 'Library scan in progress…'}</div>{/if}
    {#if $route.name === 'title'}
      <Detail id={$route.id} onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'movies'}
      <Browse kind="movie" onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'shows'}
      <Browse kind="show" onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'section'}
      <Browse sectionId={$route.id} section={selectedSection} {sectionsReady} sectionError={sectionsError} onretry={refreshSections} onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'search'}
      <Search onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'collections'}
      <Collections />
    {:else if $route.name === 'collection'}
      <Collection id={$route.id} onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'history'}
      <History />
    {:else if $route.name === 'stats'}
      <Stats />
    {:else if $route.name === 'requests'}
      <Requests />
    {:else if $route.name === 'system' && can('canDashboard')}
      <Dashboard />
    {:else if $route.name === 'libraries' && isAdmin}
      <Libraries onchange={locationsChanged} />
    {:else if $route.name === 'downloads' && can('canDownload')}
      <Downloads />
    {:else if $route.name === 'organizer' && can('canOrganizer')}
      <Organizer />
    {:else if $route.name === 'logs' && can('canLogs')}
      <Logs />
    {:else if $route.name === 'users' && isAdmin}
      <Users />
    {:else if $route.name === 'duplicates' && isAdmin}
      <Duplicates />
    {:else if $route.name === 'conversion' && isAdmin}
      <Conversion />
    {:else if $route.name === 'episodes' && can('canDownload')}
      <Episodes />
    {:else}
      <Home onopen={openItem} onplay={playItem} />
    {/if}
  </main>
{/if}

{#if playing}
  {#key playing.id}
    {#if isAudioItem(playing)}
      <AudioPlayer item={playing} {startReading} minimized={audioMinimized} onminimize={() => { audioMinimized = true; }} onexpand={() => { audioMinimized = false; }} onclose={() => { playing = null; audioMinimized = false; }} />
    {:else}
    <Player
      item={playing}
      next={playingNext}
      prev={playingPrev}
      onclose={() => { playing = null; }}
      onnext={(n) => { playing = n; }}
      onprev={(p) => { playing = p; }}
    />
    {/if}
  {/key}
{/if}

{#if phase === 'ready' && updateAvailable}
  <aside class="update-banner" class:above-mini={playing && isAudioItem(playing) && audioMinimized} role="status">
    <p><strong>Update available</strong><span>{playing ? 'Close the player when you are ready to refresh.' : 'Refresh to get the latest changes.'}</span></p>
    <button disabled={!!playing} onclick={refreshApp}>Refresh</button>
  </aside>
{/if}

{#if toast}
  <div class="toast" use:portalToFullscreen>{toast}</div>
{/if}

<style>
  main.with-mini {padding-bottom:120px;}
  main.with-update {padding-bottom:140px;}
  main.with-mini.with-update {padding-bottom:220px;}
  .scan-progress {position:relative;z-index:4;margin:88px var(--gutter) 0;padding:12px 16px;background:var(--accent-soft);border:1px solid rgba(232,176,74,.3);border-radius:var(--r-md);color:var(--ink);font-size:.85rem;}
  .update-banner {position:fixed;z-index:110;right:16px;bottom:16px;display:flex;align-items:center;gap:16px;max-width:min(430px,calc(100vw - 32px));padding:14px 16px;background:var(--bg-raised);border:1px solid rgba(232,176,74,.4);border-radius:var(--r-md);box-shadow:0 8px 30px #0008;}
  .update-banner.above-mini {bottom:110px;}
  .update-banner p {display:flex;flex-direction:column;gap:4px;line-height:1.4;}
  .update-banner strong {font-size:.88rem;}
  .update-banner span {color:var(--ink-soft);font-size:.78rem;}
  .update-banner button {padding:10px 16px;border-radius:var(--r-pill);background:var(--accent);color:var(--accent-ink);font-weight:700;min-height:44px;}
  .update-banner button:disabled {opacity:.45;cursor:default;}
  @media(max-width:720px) {main.with-mini {padding-bottom:calc(160px + env(safe-area-inset-bottom));} main.with-update {padding-bottom:calc(220px + env(safe-area-inset-bottom));} main.with-mini.with-update {padding-bottom:calc(280px + env(safe-area-inset-bottom));} .update-banner {bottom:calc(70px + env(safe-area-inset-bottom));} .update-banner.above-mini {bottom:calc(165px + env(safe-area-inset-bottom));}}
  .splash {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--s5);
  }
  .mark {
    font-size: clamp(2.6rem, 7vw, 3.6rem);
    color: var(--ink);
  }
  .spinner {
    width: 30px; height: 30px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 99px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .login {
    display: flex; flex-direction: column; gap: var(--s3);
    width: min(340px, 86vw);
  }
  .login .mark { text-align: center; margin-bottom: var(--s2); }
  .login .marksub { text-align: center; margin-bottom: var(--s4); }
  .cta {
    background: var(--cta); color: var(--cta-ink);
    font-weight: 700; font-size: 1rem;
    padding: 13px; border-radius: var(--r-pill);
    transition: opacity var(--t-fast);
  }
  /* Not ready yet (nothing typed): quiet, not a dimmed amber that reads as broken. */
  .cta:disabled { background: rgba(243, 237, 228, 0.1); color: var(--ink-faint); cursor: default; }
  .cta:not(:disabled):hover { opacity: 0.88; }
  .err { color: var(--bad); font-size: 0.88rem; text-align: center; margin-top: var(--s2); }
  .bootmsg { margin-top: var(--s3); text-align: center; }
  .retry { margin-top: var(--s4); padding: 10px 26px; width: auto; }

  .topbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--s3) var(--gutter);
    /* No backdrop-filter: a blur on a FIXED bar re-blurs everything scrolling
       behind it on every frame — a major scroll-jank source on Linux/NVIDIA
       WebRender. The background is near-opaque anyway, so the blur added almost
       nothing visually. Solid bg = the content just scrolls under a cheap layer. */
    background: rgba(14, 12, 11, 0.96);
    border-bottom: 1px solid transparent;
    transition: background var(--t-med), border-color var(--t-med);
  }
  .topbar.solid {
    background: rgba(14, 12, 11, 0.985);
    border-bottom-color: var(--line);
  }
  .brand {
    display: flex; align-items: baseline;
    font-size: 1.75rem;
    color: var(--ink);
    white-space: nowrap;
  }
  /* The wordmark: "Chochey" in the italic serif, "TV" as small spaced caps. */
  .wordmark { display: inline-flex; align-items: baseline; gap: 0.2em; }
  .wm { font-style: italic; }
  .brandtv { font-family: var(--font-sans); font-size: 0.4em; font-weight: 700; letter-spacing: 0.22em; color: var(--ink-soft); }
  .marksub { margin-top: calc(-1 * var(--s4)); letter-spacing: 0.3em; color: var(--ink-faint); }
  .brand, .bell, .usermenu { flex-shrink: 0; }
  nav { display: flex; align-items: center; gap: var(--s4); margin: 0 var(--s4); flex: 0 1 auto; min-width: 0; max-width: 50%; overflow-x: auto; white-space: nowrap; overscroll-behavior-x: contain; scrollbar-width: thin; }
  nav > * { flex: 0 0 auto; }
  .nav-status, .nav-retry { color: var(--ink-soft); font-size: .8rem; padding: 8px 0; }
  .nav-retry { text-decoration: underline; }

  /* Let search use the space between library navigation and account controls. */
  .searchbox {
    position: relative;
    flex: 1 1 200px; width: auto; min-width: 200px;
    margin: 0 var(--s4) 0 0;
    display: flex; align-items: center; gap: 8px;
    background: rgba(243, 237, 228, 0.06);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    height: 40px; border-radius: var(--r-pill); padding: 0 16px;
    transition: box-shadow var(--t-fast), background var(--t-fast);
  }
  .searchbox:focus-within {
    background: rgba(243, 237, 228, 0.1);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .searchbox.open { box-shadow: inset 0 0 0 1px var(--line-strong); }
  .sicon { color: var(--ink-faint); flex: 0 0 auto; }
  .searchinput {
    flex: 1; min-width: 0;
    background: transparent; border: none; outline: none;
    color: var(--ink); font-size: 0.9rem; font-weight: 500;
    padding: 9px 0;
  }
  .searchinput::placeholder { color: var(--ink-soft); }
  .searchinput::-webkit-search-cancel-button { -webkit-appearance: none; }
  .sclear {
    flex: 0 0 auto; display: grid; place-items: center;
    width: 22px; height: 22px; border-radius: 99px; color: var(--ink-faint);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .sclear:hover { color: var(--ink); background: rgba(243, 237, 228, 0.14); }

  /* Live-results dropdown — matches appear here as you type, no page jump. */
  .search-drop {
    position: absolute; top: calc(100% + 8px); left: 0;
    width: 100%; max-height: min(70vh, 560px); overflow-y: auto;
    background: rgba(25, 22, 20, 0.985);
    border-radius: var(--r-md); padding: var(--s2);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-strong);
    display: flex; flex-direction: column; gap: 2px; z-index: 60;
  }
  .sresult {
    display: flex; align-items: center; gap: var(--s2);
    padding: 6px 8px; border-radius: var(--r-sm); text-align: left;
    transition: background var(--t-fast);
  }
  .sresult:hover, .sresult.hi { background: rgba(243, 237, 228, 0.1); }
  .sresult img, .sthumb {
    width: 34px; height: 50px; flex: 0 0 auto; border-radius: 4px;
    object-fit: cover; background: rgba(243, 237, 228, 0.08);
  }
  .sr-text { display: flex; flex-direction: column; min-width: 0; }
  .sr-title { font-size: 0.88rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sr-meta { font-size: 0.75rem; color: var(--ink-faint); }
  .see-all { justify-content: center; color: var(--ink-soft); font-size: 0.82rem; font-weight: 600; padding: 10px; }
  .see-all:hover { color: var(--ink); }
  @media (max-width: 720px) {
    .search-drop { position: fixed; left: var(--s4); right: var(--s4); top: 60px; width: auto; }
  }

  .bell { position: relative; margin-left: 0; }
  .bellbtn {
    position: relative;
    width: 34px; height: 34px; border-radius: 99px;
    display: grid; place-items: center; color: var(--ink-soft);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .bellbtn:hover { color: var(--ink); background: rgba(243, 237, 228, 0.1); }
  .ndot {
    position: absolute; top: -2px; right: -3px;
    min-width: 16px; height: 16px; padding: 0 4px;
    display: grid; place-items: center;
    background: var(--cta); color: var(--cta-ink);
    font-size: 0.62rem; font-weight: 800; border-radius: 99px;
  }
  .npanel {
    position: absolute; top: 44px; right: 0; z-index: 60;
    width: 320px; max-width: 86vw;
    background: rgba(25, 22, 20, 0.985);
    border-radius: var(--r-md); overflow: hidden;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-strong);
  }
  .nhead {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--s3) var(--s3) var(--s2);
  }
  .nclear { font-size: 0.78rem; font-weight: 600; color: var(--ink-soft); }
  .nclear:hover { color: var(--ink); }
  .nempty { color: var(--ink-faint); font-size: 0.88rem; padding: var(--s3); line-height: 1.5; }
  .nlist { max-height: 60vh; overflow-y: auto; }
  .nitem {
    display: flex; align-items: flex-start; gap: var(--s3); width: 100%;
    text-align: left; padding: var(--s3);
    border-top: 1px solid var(--line);
    transition: background var(--t-fast);
  }
  .nitem:hover { background: rgba(243, 237, 228, 0.06); }
  .nicon {
    flex: 0 0 26px; width: 26px; height: 26px; border-radius: 99px;
    display: grid; place-items: center; font-size: 0.82rem; font-weight: 800;
    background: var(--bg); color: var(--ink-soft);
  }
  .nicon.complete { background: rgba(126, 212, 145, 0.16); color: #7ed491; }
  .nicon.added { background: rgba(109, 179, 255, 0.16); color: #6db3ff; }
  .nicon.download { background: rgba(243, 237, 228, 0.1); color: var(--ink); }
  .ntext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .ntitle { font-size: 0.88rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nbody { font-size: 0.78rem; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nago { flex: 0 0 auto; font-size: 0.72rem; color: var(--ink-faint); }

  .usermenu { position: relative; margin-left: var(--s3); }
  .avatar {
    position: relative;
    width: 34px; height: 34px; border-radius: 99px;
    display: grid; place-items: center;
    background: var(--accent); color: var(--accent-ink);
    font-weight: 700; font-size: 0.9rem; text-transform: uppercase;
    transition: filter var(--t-fast);
  }
  .avatar:hover { filter: brightness(1.08); }
  /* Badges sit on the amber avatar and bell, so they are cream, not amber. */
  .avatar .badge, .ndot { background: var(--ink); color: var(--bg); }
  .badge {
    position: absolute; top: -4px; right: -6px;
    min-width: 17px; height: 17px; padding: 0 4px;
    display: grid; place-items: center;
    background: var(--cta); color: var(--cta-ink);
    font-size: 0.66rem; font-weight: 800; border-radius: 99px;
  }
  .badge.inline { position: static; display: inline-grid; margin-left: 8px; vertical-align: 1px; }
  .dropdown {
    position: absolute; top: 44px; right: 0; z-index: 60;
    min-width: 200px;
    background: rgba(25, 22, 20, 0.985);
    border-radius: var(--r-md); padding: var(--s2);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-strong);
    display: flex; flex-direction: column; gap: 1px;
    max-height: calc(100dvh - 90px); overflow-y: auto; overscroll-behavior: contain;
  }
  .dropdown > * { flex-shrink: 0; }
  .mobile-search, .search-close { display: none; }
  .dropdown .who { padding: 8px 12px 4px; }
  .dropdown > button {
    display: flex; align-items: center;
    text-align: left; font-size: 0.92rem; font-weight: 500;
    padding: 9px 12px; border-radius: var(--r-sm); color: var(--ink-soft);
    transition: background var(--t-fast), color var(--t-fast);
  }
  .dropdown > button:hover { background: rgba(243, 237, 228, 0.1); color: var(--ink); }
  .dropdown > button:disabled { opacity: 0.5; }
  .dropdown .danger { color: var(--bad); }
  .divider { height: 1px; background: var(--line); margin: var(--s2) 0; }
  nav a {
    color: var(--ink-soft); font-size: 0.95rem; font-weight: 500;
    transition: color var(--t-fast);
    position: relative;
    display: inline-flex; align-items: center; min-height: 40px;
  }
  nav a:hover, nav a.active { color: var(--ink); }
  nav a.active::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -2px;
    height: 2px; background: var(--accent); border-radius: 2px;
  }
  .nicon-svg { display: none; }
  main { position: relative; }

  .toast {
    position: fixed; top: calc(64px + var(--s3)); right: var(--s4);
    z-index: 100;
    background: var(--bg-raised); color: var(--ink);
    font-size: 0.9rem; font-weight: 500;
    padding: 12px 20px; border-radius: 99px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--line-strong);
    animation: toastin var(--t-med) var(--ease);
    max-width: 42vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  @keyframes toastin {
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* Tablet + small laptop: trim the fat (brand letter-spacing, nav gaps,
     side margins) so the nav and a usable search box coexist on one row
     well below desktop widths, instead of the box crushing to its icon. */
  @media (max-width: 900px) {
    .brand { font-size: 1.5rem; }
    nav { gap: var(--s3); margin: 0 var(--s3); }
    .searchbox { min-width: 160px; margin: 0 var(--s3) 0 0; }
  }
  /* Narrow screens use a bottom bar so library access and search stay
     visible without squeezing the account controls off the screen. */
  @media (max-width: 720px) {
    .topbar { padding: var(--s3) var(--s4); gap: var(--s2); }
    .brand { margin-right: auto; }
    /* The tab bar: icon over label, the current tab in amber. */
    nav {
      position: fixed; inset: auto 0 0; margin: 0; gap: 0; display: flex; max-width: none; width: 100%; overflow-x: auto;
      padding: 6px 6px calc(8px + env(safe-area-inset-bottom)); background: rgba(14, 12, 11, 0.985); border-top: 1px solid var(--line-strong);
    }
    nav > a, .mobile-search, .nav-retry, .nav-status {
      flex: 1 0 64px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
      min-height: 52px; padding: 0 6px; font-size: .7rem; font-weight: 600; color: var(--ink-soft);
    }
    nav > a span, .mobile-search span { max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nicon-svg { display: block; }
    .desk-only { display: none !important; }
    nav a.active { color: var(--accent); }
    nav a.active::after { display: none; }
    main { padding-bottom: calc(72px + env(safe-area-inset-bottom)); }
    .searchbox { display: none; }
    .searching .searchbox {
      display: flex; position: absolute; left: var(--s4); right: var(--s4); top: 8px;
      margin: 0; width: auto; max-width: none; padding: 0 14px; min-height: 44px; background: var(--bg-raised); z-index: 2;
    }
    .searching .brand, .searching .bell, .searching .usermenu { visibility: hidden; }
    .search-close { display: grid; place-items: center; min-width: 44px; min-height: 44px; }
    .bell { margin-left: 0; }
    .bellbtn, .avatar { width: 44px; height: 44px; }
    .dropdown { top: 50px; max-height: calc(100dvh - 140px - env(safe-area-inset-bottom)); }
    .dropdown > button { min-height: 44px; }
  }
</style>
