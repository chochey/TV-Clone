<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { navigate } from '../lib/router.js';

  let data = $state(null); // {ok, isAdmin, requests}
  let title = $state('');
  let type = $state('movie');
  let note = $state('');
  let busy = $state(false);
  let msg = $state('');
  let err = $state('');

  async function refresh() {
    try { data = await api.requests(); } catch { data = { requests: [] }; }
  }
  onMount(refresh);

  async function submit(e) {
    e.preventDefault();
    if (busy || !title.trim()) return;
    busy = true; msg = ''; err = '';
    try {
      await api.requestCreate(title.trim(), type, note.trim() || undefined);
      msg = `Requested “${title.trim()}”.`;
      title = ''; note = '';
      await refresh();
    } catch (e2) {
      if (e2.body?.code === 'available' && e2.body.itemId) {
        navigate(`/title/${encodeURIComponent(e2.body.itemId)}`);
        return;
      }
      err = e2.body?.error || 'Could not submit the request.';
    } finally { busy = false; }
  }

  async function setStatus(r, status) {
    try { await api.requestSetStatus(r.id, status); await refresh(); } catch {}
  }
  async function remove(r) {
    try { await api.requestRemove(r.id); await refresh(); } catch {}
  }

  const STATUS_LABEL = { pending: 'Pending', downloading: 'Downloading', fulfilled: 'Fulfilled', declined: 'Declined' };
  function when(ts) { return new Date(ts).toLocaleDateString(); }
</script>

<div class="page">
  <header><h1 class="display">Requests</h1></header>

  <form class="new" onsubmit={submit}>
    <input type="text" placeholder="Title — e.g. Blade Runner 2049" bind:value={title} />
    <select bind:value={type} aria-label="Type">
      <option value="movie">Film</option>
      <option value="show">Series</option>
      <option value="unknown">Not sure</option>
    </select>
    <input class="note" type="text" placeholder="Note (optional)" bind:value={note} />
    <button class="cta" type="submit" disabled={busy || !title.trim()}>{busy ? 'Sending…' : 'Request'}</button>
  </form>
  {#if msg}<p class="ok">{msg}</p>{/if}
  {#if err}<p class="err">{err}</p>{/if}

  {#if !data}
    <div class="spinner"></div>
  {:else if !data.requests?.length}
    <p class="empty">No requests yet — ask for something above.</p>
  {:else}
    <div class="list">
      {#each data.requests as r (r.id)}
        <div class="row">
          {#if r.omdb?.posterUrl || r.posterUrl}
            <img class="thumb" src={r.omdb?.posterUrl || r.posterUrl} alt="" loading="lazy"
                 onerror={(e) => { e.target.style.display = 'none'; }} />
          {:else}
            <div class="thumb ph"></div>
          {/if}
          <div class="text">
            <span class="t">{r.omdb?.title || r.title}{(r.omdb?.year || r.year) ? ` (${r.omdb?.year || r.year})` : ''}</span>
            <span class="meta sub">
              {r.type === 'show' ? 'Series' : r.type === 'movie' ? 'Film' : 'Unknown'}
              · {r.profileName || 'someone'} · {when(r.createdAt)}
              {#if r.note}· “{r.note}”{/if}
            </span>
          </div>
          <span class={`status ${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span>
          {#if data.isAdmin}
            <div class="actions">
              {#if r.status === 'pending'}
                <button onclick={() => setStatus(r, 'downloading')}>Downloading</button>
                <button onclick={() => setStatus(r, 'declined')}>Decline</button>
              {:else if r.status === 'downloading'}
                <button onclick={() => setStatus(r, 'fulfilled')}>Fulfilled</button>
              {/if}
              <button class="danger" onclick={() => remove(r)}>Remove</button>
            </div>
          {:else if r.status === 'pending'}
            <div class="actions"><button class="danger" onclick={() => remove(r)}>Cancel</button></div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 980px; margin: 0 auto; }
  header { margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }

  .new { display: flex; gap: var(--s2); flex-wrap: wrap; margin-bottom: var(--s3); }
  .new input[type='text'] { flex: 2 1 240px; }
  .new .note { flex: 1.5 1 180px; }
  .new select {
    font-family: inherit; font-size: 0.94rem; color: var(--ink);
    background: var(--bg-raised); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm); padding: 8px 12px; cursor: pointer;
  }
  .cta {
    background: var(--cta); color: var(--cta-ink); font-weight: 700;
    padding: 11px 24px; border-radius: var(--r-sm);
  }
  .cta:disabled { opacity: 0.4; cursor: default; }
  .ok { color: #7ed491; font-size: 0.9rem; margin-bottom: var(--s3); }
  .err { color: #ff6b6b; font-size: 0.9rem; margin-bottom: var(--s3); }

  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: var(--ink-faint); padding: var(--s5) 0; }

  .list { display: flex; flex-direction: column; margin-top: var(--s4); }
  .row {
    display: flex; gap: var(--s4); align-items: center;
    padding: var(--s3) 0; border-top: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .thumb { flex: 0 0 46px; width: 46px; aspect-ratio: 2/3; object-fit: cover; border-radius: 4px; }
  .thumb.ph { background: var(--bg-raised); }
  .text { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 3px; }
  .t { font-weight: 600; }
  .sub { text-transform: none; letter-spacing: 0.02em; font-size: 0.8rem; }
  .status {
    font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
    padding: 4px 10px; border-radius: 99px;
    background: var(--bg-raised); color: var(--ink-soft);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .status.downloading { color: #6db3ff; }
  .status.fulfilled { color: #7ed491; }
  .status.declined { color: var(--ink-faint); }
  .actions { display: flex; gap: var(--s2); }
  .actions button {
    font-size: 0.82rem; font-weight: 600; color: var(--ink-soft);
    padding: 7px 12px; border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: color var(--t-fast), background var(--t-fast);
  }
  .actions button:hover { color: var(--ink); background: rgba(242, 242, 244, 0.08); }
  .actions .danger:hover { color: #ff6b6b; }
</style>
