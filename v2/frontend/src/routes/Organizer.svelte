<script>
  import { onDestroy } from 'svelte';
  import { createRefreshLoop } from '../lib/refresh-loop.js';
  import { api } from '../lib/api.js';
  import { describeClearResult, leftoverSummary } from '../lib/organizer-clear.js';
  import { describeStatus } from '../lib/organizer-status.js';
  import { groupByDay, kindLabel, countLabel, repeatLabel } from '../lib/organizer-feed.js';

  let data = $state(null);   // {ok, lines, total, meta}
  let status = $state(null); // {ok, active}
  let filter = $state('all');
  let q = $state('');
  let live = $state(false);
  let restarting = $state(false);
  let closed = false, firstRefresh = true;
  const delayed = new Set();
  let refreshError = $state('');
  let actionError = $state('');
  let lastUpdated = $state(null);
  function later(fn, delay) {
    const timer = setTimeout(() => { delayed.delete(timer); if (!closed) fn(); }, delay);
    delayed.add(timer);
  }

  // ── Needs Review (fix queue) ────────────────────────────────────────
  let fq = $state(null);          // {ok, queue, aliases, leftovers} — null = not admin / loading
  let fixTo = $state({});         // entryId -> corrected title input
  let fixBusy = $state({});       // entryId -> saving flag
  let fixDone = $state({});       // entryId -> 'retrying' message
  let fixError = $state({});
  let fixRetryIds = $state({});
  const retryPending = (id) => {
    const requestId = fixRetryIds[id];
    if (!requestId) return false;
    const receipt = (fq?.retries || []).find((retry) => retry.requestId === requestId);
    return !receipt || receipt.status === 'queued' || receipt.status === 'claimed';
  };
  const pendingRetry = $derived(Object.keys(fixRetryIds).some(retryPending));
  const hot = $derived((fq?.queue || []).filter((e) => e.stillPresent && !e.resolved));
  const history = $derived((fq?.queue || []).filter((e) => !e.stillPresent || e.resolved));
  const duplicateReview = (entry) => entry.manualReview && /^Movie already exists at /i.test(entry.reason || '');
  // Notes about the files of one release are one card: the release failed as a whole and is retried as a whole.
  const reviewGroups = $derived.by(() => {
    const groups = [], byRelease = new Map();
    for (const e of hot) {
      const key = e.manualReview && !duplicateReview(e) && e.source ? `${e.type}|${e.source}` : null;
      const held = key && byRelease.get(key);
      if (held) { held.entries.push(e); continue; }
      const group = { lead: e, entries: [e] };
      if (key) byRelease.set(key, group);
      groups.push(group);
    }
    return groups;
  });
  const groupMeta = (g) => `tried ${Math.max(...g.entries.map(e => e.count || 1))}× · ${ago(Math.max(...g.entries.map(e => e.lastSeen || 0)))}`;
  // "Destination conflict: English (SDH).eng.srt -> /library/Film (2026).eng.srt; source retained" -> what it means for that file.
  const shortReason = (e) => {
    const reason = String(e.reason || '').replace(/; source retained$/, '');
    const conflict = /^Destination conflict: .* -> (.+)$/.exec(reason);
    if (conflict) return `would be named ${conflict[1].split(/[\\/]/).pop()}`;
    return e.file ? reason.replace(e.file, '').replace(/:\s*$/, '').trim() : reason;
  };

  function applyFixQueue(d) {
    for (const e of d?.queue || []) {
      if (!(e.id in fixTo)) fixTo[e.id] = e.suggestedAlias || e.title;
    }
    fq = d;
    for (const [id, requestId] of Object.entries(fixRetryIds)) {
      const receipt = (d?.retries || []).find((retry) => retry.requestId === requestId);
      if (receipt?.status === 'attempted') {
        fixDone[id] = 'Retry attempted — review status refreshed.';
        delete fixRetryIds[id];
      }
      else if (receipt?.status === 'rejected') {
        fixDone[id] = '';
        fixError[id] = 'The source changed or is no longer available. Refresh the review queue before retrying.';
        delete fixRetryIds[id];
      }
    }
  }
  async function loadFixQueue() {
    try { const d = await api.organizerFixQueue(); if (!closed) applyFixQueue(d); }
    catch (e) { if (!closed) actionError = e.body?.error || 'Could not refresh the review queue.'; }
  }

  async function queueRetry(entry) {
    if (closed) return;
    const result = await api.organizerRetry(entry.id);
    if (!result?.ok || !result?.requestId) throw new Error('The retry was not queued. Please try again.');
    if (closed) return;
    fixRetryIds[entry.id] = result.requestId;
    fixDone[entry.id] = 'Retry queued — organizer will retry after the current import.';
    await loadFixQueue();
    loop.schedule();
  }

  // Persist the correction first; retry only this release at a safe boundary.
  async function saveFix(entry) {
    const to = (fixTo[entry.id] || '').trim();
    if (!to || fixBusy[entry.id] || retryPending(entry.id)) return;
    fixError[entry.id] = '';
    fixBusy[entry.id] = true;
    let aliasSaved = false;
    try {
      // The year ties an IMDb number to this release only (the server ignores it for a title).
      await api.organizerAliasSave({
        from: entry.title,
        to,
        type: entry.type === 'show' ? 'series' : 'movie',
        year: entry.year,
      });
      aliasSaved = true;
      if (closed) return;
      await queueRetry(entry);
    } catch (e) {
      if (!closed) fixError[entry.id] = e.body?.error || (aliasSaved
        ? 'Alias saved, but the retry could not be queued. Please try again.'
        : 'Failed to save alias. Please try again.');
    } finally {
      if (!closed) fixBusy[entry.id] = false;
    }
  }

  async function retryFix(entry) {
    if (fixBusy[entry.id] || retryPending(entry.id)) return;
    fixBusy[entry.id] = true;
    fixError[entry.id] = '';
    try { await queueRetry(entry); }
    catch (e) { if (!closed) fixError[entry.id] = e.body?.error || 'Could not queue this release. Please try again.'; }
    finally { if (!closed) fixBusy[entry.id] = false; }
  }

  async function removeAlias(id) {
    actionError = '';
    try { await api.organizerAliasDelete(id); await loadFixQueue(); } catch (e) { if (!closed) actionError = e.body?.error || 'Could not remove alias.'; }
  }

  // Delete the advertising and poster files that imported releases left in Share. It asks first,
  // and sends exactly the folders the question was about.
  let clearNames = $state(null);   // folders being asked about; null = not asking
  let clearBusy = $state(false);
  let clearMsg = $state('');
  let clearError = $state('');
  async function clearLeftovers() {
    if (!clearNames?.length || clearBusy) return;
    clearBusy = true;
    clearError = '';
    try {
      const result = await api.organizerClearLeftovers(clearNames);
      if (closed) return;
      clearMsg = describeClearResult(result);
      await loadFixQueue();
    } catch (e) {
      if (!closed) clearError = e.body?.error || 'Could not clear the leftovers. Please try again.';
    } finally {
      if (!closed) { clearBusy = false; clearNames = null; }
    }
  }

  const loop = createRefreshLoop({
    load: async () => {
      const query = { filter, q, lines: 300 };
      const [logs, service, queue] = await Promise.allSettled([
        api.organizerLogs(query), api.organizerStatus(), api.organizerFixQueue(),
      ]);
      return { query, logs, service, queue };
    },
    onData: ({ query, logs, service, queue }) => {
      if (query.filter !== filter || query.q !== q) return;
      const failures = [];
      if (logs.status === 'fulfilled' && logs.value.ok) data = logs.value;
      else failures.push('logs');
      if (service.status === 'fulfilled') status = service.value;
      else failures.push('service status');
      if (queue.status === 'fulfilled' && queue.value.ok) applyFixQueue(queue.value);
      else if (queue.reason?.status === 403) fq = null;
      else failures.push('review queue');
      refreshError = failures.length ? `Could not refresh ${failures.join(', ')}. Showing the last available information.` : '';
      if (!failures.length) lastUpdated = Date.now();
      if (!data && failures.includes('logs')) data = { ok: false };
    },
    onError: () => { refreshError = 'Organizer could not refresh. Try again.'; },
    interval: () => live || pendingRetry ? 4000 : 0,
  });
  const refresh = () => loop.refresh();
  onDestroy(() => { closed = true; loop.stop(); for (const timer of delayed) clearTimeout(timer); });
  // One initial request set; subsequent filter/search edits share a debounce.
  $effect(() => {
    filter; q; loop.invalidate();
    const timer = setTimeout(refresh, firstRefresh ? 0 : 300);
    firstRefresh = false;
    return () => clearTimeout(timer);
  });
  $effect(() => { live; pendingRetry; loop.schedule(); });

  async function restartOrganizer() {
    restarting = true; actionError = '';
    try {
      await api.organizerRestart();
      if (!closed) later(async () => { await refresh(); if (!closed) restarting = false; }, 3000);
    } catch (e) {
      if (!closed) { actionError = e.body?.error || 'Could not restart organizer.'; restarting = false; }
    }
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
  // What the organizer says it is doing now (absent for an organizer that does not write a status file).
  const liveStatus = $derived(describeStatus(data?.meta?.status));

  // The activity feed (built on the server from the same log), grouped by day. The raw log stays behind a toggle.
  let showRaw = $state(false), logBox = $state(null);
  const entries = $derived(data?.entries || []);
  const days = $derived(groupByDay(entries));
  const lastImport = $derived(data?.meta?.lastImport || null);
  const clock = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayOf = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  $effect(() => { if (showRaw && logBox && data?.lines) logBox.scrollTop = logBox.scrollHeight; });
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

  {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}
  {#if refreshError}<p class="err" role="status">{refreshError} <button onclick={refresh}>Retry</button></p>{/if}
  {#if lastUpdated}<p class="meta">Last refreshed {new Date(lastUpdated).toLocaleTimeString()}</p>{/if}
  {#if data?.meta}
    <div class="chips">
      <span class="chip">Heartbeat <strong class={stale ? 'bad' : ''}>{ago(data.meta.lastHeartbeat)}</strong></span>
      <span class="chip">Last import <strong>{lastImport ? `${lastImport.title} · ${ago(lastImport.at)}` : ago(data.meta.lastActivity)}</strong></span>
      <span class="chip">24h moves <strong>{data.meta.moves24h}</strong></span>
      <span class="chip">24h skips <strong>{data.meta.skips24h}</strong></span>
      <span class="chip">24h errors <strong class={data.meta.errors24h ? 'bad' : ''}>{data.meta.errors24h}</strong></span>
    </div>
    {#if liveStatus}
      <p class="doing" aria-label="What the organizer is doing now">{liveStatus.activity}
        {#if liveStatus.requests}<span class={liveStatus.nearLimit ? 'bad' : 'rmeta'}> · {liveStatus.requests}</span>{/if}
      </p>
      {#if liveStatus.omdb}<p class="warn" role="status">{liveStatus.omdb}</p>{/if}
    {/if}
  {/if}

  {#if fq?.ok}
    <section class="review">
      <h2>
        Needs review
        {#if reviewGroups.length + (fq.leftovers?.length || 0) > 0}
          <span class="badge">{reviewGroups.length + (fq.leftovers?.length || 0)}</span>
        {/if}
      </h2>

      {#if !hot.length && !(fq.leftovers?.length)}
        <p class="allclear">Nothing needs review.</p>
      {/if}

      {#each reviewGroups as g (g.lead.id)}
        {@const e = g.lead}
        <div class="rrow">
          <div class="rinfo">
            <span class="rtype">{e.type === 'show' ? 'Series' : 'Film'}</span>
            <span class="rtitle">{e.title}{e.year ? ` (${e.year})` : ''}</span>
            {#if g.entries.length > 1}
              <span class="rmeta">{g.entries.length} files could not be placed · {groupMeta(g)}</span>
            {:else}
              <span class="rmeta">{duplicateReview(e) ? 'Already in library; new download kept for comparison' : e.reason} · tried {e.count}× · {ago(e.lastSeen)}</span>
            {/if}
          </div>
          {#if g.entries.length > 1}
            <ul class="rfiles">
              {#each g.entries as x (x.id)}<li>{x.file || x.reason}{#if x.file} <span>{shortReason(x)}</span>{/if}</li>{/each}
            </ul>
          {/if}
          {#if fixDone[e.id]}
            <p class="rdone" role="status">{fixDone[e.id]}</p>
          {/if}
          {#if duplicateReview(e)}
            <p class="rmeta">Compare the new download with your library copy before deciding which one to keep.</p>
          {:else if e.manualReview}
            <p class="rmeta">Files have been kept in Share. Check the file names and any existing copy, then retry this release after correcting them.</p>
            <button class="rsave" onclick={() => retryFix(e)} disabled={fixBusy[e.id] || retryPending(e.id)}>
              {fixBusy[e.id] ? 'Queuing…' : retryPending(e.id) ? 'Retry queued' : 'Retry this release'}
            </button>
          {:else}
            <div class="rfix">
              <input
                placeholder="Correct title (as OMDb knows it), or its IMDb link"
                bind:value={fixTo[e.id]}
                onkeydown={(ev) => ev.key === 'Enter' && saveFix(e)}
              />
              <button class="rsave" onclick={() => saveFix(e)} disabled={fixBusy[e.id] || retryPending(e.id) || !(fixTo[e.id] || '').trim()}>
                {fixBusy[e.id] ? 'Saving…' : retryPending(e.id) ? 'Retry queued' : 'Fix & retry'}
              </button>
            </div>
          {/if}
          {#if fixError[e.id]}<p class="err" role="alert">{fixError[e.id]}</p>{/if}
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

      {#if fq.importedLeftovers?.length}
        <details class="rextra">
          <summary>{fq.importedLeftovers.length} imported release{fq.importedLeftovers.length > 1 ? 's' : ''} with other files left behind</summary>
          {#each fq.importedLeftovers as l (l.name)}
            <div class="hrow">
              <span class="rtype">Imported</span>
              <span class="rtitle">{l.name}</span>
              <span class="rmeta">{l.reason}</span>
            </div>
          {/each}
          <div class="rclear">
            {#if clearNames}
              <p class="rmeta">{leftoverSummary(clearNames)}</p>
              <button class="rsave" onclick={clearLeftovers} disabled={clearBusy}>{clearBusy ? 'Deleting…' : 'Yes, delete them'}</button>
              <button class="rcancel" onclick={() => (clearNames = null)} disabled={clearBusy}>Cancel</button>
            {:else}
              <button class="rsave" onclick={() => { clearNames = fq.importedLeftovers.map((l) => l.name); clearMsg = ''; clearError = ''; }}>
                Clear leftover files…
              </button>
            {/if}
          </div>
        </details>
      {/if}
      {#if clearMsg}<p class="rdone" role="status">{clearMsg}</p>{/if}
      {#if clearError}<p class="err" role="alert">{clearError}</p>{/if}

      {#if history.length}
        <details class="rextra">
          <summary>{history.length} past review item{history.length > 1 ? 's' : ''}</summary>
          {#each history as e (e.id)}
            <div class="hrow">
              <span class="rtype">{e.type === 'show' ? 'Series' : 'Film'}</span>
              <span class="rtitle">{e.title}{e.year ? ` (${e.year})` : ''}</span>
              <span class="rmeta">{e.resolved ? (e.resolution === 'Imported after review' ? 'Imported afterwards' : 'Resolved after retry') : 'No longer in Share'} · {e.reason} · {ago(e.lastSeen)}{e.suggestedAlias ? ` · alias → ${e.suggestedAlias}` : ''}</span>
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
              <span class="rtitle">{a.from}{a.year ? ` (${a.year})` : ''} → {a.to}</span>
              <button class="rdel" title="Remove alias" onclick={() => removeAlias(a.id)}>✕</button>
            </div>
          {/each}
        </details>
      {/if}
    </section>
  {/if}

  <div class="controls">
    <div class="pills" role="group" aria-label="Show">
      {#each [['all', 'All'], ['imports', 'Imports'], ['problems', 'Problems'], ['organizer', 'Organizer']] as [value, label] (value)}
        <button aria-pressed={filter === value} onclick={() => { filter = value; }}>{label}</button>
      {/each}
    </div>
    <input type="search" placeholder="Search activity…" aria-label="Search activity" bind:value={q} spellcheck="false" />
    <label class="livetoggle"><input type="checkbox" bind:checked={live} /> Live tail</label>
    <label class="livetoggle"><input type="checkbox" bind:checked={showRaw} /> Raw log</label>
  </div>

  {#if !data}
    <div class="spinner"></div>
  {:else if !data.ok}
    <p class="err">Organizer log unavailable{data.error ? ` — ${data.error}` : ''}.</p>
  {:else if showRaw}
    <pre class="log" bind:this={logBox}>{data.lines.join('\n')}</pre>
    <p class="meta total">{data.lines.length} of {data.total} matching lines · newest at the bottom</p>
  {:else}
    <section class="feed" aria-label="Organizer activity">
      {#if !entries.length}
        <p class="empty">{q ? 'Nothing in the log matches that.' : filter === 'all' ? 'Nothing in the log yet.' : 'Nothing of that kind in the log.'}</p>
      {/if}
      {#each days as day (day.key)}
        <h3 class="day display">{day.label}</h3>
        {#each day.entries as e (e.id)}
          <article class={`entry ${e.kind}`}>
            <time class="when" datetime={new Date(e.at || 0).toISOString()}>{e.at ? clock(e.at) : ''}</time>
            <div class="ebody">
              <span class="ekind">{kindLabel(e)}</span>
              <span class="etitle">{e.title}</span>
              {#if e.summary}<span class="esummary">{e.summary}</span>{/if}
              {#if repeatLabel(e)}<span class="emeta">{repeatLabel(e)}{e.since && e.kind !== 'start' ? `, since ${dayOf(e.since)}` : ''}</span>{/if}
              {#if e.to}<span class="emeta">→ {e.to}</span>{/if}
              {#if e.matched && e.matched !== e.title}<span class="emeta">Matched as {e.matched}</span>{/if}
              {#if e.release && e.release !== e.title}<span class="emeta mono">{e.release}</span>{/if}
              {#each e.notes || [] as n (n)}<span class="enote">{n}</span>{/each}
              {#if e.items?.length > 1}
                <details class="eitems">
                  <summary>{countLabel(e)}</summary>
                  <ul>{#each e.items as item, i (i)}<li><span class="ilabel">{item.label}</span><span class="ipath">{item.to}</span></li>{/each}</ul>
                </details>
              {/if}
            </div>
          </article>
        {/each}
      {/each}
      {#if data.entriesTotal > entries.length}<p class="meta total">Showing the newest {entries.length} of {data.entriesTotal}</p>{/if}
    </section>
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
  .restart:hover { color: var(--ink); background: rgba(243, 237, 228, 0.08); }
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
    color: var(--ink-soft); background: rgba(243, 237, 228, 0.08);
    padding: 2px 8px; border-radius: 4px;
  }
  .rtitle { font-weight: 600; font-size: 0.95rem; }
  .rmeta { font-size: 0.78rem; color: var(--ink-faint); }
  .rfiles { margin: 0; padding-left: var(--s4); display: grid; gap: 2px; font-size: 0.82rem; color: var(--ink-soft); }
  .rfiles span { color: var(--ink-faint); }
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
  .doing { font-size: 0.88rem; color: var(--ink-soft); margin: var(--s2) 0 var(--s3); }
  .warn { font-size: 0.88rem; color: #f5c04a; background: rgba(245, 192, 74, 0.1); padding: var(--s2) var(--s3); border-radius: var(--r-sm); margin: 0 0 var(--s3); }
  .rclear { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; padding: var(--s2) 0 var(--s2) var(--s3); }
  .rclear .rmeta { flex-basis: 100%; margin: 0; }
  .rcancel { color: var(--ink-soft); font-size: 0.85rem; padding: 8px 12px; border-radius: var(--r-sm); }
  .rcancel:hover:not(:disabled) { color: var(--ink); background: rgba(243, 237, 228, 0.08); }
  .rcancel:disabled { opacity: 0.45; cursor: not-allowed; }
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
  .pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pills button {
    min-height: 36px; padding: 0 14px; border-radius: var(--r-pill);
    box-shadow: inset 0 0 0 1px var(--line-strong); color: var(--ink-soft); font-size: 0.85rem; font-weight: 600;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .pills button:hover { color: var(--ink); }
  .pills button[aria-pressed='true'] { background: var(--accent); color: var(--accent-ink); box-shadow: none; }
  .controls input[type='search'] { flex: 1; min-width: 180px; }

  /* ── Activity feed ── */
  .feed { display: flex; flex-direction: column; gap: 6px; }
  .day { font-size: 1.35rem; line-height: 1; margin: var(--s4) 0 var(--s2); }
  .day:first-child { margin-top: 0; }
  .entry {
    display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px;
    padding: 12px 14px; border-radius: var(--r-md);
    background: var(--bg-raised); box-shadow: inset 0 0 0 1px var(--line);
  }
  .when { color: var(--ink-faint); font-size: 0.8rem; font-variant-numeric: tabular-nums; padding-top: 3px; }
  .ebody { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .ekind { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
  .entry.import .ekind { color: var(--good); }
  .entry.skip .ekind { color: var(--warn); }
  .entry.review .ekind, .entry.problem .ekind { color: var(--bad); }
  .etitle { font-weight: 600; font-size: 0.98rem; overflow-wrap: anywhere; }
  .esummary { font-size: 0.88rem; }
  .emeta { color: var(--ink-faint); font-size: 0.8rem; overflow-wrap: anywhere; }
  .emeta.mono { font-family: ui-monospace, Menlo, monospace; font-size: 0.74rem; }
  .enote { color: var(--ink-soft); font-size: 0.82rem; }
  .eitems { margin-top: 4px; }
  .eitems summary { cursor: pointer; color: var(--ink-soft); font-size: 0.82rem; font-weight: 600; padding: 4px 0; width: max-content; }
  .eitems summary:hover { color: var(--ink); }
  .eitems ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .eitems li { display: flex; flex-direction: column; gap: 1px; padding: 6px 10px; border-radius: var(--r-sm); background: var(--bg-sunken); }
  .ilabel { font-size: 0.85rem; }
  .ipath { font-family: ui-monospace, Menlo, monospace; font-size: 0.72rem; color: var(--ink-faint); overflow-wrap: anywhere; }
  .empty { color: var(--ink-faint); font-size: 0.9rem; padding: var(--s4) 0; }
  @media (max-width: 640px) { .entry { grid-template-columns: 1fr; gap: 4px; } .when { padding: 0; } }
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
