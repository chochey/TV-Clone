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

  // ── Needs Review (fix queue) ────────────────────────────────────────
  let fq = $state(null);          // {ok, queue, aliases, leftovers} — null = not admin / loading
  let fixTo = $state({});         // entryId -> corrected title input
  let fixBusy = $state({});       // entryId -> saving flag
  let fixDone = $state({});       // entryId -> 'retrying' message
  const hot = $derived((fq?.queue || []).filter((e) => e.stillPresent));
  const history = $derived((fq?.queue || []).filter((e) => !e.stillPresent));

  async function loadFixQueue() {
    try {
      const d = await api.organizerFixQueue();
      for (const e of d.queue || []) {
        if (!(e.id in fixTo)) fixTo[e.id] = e.suggestedAlias || e.title;
      }
      fq = d;
    } catch { fq = null; } // 403 for non-admin — hide the panel
  }

  // Save the alias, then bounce the organizer so it re-scans Share with it.
  async function saveFix(entry) {
    const to = (fixTo[entry.id] || '').trim();
    if (!to) return;
    fixBusy[entry.id] = true;
    try {
      await api.organizerAliasSave({
        from: entry.title,
        to,
        type: entry.type === 'show' ? 'series' : 'movie',
      });
      await api.organizerRestart();
      fixDone[entry.id] = 'Alias saved — organizer is retrying…';
      setTimeout(async () => { await loadFixQueue(); fixDone[entry.id] = ''; }, 8000);
    } catch (e) {
      fixDone[entry.id] = e.body?.error || 'Failed to save alias';
    } finally {
      fixBusy[entry.id] = false;
    }
  }

  async function removeAlias(id) {
    try { await api.organizerAliasDelete(id); await loadFixQueue(); } catch {}
  }

  async function refresh() {
    try { data = await api.organizerLogs({ filter, q, lines: 300 }); } catch { data = { ok: false }; }
    try { status = await api.organizerStatus(); } catch {}
    loadFixQueue();
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

  {#if fq?.ok}
    <section class="review">
      <h2>
        Needs review
        {#if hot.length + (fq.leftovers?.length || 0) > 0}
          <span class="badge">{hot.length + (fq.leftovers?.length || 0)}</span>
        {/if}
      </h2>

      {#if !hot.length && !(fq.leftovers?.length)}
        <p class="allclear">Nothing stuck — the Share folder is clean.</p>
      {/if}

      {#each hot as e (e.id)}
        <div class="rrow">
          <div class="rinfo">
            <span class="rtype">{e.type === 'show' ? 'Series' : 'Film'}</span>
            <span class="rtitle">{e.title}{e.year ? ` (${e.year})` : ''}</span>
            <span class="rmeta">{e.reason} · tried {e.count}× · {ago(e.lastSeen)}</span>
          </div>
          {#if fixDone[e.id]}
            <p class="rdone">{fixDone[e.id]}</p>
          {:else}
            <div class="rfix">
              <input
                placeholder="Correct title (as OMDb knows it)"
                bind:value={fixTo[e.id]}
                onkeydown={(ev) => ev.key === 'Enter' && saveFix(e)}
              />
              <button class="rsave" onclick={() => saveFix(e)} disabled={fixBusy[e.id] || !(fixTo[e.id] || '').trim()}>
                {fixBusy[e.id] ? 'Saving…' : 'Fix & retry'}
              </button>
            </div>
          {/if}
        </div>
      {/each}

      {#each fq.leftovers || [] as l (l.name)}
        <div class="rrow leftover">
          <div class="rinfo">
            <span class="rtype">Leftover</span>
            <span class="rtitle">{l.name}</span>
            <span class="rmeta">still in Share, no matching failure · {ago(l.mtime)}</span>
          </div>
        </div>
      {/each}

      {#if history.length}
        <details class="rextra">
          <summary>{history.length} past failure{history.length > 1 ? 's' : ''} (no longer in Share)</summary>
          {#each history as e (e.id)}
            <div class="hrow">
              <span class="rtype">{e.type === 'show' ? 'Series' : 'Film'}</span>
              <span class="rtitle">{e.title}{e.year ? ` (${e.year})` : ''}</span>
              <span class="rmeta">{e.reason} · {ago(e.lastSeen)}{e.suggestedAlias ? ` · alias → ${e.suggestedAlias}` : ''}</span>
            </div>
          {/each}
        </details>
      {/if}

      {#if fq.aliases?.length}
        <details class="rextra">
          <summary>{fq.aliases.length} title alias{fq.aliases.length > 1 ? 'es' : ''}</summary>
          {#each fq.aliases as a (a.id)}
            <div class="hrow">
              <span class="rtype">{a.type}</span>
              <span class="rtitle">{a.from} → {a.to}</span>
              <button class="rdel" title="Remove alias" onclick={() => removeAlias(a.id)}>✕</button>
            </div>
          {/each}
        </details>
      {/if}
    </section>
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

  /* ── Needs review panel ── */
  .review {
    background: var(--bg-raised); border: 1px solid var(--line);
    border-radius: var(--r-md); padding: var(--s4);
    margin-bottom: var(--s4);
  }
  .review h2 {
    font-size: 1rem; font-weight: 700; margin-bottom: var(--s3);
    display: flex; align-items: center; gap: var(--s2);
  }
  .badge {
    background: #e5484d; color: #fff; font-size: 0.72rem; font-weight: 700;
    min-width: 20px; height: 20px; border-radius: 99px;
    display: inline-grid; place-items: center; padding: 0 6px;
  }
  .allclear { color: var(--ink-faint); font-size: 0.88rem; }
  .rrow {
    display: flex; flex-direction: column; gap: var(--s2);
    padding: var(--s3) 0; border-top: 1px solid var(--line);
  }
  .rrow:first-of-type { border-top: none; }
  .rinfo { display: flex; align-items: baseline; gap: var(--s2); flex-wrap: wrap; }
  .rtype {
    font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--ink-soft); background: rgba(242, 242, 244, 0.08);
    padding: 2px 8px; border-radius: 4px;
  }
  .rtitle { font-weight: 600; font-size: 0.95rem; }
  .rmeta { font-size: 0.78rem; color: var(--ink-faint); }
  .rfix { display: flex; gap: var(--s2); flex-wrap: wrap; }
  .rfix input {
    flex: 1; min-width: 220px; font-size: 0.88rem;
  }
  .rsave {
    background: var(--cta); color: var(--cta-ink); font-weight: 700; font-size: 0.85rem;
    padding: 8px 18px; border-radius: var(--r-sm); transition: opacity var(--t-fast);
  }
  .rsave:hover:not(:disabled) { opacity: 0.85; }
  .rsave:disabled { opacity: 0.45; cursor: not-allowed; }
  .rdone { font-size: 0.85rem; color: #7ed491; }
  .leftover .rtitle { font-weight: 500; font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; }
  .rextra { margin-top: var(--s3); }
  .rextra summary {
    font-size: 0.82rem; color: var(--ink-soft); cursor: pointer;
    padding: var(--s2) 0;
  }
  .rextra summary:hover { color: var(--ink); }
  .hrow {
    display: flex; align-items: center; gap: var(--s2);
    padding: 6px 0 6px var(--s3); font-size: 0.85rem; flex-wrap: wrap;
  }
  .hrow .rtitle { font-size: 0.85rem; }
  .rdel {
    margin-left: auto; color: var(--ink-faint); font-size: 0.8rem;
    width: 24px; height: 24px; border-radius: 99px;
  }
  .rdel:hover { color: #ff6b6b; background: rgba(229, 72, 77, 0.12); }

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
