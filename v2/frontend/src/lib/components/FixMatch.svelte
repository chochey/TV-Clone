<script>
  // Admin dialog on the title page: the app matched this title to the wrong OMDb record. It lists
  // what the title could be (OMDb's candidates, each with director, actors and a plot line, which is
  // what tells similar names apart) and pins the chosen one; "Use automatic match" undoes that.
  // See lib/routes/metadata.js ("Wrong film?") and docs/plans/2026-10-26-wrong-film-match-design.md.
  import { api } from '../api.js';

  let { item, onclose, onchanged } = $props();

  let q = $state(item.title || '');
  let data = $state(null);        // { title, year, kind, current, candidates }
  let loading = $state(true);
  let busy = $state(false);
  let problem = $state('');
  let alive = true;
  $effect(() => () => { alive = false; });

  const IMDB = /\b(tt\d{7,10})\b/i;

  async function load(query = '') {
    loading = true; problem = '';
    try { const d = await api.metadataMatch(item.id, query); if (alive) data = d; }
    catch (err) { if (alive) problem = err.body?.error || 'Could not ask OMDb. Try again in a moment.'; }
    finally { if (alive) loading = false; }
  }
  load();

  // Another spelling searches again; a pasted IMDb link or number is the answer itself.
  async function search() {
    const text = q.trim();
    if (!text) return;
    const link = text.match(IMDB);
    if (link) return choose(link[1]);
    await load(text);
  }

  async function apply(call, failure) {
    busy = true; problem = '';
    try { await call(); await onchanged?.(); if (alive) onclose?.(); }
    catch (err) { if (alive) problem = err.body?.error || failure; }
    finally { if (alive) busy = false; }
  }
  const choose = imdbID => apply(() => api.metadataMatchSet(item.id, imdbID), 'Could not save that choice. Try again.');
  const automatic = () => apply(() => api.metadataMatchClear(item.id), 'Could not go back to the automatic match. Try again.');

  const kindWord = t => (t === 'series' ? 'Series' : t === 'movie' ? 'Film' : t || '');
  const line = c => [c.year, kindWord(c.type), c.director].filter(Boolean).join(' · ');
  const heading = $derived(`Wrong ${data?.kind === 'series' ? 'series' : 'film'}?`);
</script>

<div class="backdrop" role="presentation" onclick={(ev) => { if (ev.target === ev.currentTarget && !busy) onclose?.(); }}
     onkeydown={(ev) => ev.key === 'Escape' && !busy && onclose?.()}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="fixm-title" tabindex="-1">
    <h2 id="fixm-title">{heading}</h2>
    <p class="for">{item.title}{item.year ? ` (${item.year})` : ''}</p>
    {#if data?.current}
      <p class="current">Matched to <strong>{data.current.omdbTitle}</strong>{data.current.omdbYear ? ` (${data.current.omdbYear})` : ''}
        <em>{data.current.pinned ? '· chosen by you' : '· automatic'}</em></p>
      {#if data.current.pinned}
        <button class="ghost small" onclick={automatic} disabled={busy}>Use automatic match</button>
      {/if}
    {:else if data}
      <p class="current">No match yet.</p>
    {/if}
    <form class="search" onsubmit={(ev) => { ev.preventDefault(); search(); }}>
      <input bind:value={q} aria-label="Search OMDb" placeholder="Another spelling, or an IMDb link" disabled={busy} />
      <button class="ghost" type="submit" disabled={busy || loading}>Search</button>
    </form>
    <p class="tip">Know the {data?.kind === 'series' ? 'series' : 'film'} on IMDb? Paste its link here (imdb.com/title/tt…) and press Search to pick it directly.</p>
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    {#if loading}
      <p class="message" role="status">Asking OMDb…</p>
    {:else if data && !data.candidates.length}
      <p class="message">OMDb has nothing like that. Try another spelling, or paste the film's IMDb link.</p>
    {:else if data}
      <ul class="candidates">
        {#each data.candidates as c (c.imdbID)}
          {@const isCurrent = c.imdbID === data.current?.imdbID}
          <li class:now={isCurrent}>
            <div class="thumb">{#if c.poster}<img src={c.poster} alt="" loading="lazy" />{/if}</div>
            <div class="about">
              <strong>{c.title}</strong>
              <span class="meta">{line(c)}</span>
              {#if c.actors}<span class="meta">{c.actors}</span>{/if}
              {#if c.plot}<span class="plot">{c.plot}</span>{/if}
            </div>
            {#if isCurrent}<span class="tag">Current</span>
            {:else}<button class="go" onclick={() => choose(c.imdbID)} disabled={busy}>Use this</button>{/if}
          </li>
        {/each}
      </ul>
      <p class="message">Not in the list? Paste the {data.kind === 'series' ? "series'" : "film's"} IMDb link above.</p>
    {/if}
    <div class="actions">
      <button class="ghost" onclick={() => onclose?.()} disabled={busy}>Close</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.7);
    display: grid; place-items: center; padding: var(--s4);
  }
  .dialog {
    width: min(640px, 100%); max-height: calc(100vh - 2 * var(--s4)); overflow: auto;
    background: var(--bg-raised); border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--line-strong), 0 24px 60px rgba(0, 0, 0, 0.6);
    padding: var(--s5); display: flex; flex-direction: column; gap: var(--s3);
  }
  h2 { margin: 0; font-size: 1.2rem; }
  .for { margin: 0; color: var(--ink-soft); }
  .current { margin: 0; color: var(--ink-soft); }
  .current em { font-style: normal; color: var(--ink-faint); }
  .search { display: flex; gap: var(--s2); }
  .tip { margin: -6px 0 0; color: var(--ink-faint); font-size: 0.85rem; }
  .search input {
    flex: 1; min-width: 0; font: inherit; font-weight: 500; color: var(--ink); background: var(--bg);
    border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: 8px 10px;
  }
  .candidates { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--s2); }
  .candidates li {
    display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: var(--s3); align-items: center;
    padding: var(--s2); border-radius: var(--r-sm); background: rgba(243, 237, 228, 0.04);
  }
  .candidates li.now { box-shadow: inset 0 0 0 1px var(--line-strong); }
  .thumb { width: 56px; height: 84px; border-radius: 4px; background: rgba(243, 237, 228, 0.08); overflow: hidden; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .about { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .about strong { font-size: 1rem; }
  .meta { color: var(--ink-soft); font-size: 0.85rem; }
  .plot { color: var(--ink-faint); font-size: 0.85rem; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .tag { color: var(--ink-faint); font-size: 0.82rem; font-weight: 600; padding: 0 6px; }
  .problem { margin: 0; color: #ff8a80; }
  .message { margin: 0; color: var(--ink-soft); }
  .actions { display: flex; justify-content: flex-end; gap: var(--s2); margin-top: var(--s2); }
  .ghost, .go { font-weight: 600; padding: 9px 18px; border-radius: var(--r-sm); white-space: nowrap; }
  .ghost { background: rgba(243, 237, 228, 0.12); color: var(--ink); }
  .ghost.small { align-self: flex-start; padding: 6px 12px; font-size: 0.85rem; }
  .go { background: var(--cta); color: var(--cta-ink); }
  .ghost:disabled, .go:disabled { opacity: 0.5; cursor: default; }
  @media (max-width: 520px) {
    .candidates li { grid-template-columns: 44px minmax(0, 1fr); }
    .candidates li .go, .candidates li .tag { grid-column: 2; justify-self: start; }
    .thumb { width: 44px; height: 66px; }
  }
</style>
