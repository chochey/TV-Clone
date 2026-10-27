<script>
  // Dialog on the title page ("Fix film details" permission): fix by hand what the automatic match
  // got wrong. Only the fields that changed are saved (lib/metadata-overrides.js), so untouched
  // ones keep following OMDb; a poster pasted as a link is downloaded and kept by the server.
  // "Use automatic details" drops every hand edit. See lib/routes/metadata.js.
  import { api } from '../api.js';

  let { item, kind = 'video', onclose, onchanged } = $props();

  // Audiobooks have no OMDb record: what they show comes from the file's tags, so the fields differ.
  const AUDIO_FIELDS = [
    { key: 'title', label: 'Title' },
    { key: 'artist', label: 'Author' },
    { key: 'coverUrl', label: 'Cover link', hint: 'paste a web link to the picture; the app downloads and keeps it' },
  ];
  const VIDEO_FIELDS = [
    { key: 'plot', label: 'Description', multiline: true },
    { key: 'director', label: 'Director' },
    { key: 'actors', label: 'Cast', hint: 'names separated by commas' },
    { key: 'genre', label: 'Genres', hint: 'separated by commas' },
    { key: 'rated', label: 'Age rating', hint: 'R, PG-13, TV-MA…' },
    { key: 'imdbRating', label: 'IMDb rating', hint: 'for example 6.7' },
    { key: 'runtime', label: 'Runtime', hint: 'for example 113 min' },
    { key: 'omdbPosterUrl', label: 'Poster link', hint: 'paste a web link to the picture; the app downloads and keeps it' },
  ];
  const FIELDS = kind === 'audio' ? AUDIO_FIELDS : VIDEO_FIELDS;
  const tagged = key => (kind === 'audio' ? (key === 'coverUrl' ? item?.coverUrl || item?.audioMetadata?.coverUrl : item?.audioMetadata?.[key] || item?.[key]) : item?.[key]);
  const current = key => { const v = tagged(key); return v && v !== 'N/A' ? String(v) : ''; };
  const original = Object.fromEntries(FIELDS.map(f => [f.key, current(f.key)]));
  let values = $state({ ...original });
  let edited = $state({});       // the override on file: which fields were set by hand
  let busy = $state(false);
  let problem = $state('');
  let alive = true;
  $effect(() => () => { alive = false; });
  api.metadataOverride(item.id).then(o => { if (alive) edited = o || {}; }).catch(() => {});

  const hasEdits = $derived(Object.keys(edited).length > 0);

  async function apply(call, failure) {
    busy = true; problem = '';
    try { await call(); await onchanged?.(); if (alive) onclose?.(); }
    catch (err) { if (alive) problem = err.body?.error || failure; }
    finally { if (alive) busy = false; }
  }
  function save() {
    const set = {}, clear = [];
    for (const f of FIELDS) {
      const v = values[f.key].trim();
      if (v === original[f.key]) continue;
      if (v) set[f.key] = v;
      else if (edited[f.key]) clear.push(f.key);   // an emptied hand edit goes back to automatic
    }
    if (!Object.keys(set).length && !clear.length) { onclose?.(); return; }
    return apply(async () => {
      for (const key of clear) await api.metadataOverrideClearField(item.id, key);
      if (Object.keys(set).length) await api.metadataOverrideSave(item.id, set);
    }, 'Could not save. Try again.');
  }
  const automatic = () => apply(() => api.metadataOverrideClear(item.id), 'Could not go back to the automatic details. Try again.');
</script>

<div class="backdrop" role="presentation" onclick={(ev) => { if (ev.target === ev.currentTarget && !busy) onclose?.(); }}
     onkeydown={(ev) => ev.key === 'Escape' && !busy && onclose?.()}>
  <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="editd-title" tabindex="-1" onsubmit={(ev) => { ev.preventDefault(); save(); }}>
    <h2 id="editd-title">Edit details</h2>
    <p class="for">{item.title}{item.year ? ` (${item.year})` : ''}</p>
    {#each FIELDS as f (f.key)}
      <label class="field">
        <span>{f.label}{#if edited[f.key]} <em class="tag">edited by hand</em>{/if}</span>
        {#if f.multiline}
          <textarea rows="3" bind:value={values[f.key]} disabled={busy}></textarea>
        {:else}
          <input bind:value={values[f.key]} disabled={busy} />
        {/if}
        {#if f.hint}<small>{f.hint}</small>{/if}
      </label>
    {/each}
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    <div class="actions">
      {#if hasEdits}<button type="button" class="ghost" onclick={automatic} disabled={busy}>Use automatic details</button>{/if}
      <span class="grow"></span>
      <button type="button" class="ghost" onclick={() => onclose?.()} disabled={busy}>Cancel</button>
      <button type="submit" class="go" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  </form>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.7);
    display: grid; place-items: center; padding: var(--s4);
  }
  .dialog {
    width: min(560px, 100%); max-height: calc(100vh - 2 * var(--s4)); overflow: auto;
    background: var(--bg-raised); border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--line-strong), 0 24px 60px rgba(0, 0, 0, 0.6);
    padding: var(--s5); display: flex; flex-direction: column; gap: var(--s3); margin: 0;
  }
  h2 { margin: 0; font-size: 1.2rem; }
  .for { margin: 0; color: var(--ink-soft); }
  .field { display: flex; flex-direction: column; gap: 5px; font-size: 0.82rem; font-weight: 600; color: var(--ink-soft); }
  .field small { font-weight: 400; color: var(--ink-faint); }
  .tag { font-style: normal; font-weight: 500; color: var(--accent); margin-left: 6px; }
  input, textarea {
    font: inherit; font-weight: 500; color: var(--ink); background: var(--bg);
    border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: 8px 10px; min-width: 0; resize: vertical;
  }
  .problem { margin: 0; color: #ff8a80; }
  .actions { display: flex; align-items: center; gap: var(--s2); margin-top: var(--s2); }
  .grow { flex: 1; }
  .ghost, .go { font-weight: 600; padding: 9px 18px; border-radius: var(--r-sm); white-space: nowrap; }
  .ghost { background: rgba(243, 237, 228, 0.12); color: var(--ink); }
  .go { background: var(--cta); color: var(--cta-ink); }
  .ghost:disabled, .go:disabled { opacity: 0.5; cursor: default; }
</style>
