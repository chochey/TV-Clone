<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api.js';

  let torrents = $state(null);
  let magnet = $state('');
  let busy = $state(false);
  let err = $state('');
  let confirmDel = $state(null); // hash pending delete confirmation
  let timer;

  // ── Torrent search (qBittorrent search plugins via v1) ──────────────
  const CATEGORIES = [
    { key: 'all', label: 'All' },
    { key: 'movies', label: 'Movies' },
    { key: 'tv', label: 'TV' },
    { key: 'anime', label: 'Anime' },
    { key: 'music', label: 'Music' },
    { key: 'software', label: 'Software' },
  ];
  let plugins = $state([]);
  let q = $state('');
  let cat = $state('all');
  let plugin = $state('enabled');
  let searchId = null;
  let searching = $state(false);
  let results = $state(null);
  let searchErr = $state('');
  let added = $state(new Set()); // fileUrls already sent to qbt
  let pollTimer = null;
  let pollDeadline = 0;

  async function refresh() {
    try { torrents = await api.torrents(); err = ''; }
    catch (e) { err = e.body?.error || 'qBittorrent unreachable.'; if (!torrents) torrents = []; }
  }
  onMount(() => {
    refresh();
    timer = setInterval(refresh, 5000);
    api.searchPlugins()
      .then((p) => { plugins = (p || []).filter((x) => x.enabled); })
      .catch(() => {});
  });
  onDestroy(() => { clearInterval(timer); stopSearch(); });

  async function stopSearch() {
    clearTimeout(pollTimer);
    if (searchId != null) api.searchStop(searchId);
    searchId = null;
    searching = false;
  }

  async function startSearch(e) {
    e.preventDefault();
    if (!q.trim()) return;
    await stopSearch();
    searching = true;
    results = null;
    searchErr = '';
    try {
      const r = await api.searchStart(q.trim(), cat, plugin);
      searchId = r.id;
      pollDeadline = Date.now() + 60000;
      poll();
    } catch (e2) {
      searchErr = e2.body?.error || 'Search failed — are search plugins installed in qBittorrent?';
      searching = false;
    }
  }

  async function poll() {
    if (searchId == null) return;
    try {
      const r = await api.searchResults(searchId);
      results = (r.results || []).slice().sort((a, b) => (b.nbSeeders || 0) - (a.nbSeeders || 0));
      if (r.status === 'Running' && Date.now() < pollDeadline) {
        pollTimer = setTimeout(poll, 2000);
      } else {
        stopSearch();
      }
    } catch {
      stopSearch();
    }
  }

  async function grab(r) {
    try {
      await api.torrentAdd(r.fileUrl);
      added = new Set([...added, r.fileUrl]);
      refresh();
    } catch (e2) {
      searchErr = e2.body?.error || 'Could not add that torrent.';
    }
  }

  async function add(e) {
    e.preventDefault();
    if (busy || !magnet.trim()) return;
    busy = true; err = '';
    try { await api.torrentAdd(magnet.trim()); magnet = ''; await refresh(); }
    catch (e2) { err = e2.body?.error || 'Could not add torrent.'; }
    finally { busy = false; }
  }

  const PAUSED = new Set(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP']);
  const label = (s) => ({
    downloading: 'Downloading', stalledDL: 'Stalled', metaDL: 'Fetching metadata',
    uploading: 'Seeding', stalledUP: 'Seeding', queuedDL: 'Queued', queuedUP: 'Queued',
    pausedDL: 'Paused', stoppedDL: 'Paused', pausedUP: 'Done', stoppedUP: 'Done',
    checkingDL: 'Checking', checkingUP: 'Checking', error: 'Error', missingFiles: 'Missing files',
  }[s] || s);

  function fmtBytes(b) {
    if (!b) return '0 B';
    if (b < 1e6) return (b / 1e3).toFixed(0) + ' KB';
    if (b < 1e9) return (b / 1e6).toFixed(1) + ' MB';
    return (b / 1e9).toFixed(2) + ' GB';
  }
  function fmtSpeed(b) { return b ? fmtBytes(b) + '/s' : ''; }
  function fmtEta(s) {
    if (!s || s >= 8640000) return '';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }
</script>

<div class="page">
  <header><h1 class="display">Downloads</h1></header>

  <form class="add" onsubmit={add}>
    <input type="text" placeholder="Paste a magnet link or torrent URL" bind:value={magnet} spellcheck="false" />
    <button class="cta" type="submit" disabled={busy || !magnet.trim()}>{busy ? 'Adding…' : 'Add'}</button>
  </form>
  {#if err}<p class="err">{err}</p>{/if}

  <form class="searchbar" onsubmit={startSearch}>
    <input type="search" placeholder="Search torrents…" bind:value={q} spellcheck="false" />
    <select bind:value={cat} aria-label="Category">
      {#each CATEGORIES as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
    </select>
    <select bind:value={plugin} aria-label="Site">
      <option value="enabled">All sites</option>
      {#each plugins as p (p.name)}<option value={p.name}>{p.fullName || p.name}</option>{/each}
    </select>
    <button class="cta" type="submit" disabled={!q.trim()}>{searching ? 'Searching…' : 'Search'}</button>
    {#if results}<button class="clear" type="button" onclick={() => { stopSearch(); results = null; }}>Clear</button>{/if}
  </form>
  {#if searchErr}<p class="err">{searchErr}</p>{/if}

  {#if results}
    <div class="results">
      <p class="meta rescount">
        {results.length} result{results.length === 1 ? '' : 's'}{searching ? ' — still searching…' : ''}
      </p>
      {#each results.slice(0, 60) as r (r.fileUrl)}
        <div class="row rrow">
          <div class="text">
            <a class="t rname" href={r.descrLink || r.siteUrl} target="_blank" rel="noreferrer noopener">{r.fileName}</a>
            <span class="sub meta">
              {fmtBytes(r.fileSize)} · {r.nbSeeders ?? 0} seeders · {r.nbLeechers ?? 0} leechers
            </span>
          </div>
          <div class="actions">
            {#if added.has(r.fileUrl)}
              <span class="addedtag">✓ Added</span>
            {:else}
              <button onclick={() => grab(r)}>Download</button>
            {/if}
          </div>
        </div>
      {/each}
      {#if !results.length && !searching}
        <p class="empty">No results{plugin !== 'enabled' ? ' on that site' : ''}.</p>
      {/if}
    </div>
  {/if}

  {#if !torrents}
    <div class="spinner"></div>
  {:else if !torrents.length}
    <p class="empty">No torrents.</p>
  {:else}
    <div class="list">
      {#each torrents as t (t.hash)}
        <div class="row">
          <div class="text">
            <span class="t">{t.name}</span>
            <span class="sub meta">
              {label(t.state)} · {fmtBytes(t.size)}
              {#if t.dlspeed}· ↓ {fmtSpeed(t.dlspeed)}{/if}
              {#if t.upspeed}· ↑ {fmtSpeed(t.upspeed)}{/if}
              {#if fmtEta(t.eta)}· {fmtEta(t.eta)} left{/if}
            </span>
            <span class="bar" class:done={t.progress >= 1}><span style={`width:${(t.progress * 100).toFixed(1)}%`}></span></span>
          </div>
          <span class="pct">{(t.progress * 100).toFixed(0)}%</span>
          <div class="actions">
            {#if PAUSED.has(t.state)}
              <button onclick={() => api.torrentResume(t.hash).then(refresh)}>Resume</button>
            {:else}
              <button onclick={() => api.torrentPause(t.hash).then(refresh)}>Pause</button>
            {/if}
            {#if confirmDel === t.hash}
              <button class="danger" onclick={() => { confirmDel = null; api.torrentDelete(t.hash, false).then(refresh); }}>Remove torrent</button>
              <button class="danger" onclick={() => { confirmDel = null; api.torrentDelete(t.hash, true).then(refresh); }}>+ files</button>
              <button onclick={() => { confirmDel = null; }}>Keep</button>
            {:else}
              <button class="danger" onclick={() => { confirmDel = t.hash; }}>Delete</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1000px; margin: 0 auto; }
  header { margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }

  .add { display: flex; gap: var(--s2); margin-bottom: var(--s3); }
  .add input { flex: 1; }

  .searchbar { display: flex; gap: var(--s2); margin-bottom: var(--s3); flex-wrap: wrap; align-items: center; }
  .searchbar input[type='search'] { flex: 1; min-width: 200px; }
  .searchbar select {
    font-family: inherit; font-size: 0.9rem; color: var(--ink);
    background: var(--bg-raised); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm); padding: 11px 12px; cursor: pointer;
  }
  .clear { font-size: 0.85rem; font-weight: 600; color: var(--ink-soft); padding: 10px 14px; }
  .clear:hover { color: var(--ink); }

  .results { margin-bottom: var(--s5); }
  .rescount { margin-bottom: var(--s2); }
  .rrow { border-top: 1px solid var(--line); }
  .rname { font-weight: 600; font-size: 0.92rem; word-break: break-all; }
  .rname:hover { text-decoration: underline; }
  .addedtag { font-size: 0.82rem; font-weight: 700; color: #7ed491; padding: 7px 12px; }
  .cta { background: var(--cta); color: var(--cta-ink); font-weight: 700; padding: 11px 24px; border-radius: var(--r-sm); }
  .cta:disabled { opacity: 0.4; cursor: default; }
  .err { color: #ff6b6b; font-size: 0.9rem; margin-bottom: var(--s3); }
  .empty { color: var(--ink-faint); padding: var(--s5) 0; }
  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .list { display: flex; flex-direction: column; margin-top: var(--s4); }
  .row {
    display: flex; gap: var(--s4); align-items: center;
    padding: var(--s3) 0; border-top: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .text { flex: 1; min-width: 260px; display: flex; flex-direction: column; gap: 5px; }
  .t { font-weight: 600; font-size: 0.95rem; word-break: break-all; }
  .sub { text-transform: none; letter-spacing: 0.02em; font-size: 0.78rem; }
  .bar { display: block; height: 4px; background: rgba(242, 242, 244, 0.12); border-radius: 99px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--ink-soft); }
  .bar.done span { background: #7ed491; }
  .pct { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 44px; text-align: right; }
  .actions { display: flex; gap: var(--s2); flex-wrap: wrap; }
  .actions button {
    font-size: 0.82rem; font-weight: 600; color: var(--ink-soft);
    padding: 7px 12px; border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .actions button:hover { color: var(--ink); background: rgba(242, 242, 244, 0.08); }
  .actions .danger:hover { color: #ff6b6b; }
</style>
