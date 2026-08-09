<script>
  // Phase 1 of MEDIA_CONVERSION_PLAN.md is read-only: everything above the
  // pilot section reports what a full conversion run WOULD do, without
  // touching a file. The pilot section below is phase 2 — it runs the real
  // pipeline (remux, verify, atomic swap, retained original, watch-progress
  // migration) against ten specific hand-picked files, hardcoded in
  // server.js. It is not a general "convert N files" control.
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';

  let data = $state(null);        // { plan, config, disk, notYetProbed }
  let error = $state('');
  let includeImageSubs = $state(false);
  let saving = $state(false);
  let saveNote = $state('');

  let pilotBusy = $state(false);
  let pilotArmed = $state(false);
  let pilotResults = $state(null);
  let pilotError = $state('');

  let originals = $state(null);   // { items, totalBytes, expiredCount, keepOriginalsDays }
  let restoringPath = $state('');
  let restoreArmed = $state('');
  let originalsError = $state('');

  async function runPilot() {
    if (!pilotArmed) { pilotArmed = true; setTimeout(() => { pilotArmed = false; }, 5000); return; }
    pilotArmed = false;
    pilotBusy = true;
    pilotError = '';
    pilotResults = null;
    try {
      const res = await api.conversionPilotRun();
      pilotResults = res;
      await Promise.all([refresh(), loadOriginals()]);
    } catch (e) {
      pilotError = e.body?.error || 'Pilot run failed';
    } finally {
      pilotBusy = false;
    }
  }

  async function refresh() {
    error = '';
    try { data = await api.conversionPlan(includeImageSubs); }
    catch (e) { error = e.body?.error || 'Failed to load the conversion plan'; }
  }

  async function loadOriginals() {
    originalsError = '';
    try { originals = await api.conversionOriginals(); }
    catch (e) { originalsError = e.body?.error || 'Failed to load retained originals'; }
  }

  async function restore(item) {
    if (restoreArmed !== item.retainedPath) {
      restoreArmed = item.retainedPath;
      setTimeout(() => { if (restoreArmed === item.retainedPath) restoreArmed = ''; }, 5000);
      return;
    }
    restoreArmed = '';
    restoringPath = item.retainedPath;
    originalsError = '';
    try {
      await api.conversionRestore(item.retainedPath);
      await Promise.all([loadOriginals(), refresh()]);
    } catch (e) {
      originalsError = e.body?.error || 'Restore failed';
    } finally {
      restoringPath = '';
    }
  }

  onMount(() => { refresh(); loadOriginals(); });

  function fmtBytes(b) {
    if (b == null) return '—';
    const n = Math.abs(b);
    if (n < 1e9) return (b / 1e6).toFixed(0) + ' MB';
    if (n < 1e12) return (b / 1e9).toFixed(2) + ' GB';
    return (b / 1e12).toFixed(2) + ' TB';
  }

  async function saveConfig(patch) {
    if (!data) return;
    saving = true; saveNote = '';
    try {
      const res = await api.conversionConfigUpdate(patch);
      data = { ...data, config: res.config };
      saveNote = 'Saved';
    } catch (e) {
      saveNote = e.body?.error || 'Failed to save';
    } finally {
      saving = false;
      setTimeout(() => { saveNote = ''; }, 2500);
    }
  }

  function toggleTier(tier) {
    if (!data) return;
    const tiers = { ...data.config.tiers, [tier]: !data.config.tiers[tier] };
    saveConfig({ tiers });
  }

  // Numeric limits are committed on blur/change rather than per-keystroke, so
  // a half-typed "2" on the way to "20" is never persisted. The server clamps
  // every value regardless, and echoes back what it stored — that echo is what
  // the field then shows, so an out-of-range entry visibly snaps to the bound
  // instead of silently disagreeing with what the worker will actually use.
  function commitNumber(key, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) { saveNote = 'Not a number'; setTimeout(() => { saveNote = ''; }, 2000); return; }
    if (data.config[key] === Math.round(n)) return;      // nothing changed
    saveConfig({ [key]: n });
  }

  function commitSchedule(which, value) {
    const schedule = { ...data.config.schedule, [which]: value };
    saveConfig({ schedule });
  }

  function toggleEnabled() {
    if (!data) return;
    saveConfig({ enabled: !data.config.enabled });
  }
</script>

<div class="page">
  <header>
    <h1 class="display">Conversion</h1>
    <span class="sub">Phase 1 — read-only planner. Nothing on disk changes yet.</span>
  </header>

  {#if error}<p class="err">{error}</p>{/if}

  {#if !data}
    <div class="spinner"></div>
  {:else}
    <section class="card notice">
      <p>
        Everything above the pilot section is read-only — it reports what a
        full conversion run would do, computed live from your library, without
        touching a file. <strong>The pilot section further down is different:
        it is real</strong> — a one-time run against ten specific hand-picked
        files, with verification, atomic swaps, and a retained original. The
        general "convert everything" queue this page projects for is still a
        later phase.
      </p>
    </section>

    <section class="card">
      <div class="row spread">
        <div>
          <h2>Automatic conversion</h2>
          <p class="hint">
            Off, and inert — there is no scheduler yet, so nothing runs on its own
            regardless of this switch. The pilot below is the only thing that
            converts anything, and it only runs when you click it.
          </p>
        </div>
        <button class="toggle" class:on={data.config.enabled} onclick={toggleEnabled} disabled={saving}>
          {data.config.enabled ? 'On' : 'Off'}
        </button>
      </div>
    </section>

    <section class="card">
      <h2>What would convert, by tier</h2>

      <div class="tier">
        <div class="thead">
          <label class="tswitch">
            <input type="checkbox" checked={data.config.tiers.container} onchange={() => toggleTier('container')} disabled={saving} />
            <span class="tname">Container remux</span>
          </label>
          <span class="tcount">{data.plan.tiers.container.count} files · {fmtBytes(data.plan.tiers.container.bytes)}</span>
        </div>
        <p class="hint">H.264 video in the wrong container (usually .mkv). Copies every stream — no re-encoding, no quality change, no size change.</p>
        {#if data.plan.tiers.container.imageSubsCount}
          <p class="warn">
            {data.plan.tiers.container.imageSubsCount} file{data.plan.tiers.container.imageSubsCount === 1 ? '' : 's'}
            ({fmtBytes(data.plan.tiers.container.imageSubsBytes)}) excluded — image-based subtitles
            (PGS/VOBSUB) cannot survive a container change without OCR.
          </p>
        {/if}
      </div>

      <div class="tier">
        <div class="thead">
          <label class="tswitch">
            <input type="checkbox" checked={data.config.tiers.audio} onchange={() => toggleTier('audio')} disabled={saving} />
            <span class="tname">Add compatible audio</span>
          </label>
          <span class="tcount">{data.plan.tiers.audio.count} files · {fmtBytes(data.plan.tiers.audio.bytes)}</span>
        </div>
        <p class="hint">
          H.264 video with non-browser or surround-only audio. Adds a stereo AAC
          track alongside the original — the original is kept, never replaced.
          {data.plan.tiers.audio.breakdown.both.count} of these also need a container fix,
          done as part of the same job.
        </p>
        <p class="hint proj">
          Projected storage added: <strong>{fmtBytes(data.plan.tiers.audio.estimatedAddedBytes)}</strong>
          — estimated from this library's average runtime, not a guess per file.
        </p>
      </div>

      <div class="tier">
        <div class="thead">
          <label class="tswitch">
            <input type="checkbox" checked={data.config.tiers.legacy} onchange={() => toggleTier('legacy')} disabled={saving} />
            <span class="tname">Legacy codec upgrade</span>
          </label>
          <span class="tcount">{data.plan.tiers.legacy.count} files · {fmtBytes(data.plan.tiers.legacy.bytes)}</span>
        </div>
        <p class="hint">mpeg4 / msmpeg4v3 / vp8 / vp9 → H.264. A genuine re-encode, but from small, already-poor sources. Off by default.</p>
      </div>

      <label class="showsubs">
        <input type="checkbox" bind:checked={includeImageSubs} onchange={refresh} />
        Include image-subtitle files in the counts above (they would lose subtitles)
      </label>
      {#if saveNote}<span class="savenote">{saveNote}</span>{/if}
    </section>

    <section class="card">
      <h2>Disk impact</h2>
      {#if data.disk}
        <div class="kv"><span>Free space on /mnt/media</span><strong>{fmtBytes(data.disk.availBytes)}</strong></div>
        <div class="kv"><span>Worst-case retained originals</span><strong>{fmtBytes(data.disk.worstCaseRetainedBytes)}</strong>
          <em>if every eligible file converted inside one grace window</em></div>
        <div class="kv"><span>Retention budget (config)</span><strong>{data.config.retainedBudgetGB} GB</strong></div>
        {#if data.disk.exceedsFreeSpace}
          <p class="danger">Worst-case retention exceeds free disk space. A real run would need to pace itself well below this.</p>
        {:else if data.disk.exceedsBudget}
          <p class="warn">Worst-case retention exceeds the configured budget — the worker (once built) would pause and wait for originals to age out rather than run straight through.</p>
        {:else}
          <p class="ok">Worst-case retention fits within both free space and the configured budget.</p>
        {/if}
      {:else}
        <p class="hint">Disk info unavailable.</p>
      {/if}
      {#if data.notYetProbed}
        <p class="hint">{data.notYetProbed} file{data.notYetProbed === 1 ? '' : 's'} not yet probed — excluded from every count above until they are.</p>
      {/if}
    </section>

    <section class="card">
      <h2>Resource limits</h2>
      <p class="hint">
        Editable and saved immediately. Values are clamped server-side, so an
        out-of-range entry snaps to the nearest allowed bound rather than
        silently disagreeing with what the worker will actually use.
      </p>
      <div class="grid">
        <label class="field">
          <span>Concurrency <em>1–4</em></span>
          <input type="number" min="1" max="4" value={data.config.concurrency} disabled={saving}
                 onchange={(e) => commitNumber('concurrency', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>CPU niceness <em>0–19</em></span>
          <input type="number" min="0" max="19" value={data.config.niceness} disabled={saving}
                 onchange={(e) => commitNumber('niceness', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>FFmpeg threads <em>1–6</em></span>
          <input type="number" min="1" max="6" value={data.config.ffmpegThreads} disabled={saving}
                 onchange={(e) => commitNumber('ffmpegThreads', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Min free space <em>GB</em></span>
          <input type="number" min="10" max="5000" value={data.config.minFreeSpaceGB} disabled={saving}
                 onchange={(e) => commitNumber('minFreeSpaceGB', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Max files per run</span>
          <input type="number" min="1" max="2000" value={data.config.maxFilesPerRun} disabled={saving}
                 onchange={(e) => commitNumber('maxFilesPerRun', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Keep originals <em>days</em></span>
          <input type="number" min="1" max="90" value={data.config.keepOriginalsDays} disabled={saving}
                 onchange={(e) => commitNumber('keepOriginalsDays', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Retention budget <em>GB</em></span>
          <input type="number" min="10" max="10000" value={data.config.retainedBudgetGB} disabled={saving}
                 onchange={(e) => commitNumber('retainedBudgetGB', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Schedule start</span>
          <input type="time" value={data.config.schedule.start} disabled={saving}
                 onchange={(e) => commitSchedule('start', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Schedule end</span>
          <input type="time" value={data.config.schedule.end} disabled={saving}
                 onchange={(e) => commitSchedule('end', e.currentTarget.value)} />
        </label>
      </div>
      <label class="inlinecheck">
        <input type="checkbox" checked={data.config.pauseWhilePlaying} disabled={saving}
               onchange={() => saveConfig({ pauseWhilePlaying: !data.config.pauseWhilePlaying })} />
        Pause conversion whenever anyone is watching
      </label>
      <p class="hint">
        Both schedule fields empty means "anytime". Niceness 19 is the lowest
        priority — the worker yields to playback and to anything else on the box.
      </p>
    </section>

    <section class="card pilot">
      <h2>Phase 2 pilot — ten hand-picked files</h2>
      <p class="hint">
        Runs the real Tier 1 pipeline against ten specific TV episodes chosen for
        this test: a mix with and without embedded subtitles, none currently
        playing, and two that already carry real watch history on the Admin
        profile (both already marked watched) specifically to prove progress
        migration on genuine data. Each file is skipped — not touched — if it is
        streaming or corrupted when its turn comes. Originals are kept in a
        <code>.converted-originals</code> folder next to where they were, not deleted.
      </p>
      <button class="pilotbtn" class:armed={pilotArmed} onclick={runPilot} disabled={pilotBusy}>
        {pilotBusy ? 'Running…' : pilotArmed ? 'Click again to run for real' : 'Run Tier 1 pilot (10 files)'}
      </button>
      {#if pilotError}<p class="danger">{pilotError}</p>{/if}
      {#if pilotResults}
        <div class="pilotsummary">{pilotResults.succeeded} of {pilotResults.total} converted</div>
        <div class="pilotlist">
          {#each pilotResults.results as r}
            <div class="pilotrow" class:ok={r.ok} class:bad={!r.ok}>
              <span class="pfile">{r.filePath.split('/').pop()}</span>
              {#if r.ok}
                <span class="presult ok">converted{r.extractedSubs?.length ? ` · ${r.extractedSubs.length} sub file(s) extracted` : ''}{r.profilesMigrated?.length ? ' · progress migrated' : ''}</span>
              {:else}
                <span class="presult bad">{r.reason}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="card">
      <div class="row spread">
        <h2>Retained originals — the undo window</h2>
        {#if originals?.items?.length}
          <span class="tcount">{originals.items.length} file{originals.items.length === 1 ? '' : 's'} · {fmtBytes(originals.totalBytes)}</span>
        {/if}
      </div>
      <p class="hint">
        Every converted file's original is kept here for {data.config.keepOriginalsDays} days.
        Restoring puts the original back and moves watch progress with it.
        <strong>Nothing deletes these automatically yet</strong> — they stay until
        removed by hand, so the disk cost is real and visible rather than silent.
      </p>
      {#if originalsError}<p class="danger">{originalsError}</p>{/if}
      {#if !originals}
        <p class="hint">Loading…</p>
      {:else if !originals.items.length}
        <p class="hint">No retained originals — nothing has been converted yet.</p>
      {:else}
        <div class="pilotlist">
          {#each originals.items as o (o.retainedPath)}
            <div class="pilotrow">
              <span class="pfile">{o.name}</span>
              <span class="ometa">
                {fmtBytes(o.size)} · kept {o.ageDays}d
                {#if o.expired}<span class="warn">· past {originals.keepOriginalsDays}d</span>{/if}
              </span>
              {#if o.restorable}
                <button class="restorebtn" class:armed={restoreArmed === o.retainedPath}
                        onclick={() => restore(o)} disabled={restoringPath === o.retainedPath}>
                  {restoringPath === o.retainedPath ? 'Restoring…'
                    : restoreArmed === o.retainedPath ? 'Click again to restore' : 'Restore'}
                </button>
              {:else}
                <span class="presult bad" title="The converted file is no longer at its expected path">can't restore</span>
              {/if}
            </div>
          {/each}
        </div>
        <p class="hint">
          Restore leaves any extracted <code>.srt</code> sidecars in place — nothing
          records which of them this feature created versus which were already
          on disk, and deleting a file you supplied would be worse than leaving
          a duplicate subtitle option behind.
        </p>
      {/if}
    </section>

    <section class="card">
      <h2>What this does not do</h2>
      <ul class="dontlist">
        <li>Never re-encodes HEVC — passthrough already handles it for capable clients.</li>
        <li>Never re-encodes video that is already H.264 — only the container or audio changes.</li>
        <li>Never discards an audio track — the original is kept alongside the added one.</li>
        <li>Never deletes a source until its replacement has been verified and the original safely moved aside.</li>
      </ul>
    </section>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 900px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: var(--s3); margin-bottom: var(--s5); flex-wrap: wrap; }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .sub { color: var(--ink-soft); font-size: 0.9rem; }
  .err { color: #ff6b6b; margin-bottom: var(--s3); }

  .card {
    background: var(--bg-raised); border: 1px solid var(--line);
    border-radius: var(--r-md); padding: var(--s4); margin-bottom: var(--s3);
  }
  .card.notice { background: rgba(126, 212, 145, 0.06); border-color: rgba(126, 212, 145, 0.25); }
  .card.notice p { font-size: 0.88rem; line-height: 1.5; color: var(--ink-soft); }
  .card.notice strong { color: var(--ink); }

  .card.pilot { background: rgba(255, 180, 107, 0.05); border-color: rgba(255, 180, 107, 0.25); }
  .card.pilot code {
    font-family: ui-monospace, Menlo, monospace; font-size: 0.82em;
    background: rgba(242, 242, 244, 0.08); padding: 1px 5px; border-radius: 4px;
  }
  .pilotbtn {
    margin-top: var(--s3); font-size: 0.88rem; font-weight: 700; padding: 10px 20px;
    border-radius: var(--r-sm); background: rgba(255, 180, 107, 0.15); color: #ffb46b;
    box-shadow: inset 0 0 0 1px rgba(255, 180, 107, 0.4);
  }
  .pilotbtn.armed { background: #ffb46b; color: #1a1a1a; }
  .pilotbtn:disabled { opacity: 0.6; }
  .pilotsummary { margin-top: var(--s3); font-weight: 700; font-size: 0.9rem; }
  .pilotlist { display: flex; flex-direction: column; gap: 6px; margin-top: var(--s2); }
  .pilotrow {
    display: flex; align-items: baseline; justify-content: space-between; gap: var(--s3);
    padding: 8px 10px; border-radius: var(--r-sm); flex-wrap: wrap;
    background: rgba(242, 242, 244, 0.04);
    border-left: 3px solid transparent;
  }
  .pilotrow.ok { border-left-color: rgba(126, 212, 145, 0.5); }
  .pilotrow.bad { border-left-color: rgba(255, 107, 107, 0.5); }
  .pfile { font-family: ui-monospace, Menlo, monospace; font-size: 0.76rem; color: var(--ink-soft); }
  .presult { font-size: 0.78rem; font-weight: 600; }
  .presult.ok { color: #7ed491; }
  .presult.bad { color: #ff6b6b; }
  .card h2 { font-size: 1rem; font-weight: 700; margin-bottom: var(--s2); }

  .row { display: flex; align-items: center; }
  .row.spread { justify-content: space-between; gap: var(--s3); }

  .toggle {
    font-size: 0.85rem; font-weight: 700; padding: 8px 18px; border-radius: 99px;
    background: rgba(242, 242, 244, 0.08); color: var(--ink-soft);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .toggle.on { background: rgba(126, 212, 145, 0.15); color: #7ed491; box-shadow: inset 0 0 0 1px rgba(126, 212, 145, 0.4); }
  .toggle:disabled { opacity: 0.6; }

  .tier { padding: var(--s3) 0; border-top: 1px solid var(--line); }
  .tier:first-of-type { border-top: none; padding-top: 0; }
  .thead { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; }
  .tswitch { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .tswitch input { width: 16px; height: 16px; accent-color: #7ed491; }
  .tname { font-weight: 600; font-size: 0.94rem; }
  .tcount { font-size: 0.82rem; color: var(--ink-soft); }
  .hint { font-size: 0.82rem; color: var(--ink-faint); margin-top: 4px; line-height: 1.5; }
  .hint.proj strong { color: var(--ink); }
  .warn { font-size: 0.8rem; color: #ffb46b; margin-top: 6px; }
  .danger { font-size: 0.85rem; color: #ff6b6b; font-weight: 600; }
  .ok { font-size: 0.85rem; color: #7ed491; }

  .showsubs {
    display: flex; align-items: center; gap: 8px; margin-top: var(--s3);
    padding-top: var(--s3); border-top: 1px solid var(--line);
    font-size: 0.82rem; color: var(--ink-soft); cursor: pointer;
  }
  .savenote { display: block; margin-top: var(--s2); font-size: 0.78rem; color: #7ed491; }

  .kv { display: flex; align-items: baseline; gap: var(--s2); font-size: 0.9rem; margin-bottom: 6px; flex-wrap: wrap; }
  .kv span:first-child { color: var(--ink-soft); min-width: 220px; }
  .kv em { font-style: normal; color: var(--ink-faint); font-size: 0.78rem; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--s3); }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field span { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); }
  .field span em { font-style: normal; text-transform: none; letter-spacing: 0; opacity: 0.7; }
  .field input {
    background: rgba(242, 242, 244, 0.06); border: 1px solid var(--line);
    border-radius: var(--r-sm); padding: 7px 10px; color: var(--ink);
    font-size: 0.92rem; font-variant-numeric: tabular-nums; width: 100%;
  }
  .field input:focus { outline: none; border-color: var(--ink-soft); }
  .field input:disabled { opacity: 0.5; }
  .inlinecheck {
    display: flex; align-items: center; gap: 8px; cursor: pointer;
    margin-top: var(--s3); font-size: 0.86rem; color: var(--ink-soft);
  }
  .inlinecheck input { width: 16px; height: 16px; accent-color: #7ed491; }

  .ometa { font-size: 0.76rem; color: var(--ink-faint); margin-left: auto; }
  .ometa .warn { color: #ffb46b; }
  .restorebtn {
    flex: 0 0 auto; font-size: 0.78rem; font-weight: 600; color: var(--ink-soft);
    padding: 5px 12px; border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .restorebtn.armed { background: #ffb46b; color: #1a1a1a; box-shadow: none; }
  .restorebtn:disabled { opacity: 0.5; }

  .dontlist { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .dontlist li { font-size: 0.85rem; color: var(--ink-soft); padding-left: 18px; position: relative; }
  .dontlist li::before { content: '—'; position: absolute; left: 0; color: var(--ink-faint); }

  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
