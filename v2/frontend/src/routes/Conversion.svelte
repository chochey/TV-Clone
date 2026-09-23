<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api.js';

  let data = $state(null);        // { plan, config, disk, notYetProbed }
  let error = $state('');
  let includeImageSubs = $state(false);
  let saving = $state(false);
  let saveNote = $state('');

  let queue = $state(null);       // live snapshot from /api/conversion/status
  let queueBusy = $state(false);
  let startArmed = $state(false);
  let queueError = $state('');
  let poll = null, statusLoading = false, closed = false;

  let cleanupPreview = $state(null);
  let cleanupBusy = $state(false);
  let cleanupArmed = $state(false);
  let cleanupError = $state('');
  let cleanupDone = $state('');

  const isActive = $derived(queue?.status === 'running' || queue?.status === 'paused' || queue?.status === 'stopping');
  const pct = $derived(queue?.total ? Math.round((queue.done / queue.total) * 100) : 0);

  async function loadStatus() {
    if (statusLoading || closed) return;
    statusLoading = true;
    try {
      const next = await api.conversionStatus();
      if (closed) return;
      const finished = queue?.status !== 'idle' && next.status === 'idle';
      queue = next;
      if (finished) { refresh(); loadOriginals(); }
    } catch (e) { queueError = e.body?.error || 'Failed to read queue status'; }
    finally { statusLoading = false; }
  }

  // Poll only while something is happening. A finished queue does not need a
  // request every two seconds for the rest of the session.
  function syncPolling() {
    const shouldPoll = isActive;
    if (shouldPoll && !poll) poll = setInterval(loadStatus, 2000);
    if (!shouldPoll && poll) { clearInterval(poll); poll = null; }
  }
  $effect(syncPolling);

  async function queueAction(fn, { arm = false } = {}) {
    if (arm && !startArmed) { startArmed = true; setTimeout(() => { startArmed = false; }, 5000); return; }
    startArmed = false;
    queueBusy = true; queueError = '';
    try {
      queue = await fn();
      await Promise.all([refresh(), loadOriginals()]);
    } catch (e) {
      queueError = e.body?.error || 'Action failed';
    } finally {
      queueBusy = false;
      loadStatus();
    }
  }

  async function previewCleanup() {
    cleanupBusy = true; cleanupError = ''; cleanupDone = '';
    try { cleanupPreview = await api.conversionCleanup(true); }
    catch (e) { cleanupError = e.body?.error || 'Cleanup preview failed'; }
    finally { cleanupBusy = false; }
  }

  async function runCleanup() {
    if (!cleanupArmed) { cleanupArmed = true; setTimeout(() => { cleanupArmed = false; }, 5000); return; }
    cleanupArmed = false;
    cleanupBusy = true; cleanupError = '';
    try {
      const r = await api.conversionCleanup(false);
      cleanupDone = `Deleted ${r.deleted.length} file(s), freed ${fmtBytes(r.bytes)}`;
      cleanupPreview = null;
      await loadOriginals();
    } catch (e) {
      cleanupError = e.body?.error || 'Cleanup failed';
    } finally { cleanupBusy = false; }
  }

  let originals = $state(null);   // { items, totalBytes, expiredCount, keepOriginalsDays }
  let restoringPath = $state('');
  let restoreArmed = $state('');
  let originalsError = $state('');

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

  onMount(() => { refresh(); loadOriginals(); loadStatus(); });
  onDestroy(() => { closed = true; if (poll) clearInterval(poll); });

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
      await refresh();
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
    <span class="sub">Make your library easier to play in Firefox and Chrome.</span>
  </header>

  {#if error}<p class="err">{error}</p>{/if}

  {#if !data}
    <div class="spinner"></div>
  {:else}
    <section class="card notice">
      <h2>Browser compatibility preset</h2>
      <p>MP4 · H.264 video · AAC stereo (192 kbps). Compatible video is copied without quality loss.
        Other selected SDR video is re-encoded at its original resolution. Re-encoding can increase file size and changes picture quality.</p>
      <p>Extra audio languages and surround tracks are retained where MP4 supports them; otherwise they are converted to AAC.
        Text subtitles become separate subtitle files. HDR, Dolby Vision and image subtitles are left for review.</p>
      <button class="qbtn" disabled={saving || isActive} onclick={() => saveConfig({tiers:{container:true,audio:true,legacy:true,video:true},cpuCores:2,videoCrf:20,niceness:19,pauseWhilePlaying:true})}>Use recommended settings</button>
      <p class="hint">This saves settings only. Enable conversion and press Start when you are ready.</p>
    </section>

    <section class="card">
      <div class="row spread">
        <div>
          <h2>Enable conversion</h2>
          <p class="hint">
            Enables the Start button. Conversion never starts just because this is switched on,
            and it stays stopped after a server restart. Turning it off pauses an active job.
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
        <p class="hint">H.264 video in the wrong container (usually .mkv). Copies compatible video unchanged and places browser-friendly stereo audio first.</p>
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
          track first, while keeping additional audio tracks and retaining the original file.
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
        <p class="hint">mpeg4 / msmpeg4v3 / vp8 / vp9 → H.264. Re-encodes video for browser compatibility. Original resolution is preserved.</p>
      </div>

      <div class="tier">
        <div class="thead">
          <label class="tswitch"><input type="checkbox" checked={data.config.tiers.video} onchange={() => toggleTier('video')} disabled={saving} /><span class="tname">HEVC, AV1 and 10-bit H.264 video</span></label>
          <span class="tcount">{data.plan.tiers.video.count} candidates · {fmtBytes(data.plan.tiers.video.bytes)}</span>
        </div>
        <p class="hint">Converts SDR video to 8-bit H.264 for Firefox. Often produces larger files. HDR is checked before encoding and skipped.</p>
      </div>
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
          <p class="warn">Worst-case retention exceeds the configured budget — the queue waits when its retention budget is reached. Review and clean up old originals manually to free space.</p>
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
          <span>CPU cores allocated <em>1–{data.hardware?.cpuCores || 6}</em></span>
          <input type="number" min="1" max={data.hardware?.cpuCores || 6} value={data.config.cpuCores} disabled={saving} onchange={(e) => commitNumber('cpuCores', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Picture quality</span>
          <select value={data.config.videoCrf} disabled={saving || isActive} onchange={(e) => commitNumber('videoCrf', e.currentTarget.value)}>
            <option value="18">Higher quality · larger files</option><option value="20">Balanced · recommended</option><option value="23">Smaller files</option>
          </select>
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
      <button class="qbtn" disabled={saving} onclick={() => saveConfig({schedule:{start:'',end:''}})}>Run anytime</button>
      <label class="inlinecheck">
        <input type="checkbox" checked={data.config.pauseWhilePlaying} disabled={saving}
               onchange={() => saveConfig({ pauseWhilePlaying: !data.config.pauseWhilePlaying })} />
        Pause conversion whenever anyone is watching
      </label>
      <p class="hint">
        One file runs at a time with low disk priority. CPU allocation applies to all conversion and verification threads,
        including the current job. Two of six cores allows up to roughly one-third of this machine's CPU capacity; it does not reserve those cores exclusively.
      </p>
    </section>

    <section class="card pilot">
      <div class="row spread">
        <h2>Conversion queue</h2>
        {#if queue}
          <span class="qstatus {queue.status}">{queue.status}</span>
        {/if}
      </div>
      <p class="hint">
        Converts the selected categories, smallest files first. Each output is checked before replacement.
        Original files are retained for recovery; cleanup is always manual. A server restart stops the queue;
        Start rebuilds the list and skips files already compatible.
      </p>

      {#if queueError}<p class="danger">{queueError}</p>{/if}

      {#if queue && queue.total > 0}
        <div class="progwrap">
          <div class="progbar"><span style="width:{pct}%"></span></div>
          <div class="progmeta">
            <strong>{queue.done} / {queue.total}</strong>
            <span>{queue.converted} converted · {queue.failed} skipped</span>
            {#if queue.bytesBefore > 0}
              <span>{fmtBytes(queue.bytesBefore)} → {fmtBytes(queue.bytesAfter)}</span>
            {/if}
          </div>
          {#if queue.current}
            <div class="curfile">{queue.progress?.stage || 'Working on'} <code>{queue.current}</code></div>
            {#if queue.progress?.duration > 0 && queue.progress.stage === 'Converting'}
              <div class="progbar"><span style="width:{Math.min(100,queue.progress.seconds / queue.progress.duration * 100)}%"></span></div>
              <p class="hint">{Math.min(100,Math.round(queue.progress.seconds / queue.progress.duration * 100))}% of this file · {queue.progress.speed || 'measuring speed…'}</p>
            {/if}
          {/if}
          {#if queue.waitingReason}
            <div class="waiting">Paused automatically — {queue.waitingReason}. Resumes on its own.</div>
          {/if}
        </div>
      {/if}

      <div class="qcontrols">
        {#if queue?.status === 'running'}
          <button class="qbtn" onclick={() => queueAction(api.conversionPause)} disabled={queueBusy}>Pause</button>
          <button class="qbtn stop" onclick={() => queueAction(api.conversionStop)} disabled={queueBusy}>Stop</button>
        {:else if queue?.status === 'paused'}
          <button class="qbtn go" onclick={() => queueAction(api.conversionResume)} disabled={queueBusy}>Resume</button>
          <button class="qbtn stop" onclick={() => queueAction(api.conversionStop)} disabled={queueBusy}>Stop</button>
        {:else if queue?.status === 'stopping'}
          <button class="qbtn" disabled>Stopping…</button>
        {:else}
          <button class="qbtn go" class:armed={startArmed}
                  onclick={() => queueAction(api.conversionStart, { arm: true })} disabled={queueBusy || saving || !data.config.enabled}>
            {startArmed ? 'Click again to start converting' : `Start (${data.eligibleSelected} candidates)`}
          </button>
        {/if}
      </div>
      <p class="hint">
        Pause suspends the current job and Resume continues it. Stop cancels the job and removes its temporary output,
        leaving the original intact. A run is capped at {data.config.maxFilesPerRun} files
        (<em>Max files per run</em> above); start it again for the next batch.
      </p>

      {#if queue?.results?.length}
        <div class="pilotlist">
          {#each queue.results as r (r.name + r.at)}
            <div class="pilotrow" class:ok={r.ok} class:bad={!r.ok}>
              <span class="pfile">{r.name}</span>
              <span class="presult {r.ok ? 'ok' : 'bad'}">{r.ok ? 'converted' : r.reason}</span>
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
        <strong>Nothing is ever deleted on a timer</strong> — cleanup only runs
        when you click it below, and it previews first.
      </p>
      {#if originalsError}<p class="danger">{originalsError}</p>{/if}

      <div class="cleanupbar">
        <button class="qbtn" onclick={previewCleanup} disabled={cleanupBusy}>
          {cleanupBusy && !cleanupPreview ? 'Checking…' : 'Check for expired originals'}
        </button>
        {#if cleanupPreview}
          {#if cleanupPreview.candidates > 0}
            <button class="qbtn danger" class:armed={cleanupArmed} onclick={runCleanup} disabled={cleanupBusy}>
              {cleanupArmed
                ? `Click again to delete ${cleanupPreview.candidates} file(s)`
                : `Delete ${cleanupPreview.candidates} expired · free ${fmtBytes(cleanupPreview.bytes)}`}
            </button>
          {:else}
            <span class="hint">Nothing is past {originals?.keepOriginalsDays ?? data.config.keepOriginalsDays} days yet.</span>
          {/if}
        {/if}
      </div>
      {#if cleanupError}<p class="danger">{cleanupError}</p>{/if}
      {#if cleanupDone}<p class="ok">{cleanupDone}</p>{/if}
      {#if cleanupPreview?.skippedOnlyCopy?.length}
        <p class="warn">
          {cleanupPreview.skippedOnlyCopy.length} expired original(s) will NOT be
          deleted — their converted replacement is missing, so the retained copy
          is the only one left. Restore or investigate those instead.
        </p>
      {/if}
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
        <li>Leaves HDR, Dolby Vision, image subtitles, and unusual video layouts for review.</li>
        <li>Copies compatible 8-bit H.264 video unchanged; other selected SDR video is converted.</li>
        <li>Keeps additional audio tracks, converting unsupported audio formats to AAC.</li>
        <li>Retains the original for recovery after checking the replacement. Cleanup requires your action.</li>
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
  .qstatus {
    font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 3px 10px; border-radius: 99px; border: 1px solid currentColor; color: var(--ink-faint);
  }
  .qstatus.running { color: #7ed491; }
  .qstatus.paused { color: #ffb46b; }
  .qstatus.stopping { color: #ff6b6b; }

  .qcontrols { display: flex; gap: var(--s2); flex-wrap: wrap; margin-top: var(--s3); }
  .qbtn {
    font-size: 0.86rem; font-weight: 700; padding: 9px 18px; border-radius: var(--r-sm);
    color: var(--ink-soft); box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .qbtn.go { color: #7ed491; box-shadow: inset 0 0 0 1px rgba(126, 212, 145, 0.45); }
  .qbtn.go.armed { background: #7ed491; color: #10231a; box-shadow: none; }
  .qbtn.stop { color: #ff6b6b; box-shadow: inset 0 0 0 1px rgba(255, 107, 107, 0.45); }
  .qbtn.danger { color: #ff6b6b; box-shadow: inset 0 0 0 1px rgba(255, 107, 107, 0.45); }
  .qbtn.danger.armed { background: #e5484d; color: #fff; box-shadow: none; }
  .qbtn:disabled { opacity: 0.5; }

  .progwrap { margin-top: var(--s3); }
  .progbar {
    height: 6px; background: rgba(242, 242, 244, 0.1); border-radius: 99px; overflow: hidden;
  }
  .progbar span {
    display: block; height: 100%; background: #7ed491;
    transition: width var(--t-med, 0.3s) ease;
  }
  .progmeta {
    display: flex; gap: var(--s3); flex-wrap: wrap; align-items: baseline;
    margin-top: 6px; font-size: 0.8rem; color: var(--ink-faint);
  }
  .progmeta strong { color: var(--ink); font-size: 0.9rem; font-variant-numeric: tabular-nums; }
  .curfile { margin-top: 6px; font-size: 0.8rem; color: var(--ink-soft); }
  .curfile code { font-family: ui-monospace, Menlo, monospace; font-size: 0.95em; }
  .waiting {
    margin-top: 6px; font-size: 0.8rem; color: #ffb46b;
  }
  .cleanupbar { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; margin: var(--s3) 0; }
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
