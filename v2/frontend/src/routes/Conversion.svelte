<script>
  // Phase 1 of MEDIA_CONVERSION_PLAN.md: read-only. This page reports what a
  // conversion run WOULD do — nothing here mutates a file. There is no
  // Start button because there is nothing to start yet.
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';

  let data = $state(null);        // { plan, config, disk, notYetProbed }
  let error = $state('');
  let includeImageSubs = $state(false);
  let saving = $state(false);
  let saveNote = $state('');

  async function refresh() {
    error = '';
    try { data = await api.conversionPlan(includeImageSubs); }
    catch (e) { error = e.body?.error || 'Failed to load the conversion plan'; }
  }
  onMount(refresh);

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
        This page shows what a future conversion run would do, computed live from
        your library right now. <strong>No file is touched by anything on this
        page.</strong> The actual conversion worker — with verification, atomic
        swaps, and an undo window — is a later phase.
      </p>
    </section>

    <section class="card">
      <div class="row spread">
        <div>
          <h2>Feature switch</h2>
          <p class="hint">Off by default. Turning this on does nothing yet in phase 1 — it is the switch the real worker will read once built.</p>
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
      <p class="hint">These are the controls the real worker will obey once built — concurrency, priority, and a night window so conversion never competes with playback.</p>
      <div class="grid">
        <div class="field"><span>Concurrency</span><strong>{data.config.concurrency}</strong></div>
        <div class="field"><span>CPU niceness</span><strong>{data.config.niceness}</strong></div>
        <div class="field"><span>FFmpeg threads</span><strong>{data.config.ffmpegThreads}</strong></div>
        <div class="field"><span>Pause while playing</span><strong>{data.config.pauseWhilePlaying ? 'Yes' : 'No'}</strong></div>
        <div class="field"><span>Schedule window</span>
          <strong>{data.config.schedule.start && data.config.schedule.end ? `${data.config.schedule.start}–${data.config.schedule.end}` : 'Anytime'}</strong></div>
        <div class="field"><span>Min free space</span><strong>{data.config.minFreeSpaceGB} GB</strong></div>
        <div class="field"><span>Max files per run</span><strong>{data.config.maxFilesPerRun}</strong></div>
        <div class="field"><span>Keep originals</span><strong>{data.config.keepOriginalsDays} days</strong></div>
      </div>
    </section>

    <section class="card">
      <h2>What this does not do</h2>
      <ul class="dontlist">
        <li>Never re-encodes HEVC — passthrough already handles it for capable clients.</li>
        <li>Never re-encodes video that is already H.264 — only the container or audio changes.</li>
        <li>Never discards an audio track — the original is kept alongside the added one.</li>
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
  .field { display: flex; flex-direction: column; gap: 2px; }
  .field span { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); }
  .field strong { font-size: 0.95rem; }

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
