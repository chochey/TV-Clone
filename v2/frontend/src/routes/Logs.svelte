<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { fmtTime } from '../lib/player-core.js';

  const TABS = [
    { key: 'logs', label: 'Watch history' },
    { key: 'login-logs', label: 'Logins' },
    { key: 'stream-logs', label: 'Streams' },
    { key: 'scan-logs', label: 'Scans' },
    { key: 'error-logs', label: 'Errors' },
  ];
  let tab = $state('logs');
  let rows = $state(null);

  async function load() {
    rows = null;
    try { rows = await api.adminLogs(tab); } catch { rows = []; }
  }
  onMount(load);
  $effect(() => { tab; load(); });

  function when(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
</script>

<div class="page">
  <header><h1 class="display">Logs</h1></header>

  <div class="tabs" role="tablist">
    {#each TABS as t (t.key)}
      <button role="tab" aria-selected={tab === t.key} class:active={tab === t.key}
              onclick={() => { tab = t.key; }}>{t.label}</button>
    {/each}
  </div>

  {#if !rows}
    <div class="spinner"></div>
  {:else if !rows.length}
    <p class="empty">Nothing logged yet.</p>
  {:else}
    <div class="tablewrap">
      <table>
        <tbody>
          {#if tab === 'logs'}
            {#each rows.slice(0, 300) as r}
              <tr>
                <td class="dim">{when(r.timestamp)}</td>
                <td>{r.profileName}</td>
                <td class="grow">{r.title}</td>
                <td class="dim">{r.watched ? '✓ watched' : r.percent ? `${r.percent}%` : ''}</td>
              </tr>
            {/each}
          {:else if tab === 'login-logs'}
            {#each rows as r}
              <tr>
                <td class="dim">{when(r.timestamp)}</td>
                <td>{r.profileName || r.username || '—'}</td>
                <td class="grow dim">{r.ip}</td>
                <td class={r.success ? 'good' : 'bad'}>{r.success ? 'OK' : (r.reason || 'Failed')}</td>
              </tr>
            {/each}
          {:else if tab === 'stream-logs'}
            {#each rows as r}
              <tr>
                <td class="dim">{when(r.timestamp)}</td>
                <td>{r.profileName || '—'}</td>
                <td class="grow">{r.title}</td>
                <td class="dim">{r.mode}{r.codec ? ` · ${r.codec}` : ''} · {r.quality}{r.seekTime ? ` · from ${fmtTime(r.seekTime)}` : ''}</td>
              </tr>
            {/each}
          {:else if tab === 'scan-logs'}
            {#each rows as r}
              <tr>
                <td class="dim">{when(r.timestamp)}</td>
                <td>{r.count?.toLocaleString()} files</td>
                <td class="grow dim">{(r.durationMs / 1000).toFixed(1)}s</td>
                <td class="dim">{r.trigger}</td>
              </tr>
            {/each}
          {:else}
            {#each rows as r}
              <tr>
                <td class="dim">{when(r.timestamp)}</td>
                <td>{r.context}</td>
                <td class="grow bad">{r.message}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1100px; margin: 0 auto; }
  header { margin-bottom: var(--s4); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }

  .tabs { display: flex; gap: var(--s2); flex-wrap: wrap; margin-bottom: var(--s4); }
  .tabs button {
    padding: 8px 16px; border-radius: 99px;
    font-size: 0.88rem; font-weight: 600; color: var(--ink-soft);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .tabs button:hover { color: var(--ink); }
  .tabs button.active { background: var(--cta); color: var(--cta-ink); box-shadow: none; }

  .tablewrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  td { padding: 9px var(--s3) 9px 0; border-top: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
  td.grow { white-space: normal; width: 100%; }
  .dim { color: var(--ink-faint); }
  .good { color: #7ed491; }
  .bad { color: #ff6b6b; }
  .empty { color: var(--ink-faint); padding: var(--s5) 0; }
  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
