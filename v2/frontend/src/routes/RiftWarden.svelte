<script>
  // Rift Warden (permission canRiftWarden): the launcher for Chochey's game. The version, notes and
  // launcher size come from the update server's latest.json (GET /api/riftwarden); the download is
  // GET /api/riftwarden/launcher, which the Logs page's "Saved files" records.
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { fmtBytes } from '../lib/dashboard-format.js';

  let info = $state(null);
  let failed = $state(false);

  onMount(async () => {
    try { info = await api.riftwarden(); } catch { failed = true; }
  });

  // latest.json dates are plain YYYY-MM-DD; read them as local dates, not UTC midnight.
  function day(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  }
</script>

<div class="page">
  <header>
    <span class="kicker">A game by Chochey</span>
    <h1 class="display">Rift Warden</h1>
    {#if info?.ok && (info.version || info.date)}
      <p class="sub">{info.version ? `Version ${info.version}` : ''}{info.version && info.date ? ' · ' : ''}{day(info.date)}</p>
    {/if}
  </header>

  {#if !info && !failed}
    <div class="spinner" aria-label="Loading"></div>
  {:else if failed || !info.ok}
    <p class="unavailable" role="status">The launcher isn't available right now. Try again later.</p>
  {:else}
    <section class="card">
      <a class="play" href="/api/riftwarden/launcher" download>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        Download the launcher{info.launcher.bytes ? ` · ${fmtBytes(info.launcher.bytes)}` : ''}
      </a>
      <p class="how">For Windows. Run {info.launcher.file} and it installs the game, then keeps it up to date by itself.</p>
      {#if info.notes}
        <h2 class="display">What's new</h2>
        <p class="notes">{info.notes}</p>
      {/if}
      {#if info.launcher.sha256}
        <details>
          <summary>File fingerprint</summary>
          <p class="hash">SHA-256 <code>{info.launcher.sha256}</code></p>
          <p class="hash">Your copy should match this. It comes from the same release folder as the file, so it confirms a
            complete, undamaged download, not who made the file.</p>
        </details>
      {/if}
    </section>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s6)) var(--gutter) var(--s7); max-width: 820px; margin: 0 auto; }
  header { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--s5); }
  .kicker { color: var(--accent); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
  h1 { font-size: clamp(2.4rem, 6vw, 4rem); line-height: 1; }
  .sub { color: var(--ink-soft); font-size: 0.95rem; }
  .card {
    display: flex; flex-direction: column; align-items: flex-start; gap: var(--s3);
    padding: var(--s5); border-radius: var(--r-md);
    background: var(--bg-raised); box-shadow: inset 0 0 0 1px var(--line);
  }
  .play {
    display: inline-flex; align-items: center; gap: 10px;
    background: var(--accent); color: var(--accent-ink);
    font-weight: 700; font-size: 1rem; min-height: 50px; padding: 0 26px 0 22px;
    border-radius: var(--r-pill); transition: filter var(--t-fast);
  }
  .play:hover { filter: brightness(1.07); }
  .how { color: var(--ink-soft); font-size: 0.9rem; line-height: 1.5; }
  h2 { font-size: 1.5rem; margin-top: var(--s3); }
  .notes { color: var(--ink); line-height: 1.6; max-width: 62ch; }
  details { color: var(--ink-faint); font-size: 0.82rem; }
  summary { cursor: pointer; }
  .hash { margin-top: 6px; overflow-wrap: anywhere; }
  code { font-size: 0.78rem; color: var(--ink-soft); }
  .unavailable { color: var(--ink-soft); }
  @media (max-width: 720px) {
    .card { padding: var(--s4); }
    .play { width: 100%; justify-content: center; }
  }
</style>
