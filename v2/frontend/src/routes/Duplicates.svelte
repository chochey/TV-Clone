<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { loadLibrary, session } from '../lib/stores.js';

  let data = $state(null);      // {ok, groups, groupCount, totalWasted}
  let busy = $state({});        // itemId -> deleting flag
  let confirming = $state({});  // itemId -> armed for second click
  let error = $state('');

  async function refresh() {
    error = '';
    try { data = await api.duplicates(); } catch (e) { error = e.body?.error || 'Failed to load'; }
  }
  onMount(refresh);

  function fmtBytes(b) {
    if (b == null) return '—';
    if (b < 1e9) return (b / 1e6).toFixed(0) + ' MB';
    return (b / 1e9).toFixed(2) + ' GB';
  }

  // Two-click delete: first click arms, second click (within 4s) fires.
  async function del(copy) {
    if (!confirming[copy.id]) {
      confirming[copy.id] = true;
      setTimeout(() => { confirming[copy.id] = false; }, 4000);
      return;
    }
    confirming[copy.id] = false;
    busy[copy.id] = true;
    try {
      await api.deleteMedia(copy.id);
      await refresh();
      loadLibrary($session?.profileId).catch(() => {});
    } catch (e) {
      error = e.body?.error || 'Delete failed';
    } finally {
      busy[copy.id] = false;
    }
  }
</script>

<div class="page">
  <header>
    <h1 class="display">Duplicates</h1>
    {#if data?.ok}
      <span class="sub">{data.groupCount} title{data.groupCount === 1 ? '' : 's'} with extra copies · <strong>{fmtBytes(data.totalWasted)}</strong> reclaimable</span>
    {/if}
  </header>

  {#if error}<p class="err">{error}</p>{/if}

  {#if !data}
    <div class="spinner"></div>
  {:else if !data.groups.length}
    <p class="allclear">No duplicate copies found — every title exists exactly once.</p>
  {:else}
    {#each data.groups as g (g.key)}
      <section class="group">
        <h2>
          <span class="gtype">{g.type === 'movie' ? 'Film' : 'Episode'}</span>
          {g.title}
          <span class="gwaste">{fmtBytes(g.wasted)} reclaimable</span>
        </h2>
        {#each g.copies as c (c.id)}
          <div class="copy" class:keeper={c.largest}>
            <div class="cinfo">
              <span class="cname" title={c.filename}>{c.filename}</span>
              <span class="cmeta">
                {fmtBytes(c.fileSize)}
                {#if c.res} · {c.res}{/if}
                {#if c.codec} · {c.codec.toUpperCase()}{/if}
                · {c.folder}{c.relDir ? `/${c.relDir}` : ''}
                {#if c.largest} · <em class="best">largest copy</em>{/if}
              </span>
            </div>
            <button
              class="cdel" class:armed={confirming[c.id]}
              onclick={() => del(c)} disabled={busy[c.id]}
            >
              {busy[c.id] ? 'Deleting…' : confirming[c.id] ? 'Click again to delete' : 'Delete'}
            </button>
          </div>
        {/each}
      </section>
    {/each}
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1000px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: var(--s3); margin-bottom: var(--s5); flex-wrap: wrap; }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .sub { color: var(--ink-soft); font-size: 0.9rem; }
  .sub strong { color: var(--ink); }
  .err { color: #ff6b6b; margin-bottom: var(--s3); }
  .allclear { color: var(--ink-faint); }

  .group {
    background: var(--bg-raised); border: 1px solid var(--line);
    border-radius: var(--r-md); padding: var(--s4); margin-bottom: var(--s3);
  }
  .group h2 {
    font-size: 0.98rem; font-weight: 700; margin-bottom: var(--s3);
    display: flex; align-items: baseline; gap: var(--s2); flex-wrap: wrap;
  }
  .gtype {
    font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--ink-soft); background: rgba(242, 242, 244, 0.08);
    padding: 2px 8px; border-radius: 4px;
  }
  .gwaste { margin-left: auto; font-size: 0.78rem; font-weight: 600; color: #ffb46b; }

  .copy {
    display: flex; align-items: center; gap: var(--s3);
    padding: var(--s2) 0; border-top: 1px solid var(--line);
  }
  .copy:first-of-type { border-top: none; }
  .cinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .cname {
    font-family: ui-monospace, Menlo, monospace; font-size: 0.78rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .keeper .cname { color: #7ed491; }
  .cmeta { font-size: 0.75rem; color: var(--ink-faint); }
  .best { color: #7ed491; font-style: normal; font-weight: 600; }
  .cdel {
    flex: 0 0 auto; font-size: 0.8rem; font-weight: 600; color: #e5484d;
    padding: 6px 14px; border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px rgba(229, 72, 77, 0.4);
    transition: background var(--t-fast), color var(--t-fast);
  }
  .cdel:hover:not(:disabled), .cdel.armed { background: #e5484d; color: #fff; }
  .cdel:disabled { opacity: 0.5; }

  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
