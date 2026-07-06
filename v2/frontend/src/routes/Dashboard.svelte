<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api.js';

  let stats = $state(null);
  let sys = $state(null);
  let rel = $state(null);
  let org = $state(null);
  let watching = $state([]);
  let timer;

  function fmtBytes(b) {
    if (b == null) return '—';
    if (b < 1e9) return (b / 1e6).toFixed(0) + ' MB';
    if (b < 1e12) return (b / 1e9).toFixed(1) + ' GB';
    return (b / 1e12).toFixed(2) + ' TB';
  }

  async function tick() {
    try { sys = await api.systemStats(); } catch {}
    try { watching = await api.nowWatching(); } catch {}
  }
  onMount(async () => {
    tick();
    try { stats = await api.stats(); } catch {}
    try { org = await api.organizerStatus(); } catch {}
    try { rel = await api.reliability(); } catch {}
    timer = setInterval(tick, 15000);
  });
  onDestroy(() => clearInterval(timer));

  const relChecks = $derived(rel?.checks ? Object.entries(rel.checks) : []);
  function checkLabel(k) {
    return { app: 'App', appService: 'App service', organizerService: 'Organizer service', dockerService: 'Docker (VPN + qBt)' }[k]
      || k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }
</script>

<div class="page">
  <header><h1 class="display">Dashboard</h1></header>

  <div class="cards">
    <section class="card">
      <h2 class="meta">Library</h2>
      {#if stats}
        <div class="bignum">{stats.totalFiles?.toLocaleString()}<span> files</span></div>
        <div class="kv"><span>Films</span><strong>{stats.movies}</strong></div>
        <div class="kv"><span>Series</span><strong>{stats.shows}</strong> <em>({stats.episodes?.toLocaleString()} episodes)</em></div>
        <div class="kv"><span>Total size</span><strong>{fmtBytes(stats.totalSize)}</strong></div>
      {:else}<div class="dim">…</div>{/if}
    </section>

    <section class="card">
      <h2 class="meta">System</h2>
      {#if sys}
        <div class="kv"><span>CPU</span><strong>{sys.cpu?.percent ?? '—'}%</strong> <em>load {sys.cpu?.loadAvg?.[0]?.toFixed(1)}</em></div>
        <div class="gauge"><span style={`width:${sys.cpu?.percent || 0}%`}></span></div>
        <div class="kv"><span>Memory</span><strong>{sys.memory?.percent}%</strong> <em>{fmtBytes(sys.memory?.used)} of {fmtBytes(sys.memory?.total)}</em></div>
        <div class="gauge"><span style={`width:${sys.memory?.percent || 0}%`}></span></div>
        <div class="kv"><span>Active transcodes</span><strong>{sys.activeTranscodes ?? 0}</strong></div>
      {:else}<div class="dim">…</div>{/if}
    </section>

    <section class="card">
      <h2 class="meta">Health</h2>
      <div class="kv"><span>Organizer</span>
        <strong class={org?.active ? 'good' : 'bad'}>{org ? (org.active ? 'Active' : 'Down') : '…'}</strong>
      </div>
      {#each relChecks as [key, c] (key)}
        <div class="kv"><span>{checkLabel(key)}</span>
          <strong class={c?.ok ? 'good' : 'bad'}>{c?.ok ? 'OK' : (c?.status || 'Failing')}</strong>
        </div>
      {/each}
      {#if rel && !rel.ok}<p class="warn">Something needs attention.</p>{/if}
    </section>

    <section class="card wide">
      <h2 class="meta">Storage</h2>
      {#if sys?.disks}
        {#each sys.disks as d (d.mount)}
          <div class="kv disk"><span title={d.source}>{d.mount}</span>
            <strong>{d.percent}%</strong> <em>{fmtBytes(d.available)} free of {fmtBytes(d.total)}</em>
          </div>
          <div class="gauge" class:hot={d.percent >= 90}><span style={`width:${d.percent}%`}></span></div>
        {/each}
      {:else}<div class="dim">…</div>{/if}
    </section>

    <section class="card wide">
      <h2 class="meta">Now watching</h2>
      {#if watching.length}
        {#each watching as w (w.profileName + w.id)}
          <div class="kv"><span>{w.profileName}</span><strong>{w.title}</strong>
            <em>{w.percent ? `${Math.round(w.percent)}%` : ''}</em></div>
        {/each}
      {:else}
        <div class="dim">Nobody's watching right now.</div>
      {/if}
    </section>
  </div>
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1100px; margin: 0 auto; }
  header { margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--s3); }
  .card {
    background: var(--bg-raised); border-radius: var(--r-md);
    padding: var(--s4); box-shadow: inset 0 0 0 1px var(--line);
    display: flex; flex-direction: column; gap: var(--s2);
  }
  .card.wide { grid-column: 1 / -1; }
  .card h2 { margin-bottom: var(--s1); }
  .bignum { font-size: 2rem; font-weight: 800; letter-spacing: -0.02em; }
  .bignum span { font-size: 0.95rem; font-weight: 500; color: var(--ink-soft); margin-left: 6px; }
  .kv { display: flex; align-items: baseline; gap: var(--s2); font-size: 0.92rem; }
  .kv span:first-child { color: var(--ink-soft); flex: 0 0 auto; min-width: 130px; }
  .kv.disk span:first-child { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kv em { font-style: normal; color: var(--ink-faint); font-size: 0.82rem; }
  .good { color: #7ed491; }
  .bad { color: #ff6b6b; }
  .warn { color: #ffb46b; font-size: 0.85rem; }
  .dim { color: var(--ink-faint); }
  .gauge {
    height: 4px; background: rgba(242, 242, 244, 0.12);
    border-radius: 99px; overflow: hidden;
  }
  .gauge span { display: block; height: 100%; background: var(--ink-soft); }
  .gauge.hot span { background: #ff6b6b; }
</style>
