<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api.js';

  let data = $state(null);   // {ok, lines, total, meta}
  let status = $state(null); // {ok, active}
  let filter = $state('all');
  let q = $state('');
  let live = $state(false);
  let restarting = $state(false);
  let timer, debounce;

  async function refresh() {
    try { data = await api.organizerLogs({ filter, q, lines: 300 }); } catch { data = { ok: false }; }
    try { status = await api.organizerStatus(); } catch {}
  }
  onMount(refresh);
  onDestroy(() => { clearInterval(timer); clearTimeout(debounce); });

  $effect(() => { filter; refresh(); });
  $effect(() => {
    q;
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 300);
  });
  $effect(() => {
    clearInterval(timer);
    if (live) timer = setInterval(refresh, 4000);
  });

  async function restartOrganizer() {
    restarting = true;
    try { await api.organizerRestart(); } catch {}
    setTimeout(async () => { await refresh(); restarting = false; }, 3000);
  }

  function ago(ts) {
    if (!ts) return '—';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  }
  // Heartbeat older than 10 minutes = the known silent-freeze failure mode.
  const stale = $derived(data?.meta?.lastHeartbeat ? Date.now() - data.meta.lastHeartbeat > 10 * 60000 : false);
</script>

<div class="page">
  <header>
    <h1 class="display">Organizer</h1>
    {#if status}
      <span class={`pill ${status.active && !stale ? 'good' : 'bad'}`}>
        {status.active ? (stale ? 'Heartbeat stale' : 'Active') : 'Down'}
      </span>
    {/if}
    <button class="restart" onclick={restartOrganizer} disabled={restarting}>
      {restarting ? 'Restarting…' : 'Restart organizer'}
    </button>
  </header>

  {#if data?.meta}
    <div class="chips">
      <span class="chip">Heartbeat <strong class={stale ? 'bad' : ''}>{ago(data.meta.lastHeartbeat)}</strong></span>
      <span class="chip">Last activity <strong>{ago(data.meta.lastActivity)}</strong></span>
      <span class="chip">24h moves <strong>{data.meta.moves24h}</strong></span>
      <span class="chip">24h skips <strong>{data.meta.skips24h}</strong></span>
      <span class="chip">24h errors <strong class={data.meta.errors24h ? 'bad' : ''}>{data.meta.errors24h}</strong></span>
    </div>
  {/if}

  <div class="controls">
    <select bind:value={filter} aria-label="Filter">
      <option value="all">Everything</option>
      <option value="moves">Moves & matches</option>
      <option value="errors">Skips & errors</option>
      <option value="scans">Scans</option>
    </select>
    <input type="search" placeholder="Search log…" bind:value={q} spellcheck="false" />
    <label class="livetoggle"><input type="checkbox" bind:checked={live} /> Live tail</label>
  </div>

  {#if !data}
    <div class="spinner"></div>
  {:else if !data.ok}
    <p class="err">Organizer log unavailable{data.error ? ` — ${data.error}` : ''}.</p>
  {:else}
    <pre class="log">{data.lines.join('\n')}</pre>
    <p class="meta total">{data.lines.length} of {data.total} matching lines</p>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1100px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); flex-wrap: wrap; }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .pill {
    font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
    padding: 4px 12px; border-radius: 99px; background: var(--bg-raised);
  }
  .pill.good { color: #7ed491; }
  .pill.bad { color: #ff6b6b; }
  .restart {
    margin-left: auto; font-size: 0.85rem; font-weight: 600; color: var(--ink-soft);
    padding: 8px 16px; border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .restart:hover { color: var(--ink); background: rgba(242, 242, 244, 0.08); }
  .restart:disabled { opacity: 0.5; }

  .chips { display: flex; gap: var(--s2); flex-wrap: wrap; margin-bottom: var(--s4); }
  .chip {
    font-size: 0.8rem; color: var(--ink-soft);
    background: var(--bg-raised); border-radius: 99px; padding: 6px 14px;
  }
  .chip strong { color: var(--ink); margin-left: 4px; }
  .chip .bad, .bad { color: #ff6b6b !important; }

  .controls { display: flex; gap: var(--s2); margin-bottom: var(--s3); flex-wrap: wrap; align-items: center; }
  .controls select {
    font-family: inherit; font-size: 0.88rem; color: var(--ink);
    background: var(--bg-raised); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm); padding: 8px 12px; cursor: pointer;
  }
  .controls input[type='search'] { flex: 1; min-width: 180px; }
  .livetoggle { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; color: var(--ink-soft); cursor: pointer; }

  .log {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.78rem; line-height: 1.55; color: var(--ink-soft);
    background: var(--bg-sunken); border-radius: var(--r-md);
    padding: var(--s4); overflow: auto; max-height: 60vh;
    white-space: pre-wrap; word-break: break-all;
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .total { margin-top: var(--s2); }
  .err { color: #ff6b6b; }
  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
