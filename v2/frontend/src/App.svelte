<script>
  import { onMount } from 'svelte';
  import { api } from './lib/api.js';
  import { library, session, loadLibrary, searchQuery } from './lib/stores.js';
  import { route, navigate } from './lib/router.js';
  import { nextEpisodeOf, prevEpisodeOf } from './lib/format.js';
  import Home from './routes/Home.svelte';
  import Detail from './routes/Detail.svelte';
  import Browse from './routes/Browse.svelte';
  import Search from './routes/Search.svelte';
  import History from './routes/History.svelte';
  import Requests from './routes/Requests.svelte';
  import Dashboard from './routes/Dashboard.svelte';
  import Downloads from './routes/Downloads.svelte';
  import Organizer from './routes/Organizer.svelte';
  import Logs from './routes/Logs.svelte';
  import Users from './routes/Users.svelte';
  import Duplicates from './routes/Duplicates.svelte';
  import Episodes from './routes/Episodes.svelte';
  import Stats from './routes/Stats.svelte';
  import Player from './lib/components/Player.svelte';
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
    toastTimer = setTimeout(() => { toast = ''; }, 3000);
  }

  onMount(async () => {
    // Wait for the v1 backend to be ready (it may be mid-scan).
    let health = await api.health();
    for (let i = 0; i < 30 && !(health && health.ready); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      health = await api.health();
    }
    const me = await api.me();
    if (me && me.loggedIn) {
      session.set(me);
      await loadLibrary(me.profileId);
      phase = 'ready';
    } else {
      phase = 'login';
    }
  });

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
  const playingNext = $derived(playing ? nextEpisodeOf(playing, $library) : null);
  const playingPrev = $derived(playing ? prevEpisodeOf(playing, $library) : null);

  function openItem(item) {
    navigate(`/title/${encodeURIComponent(item.id)}`);
  }
  function playItem(item) {
    playing = item;
  }

  // ── User menu: history/requests + permission-gated system pages ──────
  let menuOpen = $state(false);
  let pendingCount = $state(0);
  let scanBusy = $state(false);
  let confirmRestart = $state(false);

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

  function go(path) {
    menuOpen = false;
    confirmRestart = false;
    navigate(path);
  }
  async function scanLibrary() {
    if (scanBusy) return;
    scanBusy = true;
    menuOpen = false;
    showToast('Library scan started…');
    try {
      const r = await api.scan();
      await loadLibrary($session?.profileId);
      showToast(`Scan complete — ${r.count?.toLocaleString?.() || 'library'} files.`);
    } catch (e) {
      showToast(e.body?.error || 'Scan failed.');
    } finally { scanBusy = false; }
  }
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
    notifReady = false;
    lastSeenNotifId = null;
    await api.logout();
    session.set(null);
    playing = null;
    username = ''; password = '';
    searchQuery.set('');   // don't leak the last user's search to the next
    navigate('/');
    phase = 'login';
  }
</script>

<svelte:window bind:scrollY onclick={() => { menuOpen = false; confirmRestart = false; bellOpen = false; }} />

{#if phase === 'loading'}
  <div class="splash">
    <div class="mark display">CHOCHEY'S</div>
    <div class="marksub meta">Media Server</div>
    <div class="spinner"></div>
  </div>
{:else if phase === 'login'}
  <div class="splash">
    <form class="login" onsubmit={signIn}>
      <div class="mark display">CHOCHEY'S</div>
      <div class="marksub meta">Media Server</div>
      <input
        type="text" placeholder="Username" autocomplete="username"
        bind:value={username} autofocus
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
  <header class="topbar" class:solid={scrollY > 24}>
    <button class="brand display" onclick={() => navigate('/')}>
      CHOCHEY'S<span class="brandsub">MEDIA SERVER</span>
    </button>
    <nav>
      <a class:active={$route.name === 'home'} href="/" onclick={(e) => { e.preventDefault(); navigate('/'); }}>Home</a>
      <a class:active={$route.name === 'movies'} href="/movies" onclick={(e) => { e.preventDefault(); navigate('/movies'); }}>Films</a>
      <a class:active={$route.name === 'shows'} href="/shows" onclick={(e) => { e.preventDefault(); navigate('/shows'); }}>Series</a>
    </nav>
    <div class="searchbox">
      <svg class="sicon" viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
      <input
        class="searchinput" type="search" placeholder="Search"
        autocomplete="off" spellcheck="false"
        bind:value={$searchQuery}
        onfocus={() => { if ($route.name !== 'search') navigate('/search'); }}
        oninput={() => { if ($route.name !== 'search') navigate('/search'); }}
      />
    </div>
    {#if canNotify}
    <div class="bell">
      <button class="bellbtn" aria-label="Notifications" aria-expanded={bellOpen}
              onclick={(e) => { e.stopPropagation(); openBell(); }}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm6-6v-5a6 6 0 0 0-4.5-5.8V4a1.5 1.5 0 0 0-3 0v1.2A6 6 0 0 0 6 11v5l-1.7 1.7c-.6.6-.2 1.7.7 1.7h14c.9 0 1.3-1.1.7-1.7L18 16z"/></svg>
        {#if $unreadCount > 0}<span class="ndot">{$unreadCount > 9 ? '9+' : $unreadCount}</span>{/if}
      </button>
      {#if bellOpen}
        <div class="npanel" onclick={(e) => e.stopPropagation()}>
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
      <button class="avatar" aria-label="Account menu" aria-expanded={menuOpen}
              onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; if (menuOpen) refreshPending(); }}>
        {($session?.name || '?').slice(0, 1)}
        {#if pendingCount > 0}<span class="badge">{pendingCount}</span>{/if}
      </button>
      {#if menuOpen}
        <div class="dropdown" onclick={(e) => e.stopPropagation()}>
          <div class="who meta">{$session?.name}</div>
          <button onclick={() => go('/history')}>History</button>
          <button onclick={() => go('/stats')}>Watch Stats</button>
          <button onclick={() => go('/requests')}>
            Requests {#if pendingCount > 0}<span class="badge inline">{pendingCount}</span>{/if}
          </button>
          {#if isAdmin || can('canDownload') || can('canLogs') || can('canDashboard') || can('canOrganizer')}
            <div class="divider"></div>
            <div class="who meta">System</div>
            {#if can('canDashboard')}<button onclick={() => go('/system')}>Dashboard</button>{/if}
            {#if isAdmin}<button onclick={() => go('/users')}>Users</button>{/if}
            {#if isAdmin}<button onclick={() => go('/duplicates')}>Duplicates</button>{/if}
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
  <main>
    {#if $route.name === 'title'}
      <Detail id={$route.id} onplay={playItem} />
    {:else if $route.name === 'movies'}
      <Browse kind="movie" onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'shows'}
      <Browse kind="show" onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'search'}
      <Search onopen={openItem} onplay={playItem} />
    {:else if $route.name === 'history'}
      <History />
    {:else if $route.name === 'stats'}
      <Stats />
    {:else if $route.name === 'requests'}
      <Requests />
    {:else if $route.name === 'system' && can('canDashboard')}
      <Dashboard />
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
    {:else if $route.name === 'episodes' && can('canDownload')}
      <Episodes />
    {:else}
      <Home onopen={openItem} onplay={playItem} />
    {/if}
  </main>
{/if}

{#if playing}
  {#key playing.id}
    <Player
      item={playing}
      next={playingNext}
      prev={playingPrev}
      onclose={() => { playing = null; }}
      onnext={(n) => { playing = n; }}
      onprev={(p) => { playing = p; }}
    />
  {/key}
{/if}

{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .splash {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--s5);
  }
  .mark {
    font-size: clamp(1.4rem, 4vw, 2rem);
    letter-spacing: 0.34em;
    /* optical: tracking adds a trailing gap; nudge back to center */
    margin-right: -0.34em;
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
  .login .mark { text-align: center; margin-bottom: var(--s4); }
  .cta {
    background: var(--cta); color: var(--cta-ink);
    font-weight: 700; font-size: 1rem;
    padding: 13px; border-radius: var(--r-sm);
    transition: opacity var(--t-fast);
  }
  .cta:disabled { opacity: 0.4; cursor: default; }
  .cta:not(:disabled):hover { opacity: 0.88; }
  .err { color: #ff6b6b; font-size: 0.88rem; text-align: center; margin-top: var(--s2); }

  .topbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--s3) var(--gutter);
    background: rgba(11, 11, 14, 0.92);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid transparent;
    transition: background var(--t-med), border-color var(--t-med);
  }
  .topbar.solid {
    background: rgba(11, 11, 14, 0.97);
    backdrop-filter: blur(16px);
    border-bottom-color: var(--line);
  }
  .brand {
    display: flex; align-items: baseline; gap: 10px;
    font-size: 1.02rem;
    letter-spacing: 0.34em;
    color: var(--ink);
    white-space: nowrap;
  }
  .brandsub {
    font-size: 0.62rem; font-weight: 600;
    letter-spacing: 0.3em;
    color: var(--ink-faint);
  }
  .marksub { margin-top: calc(-1 * var(--s4)); letter-spacing: 0.3em; color: var(--ink-faint); }
  nav { display: flex; gap: var(--s5); margin-left: var(--s4); }

  /* Persistent search box filling the middle of the bar. Explicit side
     margins (not `auto`) so flex-grow actually expands the box — auto
     margins absorb the free space first and leave it crushed to the icon. */
  .searchbox {
    flex: 1; min-width: 0; max-width: 440px; margin: 0 var(--s4);
    display: flex; align-items: center; gap: 8px;
    background: rgba(242, 242, 244, 0.08);
    box-shadow: inset 0 0 0 1px var(--line);
    border-radius: 99px; padding: 0 14px;
    transition: box-shadow var(--t-fast), background var(--t-fast);
  }
  .searchbox:focus-within {
    background: rgba(242, 242, 244, 0.12);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .sicon { color: var(--ink-faint); flex: 0 0 auto; }
  .searchinput {
    flex: 1; min-width: 0;
    background: transparent; border: none; outline: none;
    color: var(--ink); font-size: 0.9rem; font-weight: 500;
    padding: 9px 0;
  }
  .searchinput::placeholder { color: var(--ink-faint); }
  .searchinput::-webkit-search-cancel-button { -webkit-appearance: none; }

  .bell { position: relative; margin-left: var(--s5); }
  .bellbtn {
    position: relative;
    width: 34px; height: 34px; border-radius: 99px;
    display: grid; place-items: center; color: var(--ink-soft);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .bellbtn:hover { color: var(--ink); background: rgba(242, 242, 244, 0.1); }
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
    background: rgba(17, 17, 22, 0.97); backdrop-filter: blur(14px);
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
  .nitem:hover { background: rgba(242, 242, 244, 0.06); }
  .nicon {
    flex: 0 0 26px; width: 26px; height: 26px; border-radius: 99px;
    display: grid; place-items: center; font-size: 0.82rem; font-weight: 800;
    background: var(--bg); color: var(--ink-soft);
  }
  .nicon.complete { background: rgba(126, 212, 145, 0.16); color: #7ed491; }
  .nicon.added { background: rgba(109, 179, 255, 0.16); color: #6db3ff; }
  .nicon.download { background: rgba(242, 242, 244, 0.1); color: var(--ink); }
  .ntext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .ntitle { font-size: 0.88rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nbody { font-size: 0.78rem; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nago { flex: 0 0 auto; font-size: 0.72rem; color: var(--ink-faint); }

  .usermenu { position: relative; margin-left: var(--s3); }
  .avatar {
    position: relative;
    width: 34px; height: 34px; border-radius: 99px;
    display: grid; place-items: center;
    background: var(--bg-raised); color: var(--ink);
    font-weight: 700; font-size: 0.9rem; text-transform: uppercase;
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: background var(--t-fast);
  }
  .avatar:hover { background: rgba(242, 242, 244, 0.14); }
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
    background: rgba(17, 17, 22, 0.97); backdrop-filter: blur(14px);
    border-radius: var(--r-md); padding: var(--s2);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-strong);
    display: flex; flex-direction: column; gap: 1px;
  }
  .dropdown .who { padding: 8px 12px 4px; }
  .dropdown > button {
    display: flex; align-items: center;
    text-align: left; font-size: 0.92rem; font-weight: 500;
    padding: 9px 12px; border-radius: var(--r-sm); color: var(--ink-soft);
    transition: background var(--t-fast), color var(--t-fast);
  }
  .dropdown > button:hover { background: rgba(242, 242, 244, 0.1); color: var(--ink); }
  .dropdown > button:disabled { opacity: 0.5; }
  .dropdown .danger { color: #ff6b6b; }
  .divider { height: 1px; background: var(--line); margin: var(--s2) 0; }
  nav a {
    color: var(--ink-soft); font-size: 0.9rem; font-weight: 500;
    letter-spacing: 0.02em; transition: color var(--t-fast);
    position: relative;
  }
  nav a:hover, nav a.active { color: var(--ink); }
  nav a.active::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -6px;
    height: 2px; background: var(--ink); border-radius: 2px;
  }
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
    .brandsub { display: none; }
    .brand { letter-spacing: 0.2em; font-size: 0.92rem; }
    nav { gap: var(--s3); margin-left: var(--s3); }
    .searchbox { margin: 0 var(--s3); }
    .bell { margin-left: var(--s3); }
  }
  /* Phones: even trimmed, brand + 3 nav links + icons leave no room for a
     usable search. Hand the row to search — the thing that was requested —
     and drop the text nav. Home is the logo; Films/Series are a tap into
     search results. Tablets and up keep the nav alongside the box. */
  @media (max-width: 560px) {
    .topbar { padding: var(--s3) var(--s4); gap: var(--s2); }
    nav { display: none; }
    .searchbox { max-width: none; margin: 0 auto 0 var(--s3); padding: 0 12px; }
    .bell { margin-left: 0; }
  }
</style>
