<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { waitForRestart, currentUptime } from '../lib/restart.js';
  import { createRefreshLoop } from '../lib/refresh-loop.js';
  import { physicalDriveWarnings } from '../lib/storage-warnings.js';
  import { fmtBytes, fmtDuration, fmtAgo, percent, deliveryMix } from '../lib/dashboard-format.js';
  import BarChart from '../lib/components/charts/BarChart.svelte';
  import AreaChart from '../lib/components/charts/AreaChart.svelte';

  let stats = $state(null);
  let sys = $state(null);
  let rel = $state(null);
  let org = $state(null);
  let storage = $state(null); // {pool, drives} with SMART + projection
  let watching = $state([]);
  let refreshError = $state('');
  let jobs = $state(null);          // background work (lib/dashboard-jobs.js on the server)
  let streaming = $state(null);     // playback history summary
  let streamDays = $state(30);
  let growth = $state(null);        // weekly additions, storage history, newest titles
  const driveWarnings = $derived(physicalDriveWarnings(sys?.disks || storage?.drives || []));

  // How a live stream is reaching the viewer. The cheap paths hand the file's
  // own video through untouched; the transcode paths rebuild every frame, so
  // seeing which one a session picked is the whole diagnostic value here.
  // Modifier classes are d-* rather than the page's .good/.warn/.bad, because
  // these are only ever applied dynamically. Svelte prunes scoped rules it
  // cannot see used in the markup, so a shared class survives only as long as
  // something else in this file happens to use it statically — the .ok rule
  // was silently dropped that way. The d-* rules below are :global on the
  // modifier for exactly this reason.
  const DELIVERY = {
    direct:            { label: 'direct',        cls: 'd-good', hint: 'Served straight off disk — no FFmpeg at all' },
    passthrough:       { label: 'passthrough',   cls: 'd-good', hint: 'HEVC copied to a client that can decode it — no re-encoding' },
    remux:             { label: 'remux',         cls: 'd-ok',   hint: 'Video copied, container and audio rebuilt' },
    'transcode-gpu':   { label: 'transcode',     cls: 'd-warn', hint: 'Re-encoding every frame on the GPU' },
    'transcode-cpu':   { label: 'transcode·cpu', cls: 'd-bad',  hint: 'Re-encoding on the CPU — no GPU acceleration in use' },
  };


  onMount(() => {
    let closed = false;
    const loop = createRefreshLoop({
      load: () => Promise.all([api.systemStats(), api.nowWatching()]),
      onData: ([system, viewers]) => { sys = system; watching = viewers; refreshError = ''; },
      onError: () => { refreshError = 'Live status could not refresh. Retrying shortly.'; },
      interval: () => 15000,
    });
    loop.refresh();
    Promise.allSettled([api.stats(), api.organizerStatus(), api.reliability(), api.storage()]).then(values => {
      if (closed) return;
      const value = i => values[i].status === 'fulfilled' ? values[i].value : null;
      stats = value(0); org = value(1); rel = value(2); storage = value(3);
    });
    const jobLoop = createRefreshLoop({
      load: () => api.dashboardJobs(), onData: value => { jobs = value; }, onError: () => {}, interval: () => 30000,
    });
    jobLoop.refresh();
    api.dashboardLibrary().then(value => { if (!closed) growth = value; }).catch(() => {});
    return () => { closed = true; loop.stop(); jobLoop.stop(); };
  });
  $effect(() => {
    const days = streamDays;
    let alive = true;
    api.dashboardStreaming(days).then(value => { if (alive) streaming = value; }).catch(() => {});
    return () => { alive = false; };
  });

  const mix = $derived(deliveryMix(streaming?.byDelivery));
  const SERIES = [{ key: 'films', label: 'Films', color: '#e8b04a' }, { key: 'episodes', label: 'Episodes', color: '#8fcf8a' },
    { key: 'audiobooks', label: 'Audiobooks', color: '#d98e73' }];
  const weekRows = $derived((growth?.weeks || []).map(w => ({ label: w.week.slice(5), values: w })));
  const weekTotal = $derived((growth?.weeks || []).reduce((n, w) => n + w.films + w.episodes + w.audiobooks, 0));
  const dayRows = $derived((streaming?.daily || []).map(d => ({ label: d.day.slice(5), values: { minutes: d.watchedMin } })));
  const storagePoints = $derived((growth?.storage || []).map(p => p.used));
  const storageMax = $derived(growth?.storage?.length ? growth.storage.at(-1).size : 1);
  // Start the scale just below the lowest point so a slow fill is visible, not a flat block.
  const storageMin = $derived(storagePoints.length ? Math.max(0, Math.min(...storagePoints) - storageMax * 0.05) : 0);
  const t = $derived(jobs?.transcription);
  const KIND = { movie: 'Film', show: 'Episode', audio: 'Audiobook' };

  // SMART verdict for a drive row: FAIL beats warnings beats OK.
  function smartBadge(s) {
    if (!s || !s.ok) return { label: 'no SMART', cls: 'dim' };
    if (s.passed === false) return { label: 'FAILING', cls: 'bad' };
    const warn = (s.reallocated || 0) + (s.pending || 0) + (s.uncorrectable || 0);
    if (warn > 0) return { label: `${warn} bad sectors`, cls: 'warn' };
    return { label: 'healthy', cls: 'good' };
  }

  const relChecks = $derived(rel?.checks ? Object.entries(rel.checks) : []);
  function checkLabel(k) {
    return { app: 'App', appService: 'App service', organizerService: 'Organizer service', dockerService: 'Docker (VPN + qBt)' }[k]
      || k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }
  // media/downloads are ARRAYS of per-folder results — aggregate them.
  // (Rendering c?.ok on an array read as "Failing" even when every folder
  // inside was fine.)
  // Restarting the app ends every stream, so it asks first. systemd brings the app back
  // (about 10 seconds); the page reloads once /api/health answers again.
  let restartState = $state('idle');
  let restartError = $state('');
  async function restartApp() {
    const streams = sys?.activeTranscodes || 0;
    const warning = streams ? `${streams} stream${streams > 1 ? 's are' : ' is'} playing right now and will stop. ` : '';
    if (!window.confirm(`${warning}Restart the app now? It is back in about 15 seconds.`)) return;
    restartError = '';
    restartState = 'restarting';
    const uptimeBefore = await currentUptime();
    try { await api.systemRestart(); }
    catch (e) { restartError = e.body?.error || 'Could not restart the app.'; restartState = 'idle'; return; }
    // Reload only once a health reading proves a new process; the old one answers at once.
    if (await waitForRestart({ uptimeBefore }) === 'restarted') { window.location.reload(); return; }
    restartError = 'The app did not restart. Give it a moment, then reload this page; if it is still the same process, restart it from a terminal.';
    restartState = 'idle';
  }
  function checkState(c) {
    if (Array.isArray(c)) {
      const bad = c.filter((e) => !e?.ok);
      return {
        ok: bad.length === 0,
        label: bad.length ? `${bad.length} of ${c.length} failing` : 'OK',
        detail: bad.map((e) => `${e.path}: ${(e.warnings || []).join('; ') || 'failing'}`).join('\n'),
      };
    }
    return { ok: !!c?.ok, label: c?.ok ? 'OK' : (c?.status || 'Failing'), detail: '' };
  }
</script>

<div class="page">
  <header>
    <h1 class="display">Dashboard</h1>
    <p class="sub">What the server is doing, how playback has been going, and how the library is growing.</p>
  </header>
  {#if refreshError}<p class="warn" role="status">{refreshError}</p>{/if}

  <h2 class="section">Right now</h2>
  <div class="cards">
    <section class="card wide">
      <h3 class="meta">Now watching</h3>
      {#if watching.length}
        {#each watching as w (w.profileName + w.id)}
          <div class="kv"><span>{w.profileName}</span>
            <strong>{w.title}{#if w.delivery}<span class="dmode {DELIVERY[w.delivery]?.cls ?? ''}"
              title={DELIVERY[w.delivery]?.hint ?? ''}>{DELIVERY[w.delivery]?.label ?? w.delivery}</span>{/if}</strong>
            <em>{w.percent ? `${Math.round(w.percent)}%` : ''}</em></div>
        {/each}
      {:else}
        <div class="dim">Nobody's watching right now.</div>
      {/if}
    </section>

    <section class="card">
      <h3 class="meta">System</h3>
      {#if sys}
        <div class="kv"><span>CPU</span><strong>{sys.cpu?.percent ?? '—'}%</strong> <em>load {sys.cpu?.loadAvg?.[0]?.toFixed(1)}</em></div>
        <div class="gauge"><span style={`width:${sys.cpu?.percent || 0}%`}></span></div>
        <div class="kv"><span>Memory</span><strong>{sys.memory?.percent}%</strong> <em>{fmtBytes(sys.memory?.used)} of {fmtBytes(sys.memory?.total)}</em></div>
        <div class="gauge"><span style={`width:${sys.memory?.percent || 0}%`}></span></div>
        <div class="kv"><span>Active streams</span><strong>{sys.activeTranscodes ?? 0}</strong></div>
      {:else}<div class="dim">…</div>{/if}
      <div class="actions">
        <button class="restart" onclick={restartApp} disabled={restartState === 'restarting'}>
          {restartState === 'restarting' ? 'Restarting…' : 'Restart app'}
        </button>
        {#if restartState === 'restarting'}<span class="dim" role="status">Back in about 15 seconds; this page reloads by itself.</span>{/if}
        {#if restartError}<span class="warn" role="alert">{restartError}</span>{/if}
      </div>
    </section>

    <section class="card">
      <h3 class="meta">Health</h3>
      <div class="kv"><span>Organizer</span>
        <strong class={org?.active ? 'good' : 'bad'}>{org ? (org.active ? 'Active' : 'Down') : '…'}</strong>
      </div>
      {#each relChecks as [key, c] (key)}
        {@const st = checkState(c)}
        <div class="kv" title={st.detail}><span>{checkLabel(key)}</span>
          <strong class={st.ok ? 'good' : 'bad'}>{st.label}</strong>
        </div>
      {/each}
      {#if rel && !rel.ok}<p class="warn">Something needs attention.</p>{/if}
    </section>
  </div>

  <h2 class="section">Background jobs</h2>
  <div class="cards jobs">
    <section class="card">
      <h3 class="meta">Audiobook read-along</h3>
      {#if t && !t.error}
        <div class="bignum">{t.booksDone}<span>of {t.booksTotal} books</span></div>
        <div class="gauge"><span style={`width:${percent(t.booksDone, t.booksTotal)}%`}></span></div>
        {#if t.current}
          <div class="kv"><span>Now</span><strong class="clip" title={t.current.title}>{t.current.title}</strong></div>
          <div class="kv"><span>Chapters</span><strong>{t.current.chaptersDone} of {t.current.chaptersTotal}</strong></div>
          <div class="gauge thin"><span style={`width:${percent(t.current.chaptersDone, t.current.chaptersTotal)}%`}></span></div>
        {/if}
        {#if t.next.length}<div class="kv"><span>Next</span><em class="clip">{t.next.join(' · ')}</em></div>{/if}
        <div class="kv"><span>Status</span><strong class={t.active ? 'good' : 'dim'}>{t.active ? 'Running' : t.booksDone === t.booksTotal ? 'Finished' : 'Stopped'}</strong></div>
      {:else}<div class="dim">{t?.error ? 'Unavailable' : '…'}</div>{/if}
    </section>

    <section class="card">
      <h3 class="meta">Collections lookup</h3>
      {#if jobs?.collections && !jobs.collections.error}
        <div class="bignum">{jobs.collections.inCollections.toLocaleString()}<span>films in a series</span></div>
        <div class="kv"><span>Films checked</span><strong>{jobs.collections.films.toLocaleString()}</strong></div>
        <div class="kv"><span>Last lookup</span><strong>{fmtAgo(jobs.collections.lastAskedAt)}</strong></div>
        <div class="kv"><span>Runs</span><em>daily, up to 600 films</em></div>
      {:else}<div class="dim">{jobs?.collections?.error ? 'Unavailable' : '…'}</div>{/if}
    </section>

    <section class="card">
      <h3 class="meta">Seek-bar thumbnails</h3>
      {#if jobs?.sprites && !jobs.sprites.error}
        {#if jobs.sprites.running}
          <div class="bignum">{jobs.sprites.completed.toLocaleString()}<span>of {jobs.sprites.total.toLocaleString()}</span></div>
          <div class="gauge"><span style={`width:${percent(jobs.sprites.completed, jobs.sprites.total)}%`}></span></div>
          <div class="kv"><span>Now</span><em class="clip">{jobs.sprites.current || '—'}</em></div>
        {:else}
          <div class="kv"><span>Status</span><strong class="good">{jobs.sprites.total ? 'All done' : 'Idle'}</strong></div>
        {/if}
        {#if !jobs.sprites.enabled}<div class="kv"><span>Paused</span><strong class="warn">by an admin</strong></div>{/if}
      {:else}<div class="dim">{jobs?.sprites?.error ? 'Unavailable' : '…'}</div>{/if}
    </section>

    <section class="card">
      <h3 class="meta">Data Saver copies</h3>
      {#if jobs?.dataSaver && !jobs.dataSaver.error}
        <div class="bignum">{jobs.dataSaver.copies}<span>audiobook copies</span></div>
        <div class="kv"><span>Disk used</span><strong>{fmtBytes(jobs.dataSaver.bytes)}</strong> <em>of 10 GB</em></div>
        <div class="kv"><span>Making now</span><strong>{jobs.dataSaver.running ? 'Yes' : 'No'}</strong>{#if jobs.dataSaver.queued} <em>{jobs.dataSaver.queued} waiting</em>{/if}</div>
      {:else}<div class="dim">{jobs?.dataSaver?.error ? 'Unavailable' : '…'}</div>{/if}
    </section>

    <section class="card">
      <h3 class="meta">Library scan</h3>
      {#if jobs?.libraryScan && !jobs.libraryScan.error}
        <div class="kv"><span>Status</span><strong class={jobs.libraryScan.running ? 'warn' : 'good'}>{jobs.libraryScan.running ? jobs.libraryScan.phase : 'Idle'}</strong></div>
        {#if jobs.libraryScan.enriching}<div class="kv"><span>Details</span><em>{jobs.libraryScan.enrichmentPhase}</em></div>{/if}
        <div class="kv"><span>Last full scan</span><strong>{fmtAgo(jobs.libraryScan.lastCompletedAt)}</strong></div>
        {#if jobs.libraryScan.error}<p class="warn">{jobs.libraryScan.error}</p>{/if}
      {:else}<div class="dim">{jobs?.libraryScan?.error ? 'Unavailable' : '…'}</div>{/if}
    </section>
  </div>

  <div class="section-head">
    <h2 class="section">Streaming</h2>
    <div class="seg" role="group" aria-label="Period">
      {#each [7, 30, 90] as d (d)}<button aria-pressed={streamDays === d} onclick={() => { streamDays = d; }}>{d} days</button>{/each}
    </div>
  </div>
  <div class="cards">
    {#if streaming && streaming.plays}
      <section class="card wide">
        <div class="tiles">
          <div class="tile"><strong>{streaming.plays}</strong><span>viewings</span></div>
          <div class="tile"><strong>{streaming.hoursWatched}</strong><span>hours watched</span></div>
          <div class="tile"><strong>{fmtDuration(streaming.startup.median)}</strong><span>typical start</span></div>
          <div class="tile" class:warnbox={streaming.rebufferRatio > 0.01}>
            <strong>{(streaming.rebufferRatio * 100).toFixed(1)}%</strong><span>time spent buffering</span>
          </div>
          <div class="tile" class:warnbox={streaming.failed > 0}><strong>{streaming.failed}</strong><span>failed starts</span></div>
        </div>
        <p class="note">{streaming.playsWithRebuffer} of {streaming.plays} viewings buffered at least once. Slowest starts: {fmtDuration(streaming.startup.p90)}.</p>
      </section>
      <section class="card">
        <h3 class="meta">How streams were delivered</h3>
        <div class="mixbar" role="img" aria-label={mix.map(m => `${m.label} ${m.pct}%`).join(', ')}>
          {#each mix as m (m.key)}<span class={`mx-${m.key}`} style={`width:${m.pct}%`}></span>{/each}
        </div>
        {#each mix as m (m.key)}
          <div class="kv"><span><i class={`dot mx-${m.key}`}></i>{m.label}</span><strong>{m.pct}%</strong> <em>{m.count}</em></div>
        {/each}
        <p class="note">Direct and passthrough are cheapest; encoded streams are rebuilt by the server.</p>
      </section>
      <section class="card">
        <h3 class="meta">Most buffering</h3>
        {#if streaming.worst.length}
          {#each streaming.worst as w (w.itemId)}
            <div class="kv"><span class="clip" title={w.title}>{w.title}</span><strong>{w.rebufferSec} s</strong> <em>{w.rebuffers}× in {w.plays} viewing{w.plays === 1 ? '' : 's'}</em></div>
          {/each}
        {:else}<div class="good">Nothing buffered in this period.</div>{/if}
      </section>
      <section class="card wide">
        <h3 class="meta">Minutes watched per day</h3>
        <BarChart data={dayRows} series={[{ key: 'minutes', label: 'Minutes', color: '#e8b04a' }]} labelEvery={streamDays > 30 ? 14 : 7}
                  summary={`Minutes watched per day over the last ${streamDays} days; ${streaming.hoursWatched} hours in total.`} />
      </section>
    {:else if streaming}
      <section class="card wide"><div class="dim">No viewings recorded in this period yet. The player reports each viewing when it closes.</div></section>
    {:else}<section class="card wide"><div class="dim">…</div></section>{/if}
  </div>

  <h2 class="section">Library &amp; storage</h2>
  <div class="cards">
    <section class="card">
      <h3 class="meta">Library</h3>
      {#if stats}
        <div class="bignum">{stats.totalFiles?.toLocaleString()}<span> files</span></div>
        <div class="kv"><span>Films</span><strong>{stats.movies}</strong></div>
        <div class="kv"><span>Series</span><strong>{stats.shows}</strong> <em>({stats.episodes?.toLocaleString()} episodes)</em></div>
        <div class="kv"><span>Total size</span><strong>{fmtBytes(stats.totalSize)}</strong></div>
      {:else}<div class="dim">…</div>{/if}
    </section>

    <section class="card">
      <h3 class="meta">Recently added</h3>
      {#each growth?.recent || [] as r (r.id)}
        <div class="kv"><span class="clip" title={r.title}>{r.title}</span><em>{KIND[r.kind] || ''} · {fmtAgo(r.addedAt)}</em></div>
      {:else}<div class="dim">…</div>{/each}
    </section>

    <section class="card wide">
      <h3 class="meta">Added per week <em class="hint">(by file date, last 26 weeks · {weekTotal.toLocaleString()} titles)</em></h3>
      {#if weekRows.length}
        <BarChart data={weekRows} series={SERIES} labelEvery={4} summary={`Titles added per week for the last 26 weeks: ${weekTotal} in total.`} />
      {:else}<div class="dim">…</div>{/if}
    </section>

    <section class="card wide">
      <h3 class="meta">Storage</h3>
      {#if (sys?.libraryScan || stats?.libraryScan)?.degraded}
        <p class="warn" role="status">Some library locations could not be read during the last scan. Existing titles have been kept. Check the storage connection before removing missing titles.</p>
      {/if}
      {#each driveWarnings as d (d.mount)}
        <p class="drive-warning" class:critical={d.percent >= 95} role="status">
          <strong>{d.label}: {d.percent}% full · {fmtBytes(d.available)} free.</strong>
          Downloads and conversions on this drive can run out of space even when the media pool has free space.
        </p>
      {/each}
      {#if storage?.pool}
        <div class="kv disk"><span>Media pool</span>
          <strong>{storage.pool.pct}%</strong>
          <em>{fmtBytes(storage.pool.avail)} free of {fmtBytes(storage.pool.size)}{storage.pool.projection ? ` · full in about ${Math.round(storage.pool.projection.daysLeft / 30)} months at the current rate` : ''}</em>
        </div>
        <div class="gauge" class:hot={storage.pool.pct >= 90}><span style={`width:${storage.pool.pct}%`}></span></div>
        {#if storagePoints.length > 1}
          <AreaChart points={storagePoints} min={storageMin} max={storageMax} topLabel={`${fmtBytes(storageMax)} (full)`} bottomLabel={fmtBytes(storageMin)}
                     firstLabel={growth.storage[0].day} lastLabel={growth.storage.at(-1).day}
                     summary={`Media pool space used from ${growth.storage[0].day} to ${growth.storage.at(-1).day}: ${fmtBytes(storagePoints[0])} to ${fmtBytes(storagePoints.at(-1))}.`} />
        {/if}
        {#each storage.drives as d (d.mount)}
          {@const badge = smartBadge(d.smart)}
          <div class="kv disk drive">
            <span title={d.mount}>{d.label}</span>
            <strong>{d.pct}%</strong>
            <em>{fmtBytes(d.avail)} free</em>
            <em class={badge.cls}>● {badge.label}</em>
            {#if d.smart?.tempC != null}<em class={d.smart.tempC >= 60 ? 'warn' : ''}>{d.smart.tempC}°C</em>{/if}
            {#if d.smart?.powerOnHours != null}<em>{Math.round(d.smart.powerOnHours / 24 / 365 * 10) / 10}y on</em>{/if}
          </div>
          <div class="gauge" class:hot={d.pct >= 95}><span style={`width:${d.pct}%`}></span></div>
        {/each}
      {:else if storage}
        <div class="dim">Storage info unavailable.</div>
      {:else}<div class="dim">…</div>{/if}
    </section>
  </div>
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1100px; margin: 0 auto; }
  header { margin-bottom: var(--s4); }
  .sub { color: var(--ink-soft); margin: var(--s1) 0 0; }
  .section { font-family: var(--font-display); font-weight: 400; font-size: 1.65rem; line-height: 1; margin: var(--s6) 0 var(--s3); }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; margin: var(--s6) 0 var(--s3); }
  .section-head .section { margin: 0; }
  .seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 99px; overflow: hidden; }
  .actions { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; margin-top: var(--s3); }
  .restart { font-size: 0.82rem; font-weight: 600; padding: 6px 14px; border-radius: var(--r-sm); border: 1px solid var(--line-strong); color: var(--ink); }
  .restart:hover:not(:disabled) { border-color: var(--ink); }
  .restart:disabled { opacity: 0.5; cursor: not-allowed; }
  .seg button { padding: 6px 14px; font-size: 0.82rem; font-weight: 600; color: var(--ink-soft); }
  .seg button[aria-pressed='true'] { background: var(--ink); color: var(--bg); }
  .card h3 { margin: 0 0 var(--s1); }
  .hint { font-style: normal; text-transform: none; letter-spacing: 0; color: var(--ink-faint); font-weight: 500; }
  .clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .kv strong.clip, .kv em.clip { flex: 1; }
  .gauge.thin { height: 3px; }
  .note { margin: var(--s1) 0 0; font-size: 0.82rem; color: var(--ink-faint); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: var(--s3); }
  .tile { display: flex; flex-direction: column; gap: 2px; padding: var(--s3); border-radius: var(--r-sm); background: rgba(243, 237, 228, 0.05); }
  .tile strong { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.01em; }
  .tile span { font-size: 0.8rem; color: var(--ink-soft); }
  .tile.warnbox strong { color: #ffb46b; }
  .mixbar { display: flex; height: 10px; border-radius: 99px; overflow: hidden; background: rgba(243, 237, 228, 0.08); margin-bottom: var(--s2); }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 8px; }
  :global(.mx-direct), :global(.mx-passthrough) { background: #7ed491; }
  :global(.mx-remux) { background: #e8b04a; }
  :global(.mx-transcode-gpu) { background: #d98e73; }
  :global(.mx-transcode-cpu) { background: #ff6b6b; }
  :global(.mx-unknown) { background: var(--ink-faint); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--s3); }
  .card {
    background: var(--bg-raised); border-radius: var(--r-md);
    padding: var(--s4); box-shadow: inset 0 0 0 1px var(--line);
    display: flex; flex-direction: column; gap: var(--s2);
  }
  .card.wide { grid-column: 1 / -1; }
  .bignum { font-size: 2rem; font-weight: 800; letter-spacing: -0.02em; }
  .bignum span { font-size: 0.95rem; font-weight: 500; color: var(--ink-soft); margin-left: 6px; }
  .kv { display: flex; align-items: baseline; gap: var(--s2); font-size: 0.92rem; }
  .kv span:first-child { color: var(--ink-soft); flex: 0 0 auto; min-width: 120px; }
  .kv.disk span:first-child { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kv em { font-style: normal; color: var(--ink-faint); font-size: 0.82rem; }
  .good { color: #7ed491 !important; }
  .bad { color: #ff6b6b !important; }
  .warn { color: #ffb46b !important; }
  .drive-warning { color: #ffb46b; padding: 12px; border: 1px solid currentColor; border-radius: var(--r-sm); font-size: 0.86rem; line-height: 1.5; }
  .drive-warning strong { display: block; }
  .drive-warning.critical { color: #ff6b6b; }
  /* Delivery badge on Now Watching. Outlined in currentColor so the colour
     comes entirely from the d-* modifier. Those are :global because they are
     applied dynamically and Svelte would otherwise prune them as unused. */
  .dmode {
    margin-left: 8px; padding: 0 6px;
    border: 1px solid currentColor; border-radius: 99px;
    font-size: 0.66rem; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; vertical-align: middle;
    white-space: nowrap; opacity: 0.85;
  }
  .dmode:global(.d-good) { color: #7ed491; }
  .dmode:global(.d-ok)   { color: var(--ink-soft); }
  .dmode:global(.d-warn) { color: #ffb46b; }
  .dmode:global(.d-bad)  { color: #ff6b6b; }
  .kv.drive { flex-wrap: wrap; }
  .kv.drive span:first-child { flex: 0 1 auto; max-width: 40%; }
  .dim { color: var(--ink-faint); }
  .gauge {
    height: 4px; background: rgba(243, 237, 228, 0.12);
    border-radius: 99px; overflow: hidden;
  }
  .gauge span { display: block; height: 100%; background: var(--ink-soft); }
  .gauge.hot span { background: #ff6b6b; }
  @media (max-width: 640px) {
    .kv span:first-child { min-width: 96px; }
    .kv.drive span:first-child { max-width: 100%; flex-basis: 100%; }
  }
</style>
