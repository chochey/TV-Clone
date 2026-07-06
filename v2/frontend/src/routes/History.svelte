<script>
  import { onMount } from 'svelte';
  import { api, posterUrl } from '../lib/api.js';
  import { library, session } from '../lib/stores.js';
  import { navigate } from '../lib/router.js';
  import { fmtTime } from '../lib/player-core.js';

  let entries = $state(null); // [{id, timestamp, title}]

  onMount(async () => {
    try { entries = await api.history($session?.profileId); } catch { entries = []; }
  });

  // Join with the loaded library for art + live progress.
  const rows = $derived.by(() => {
    if (!entries) return null;
    const byId = new Map($library.map((i) => [i.id, i]));
    return entries.map((e) => ({ ...e, item: byId.get(e.id) || null }));
  });

  function when(ts) {
    const d = new Date(ts);
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days === 0) return 'Today · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString();
  }
</script>

<div class="page">
  <header><h1 class="display">History</h1>{#if rows}<span class="count meta">{rows.length}</span>{/if}</header>

  {#if !rows}
    <div class="spinner"></div>
  {:else if !rows.length}
    <p class="empty">Nothing watched yet.</p>
  {:else}
    <div class="list">
      {#each rows as r (r.id + r.timestamp)}
        {@const pct = r.item?.progress?.percent || 0}
        <div class="row" role="button" tabindex="0"
             onclick={() => r.item && navigate(`/title/${encodeURIComponent(r.id)}`)}
             onkeydown={(e) => (e.key === 'Enter') && r.item && navigate(`/title/${encodeURIComponent(r.id)}`)}>
          <div class="thumb">
            {#if r.item && posterUrl(r.item)}
              <img src={posterUrl(r.item)} alt="" loading="lazy" />
            {:else}
              <div class="ph"></div>
            {/if}
          </div>
          <div class="text">
            <span class="t">{(r.item?.showName || r.item?.title || r.title || r.id).replace(/^\(auto\)\s*/i, '')}</span>
            <span class="w meta">{when(r.timestamp)}</span>
            {#if pct > 0 && pct < 95}
              <span class="bar"><span style={`width:${pct}%`}></span></span>
              <span class="left">{r.item?.progress?.duration ? fmtTime(r.item.progress.duration - r.item.progress.currentTime) + ' left' : ''}</span>
            {:else if r.item?.watched || pct >= 95}
              <span class="done meta">✓ Watched</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 900px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: var(--s3); margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: var(--ink-faint); padding: var(--s6) 0; }

  .list { display: flex; flex-direction: column; }
  .row {
    display: flex; gap: var(--s4); align-items: center;
    padding: var(--s3); margin: 0 calc(-1 * var(--s3));
    border-top: 1px solid var(--line); border-radius: var(--r-sm);
    cursor: pointer; transition: background var(--t-fast);
  }
  .row:hover { background: rgba(242, 242, 244, 0.06); }
  .thumb { flex: 0 0 52px; }
  .thumb img, .thumb .ph {
    width: 52px; aspect-ratio: 2/3; object-fit: cover;
    border-radius: 4px; background: var(--bg-raised);
  }
  .text { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar {
    display: block; height: 3px; max-width: 220px;
    background: rgba(242, 242, 244, 0.16); border-radius: 99px; overflow: hidden;
  }
  .bar span { display: block; height: 100%; background: var(--ink); }
  .left { font-size: 0.75rem; color: var(--ink-faint); }
  .done { color: var(--ink-soft); }
</style>
