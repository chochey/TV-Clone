<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { navigate } from '../lib/router.js';

  let { onchange } = $props();
  const kinds = { movie: 'Films', show: 'Series', audio: 'Audio', mixed: 'Mixed media' };
  let folders = $state(null);
  let loadError = $state('');
  let actionError = $state('');
  let message = $state('');
  let name = $state('');
  let kind = $state('show');
  let location = $state('');
  let busy = $state(false);
  let unlink = $state(null);
  let browsing = $state(false);
  let browseBusy = $state(false);
  let browseError = $state('');
  let directory = $state(null);
  let closed = false;
  let browseRequest = 0;

  async function refresh() {
    try {
      const data = await api.libraryLocations();
      if (!Array.isArray(data)) throw new Error('Invalid library response');
      if (closed) return;
      folders = data; loadError = '';
    } catch (e) {
      if (!closed) loadError = e.body?.error || 'Linked locations could not be loaded.';
    }
  }
  onMount(() => { refresh(); return () => { closed = true; browseRequest++; }; });

  async function refreshAfterChange() {
    await refresh();
    try { await onchange?.(); }
    catch { if (!closed) message += ' The catalog could not refresh yet. Try refreshing the page.'; }
  }
  async function add(e) {
    e.preventDefault();
    if (busy || !name.trim() || !location.trim()) return;
    busy = true; actionError = ''; message = ''; unlink = null;
    const label = name.trim();
    // Keep new named sections distinct from legacy type='show' roots, whose
    // episodes intentionally group together across physical locations.
    const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'library';
    try {
      const result = await api.libraryLocationAdd({ path: location.trim(), label, type: `custom-${slug}`, mediaKind: kind });
      if (!result?.ok) throw new Error(result?.error || 'Location could not be linked.');
      if (closed) return;
      message = `Linked ${label}. Its section is now in the main navigation.`;
      name = ''; location = ''; closeBrowser();
      await refreshAfterChange();
    } catch (e2) {
      if (!closed) actionError = e2.body?.error || e2.message || 'Location could not be linked.';
    } finally { if (!closed) busy = false; }
  }
  async function remove() {
    if (busy || !unlink) return;
    const target = unlink;
    busy = true; actionError = ''; message = '';
    try {
      const result = await api.libraryLocationRemove(target.path);
      if (!result?.ok) throw new Error(result?.error || 'Location could not be unlinked.');
      if (closed) return;
      folders = folders?.filter(f => f.path !== target.path) || [];
      unlink = null;
      message = `Unlinked ${target.label || target.path}. Files remain on disk.`;
      await refreshAfterChange();
    } catch (e) {
      if (!closed) actionError = e.body?.error || e.message || 'Location could not be unlinked.';
    } finally { if (!closed) busy = false; }
  }

  async function browse(path = '') {
    const request = ++browseRequest;
    browsing = true; browseBusy = true; browseError = '';
    try {
      const data = await api.browseLocations(path);
      if (!data?.current || !Array.isArray(data.dirs)) throw new Error('Invalid location response');
      if (!closed && request === browseRequest) directory = data;
    } catch (e) {
      if (!closed && request === browseRequest) browseError = e.body?.error || 'This location could not be read. Enter another path or choose a different location.';
    } finally { if (!closed && request === browseRequest) browseBusy = false; }
  }
  function closeBrowser() { browseRequest++; browsing = false; browseBusy = false; browseError = ''; directory = null; }
  function useLocation() {
    if (!directory || browseBusy) return;
    location = directory.current;
    if (!name.trim()) name = directory.current.split('/').filter(Boolean).at(-1) || 'Library';
    closeBrowser();
  }
  function childPath(child) { return `${directory.current.replace(/\/$/, '')}/${child}`; }
  function folderKind(folder) {
    return kinds[folder.mediaKind] || kinds[folder.type] || 'Mixed media';
  }
</script>

<div class="page">
  <header><h1 class="display">Libraries</h1><p>Give each location a name, such as Anime or Audio Books. Each custom library appears directly in the main navigation for everyone who can sign in.</p></header>
  {#if message}<p class="success" role="status">{message}</p>{/if}
  {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}

  <section class="panel">
    <h2>Add a library location</h2>
    <p class="hint">Link an existing folder on the server. This does not create or move folders.</p>
    <form onsubmit={add}>
      <div class="fields">
        <label>Library name<input bind:value={name} placeholder="Anime, Audio Books…" required disabled={busy} /></label>
        <label>Content kind
          <select bind:value={kind} disabled={busy}>
            <option value="movie">Films</option><option value="show">Series</option><option value="audio">Audio</option><option value="mixed">Mixed media</option>
          </select>
        </label>
      </div>
      <label>Server location<input bind:value={location} placeholder="/mnt/media/Anime" required disabled={busy} autocomplete="off" /></label>
      <p class="hint">{kind === 'audio' ? 'Audio: MP3, M4A, M4B, AAC, FLAC, WAV, OGG and Opus. Playback depends on your browser’s format support. Audible AAX, AA and AAXC books are listed, but need an unprotected MP3 or M4B copy to play.' : kind === 'mixed' ? 'Mixed media includes films, series and audio. Episode filenames identify series. Protected Audible books are listed with a compatibility message.' : kind === 'show' ? 'Series are grouped into shows and episodes. Video: MP4, MKV and AVI.' : 'Films are shown as individual titles. Video: MP4, MKV and AVI.'}</p>
      <div class="actions">
        <button type="button" class="secondary" disabled={busy} onclick={() => browse(location.trim())}>Browse locations</button>
        <button type="submit" class="cta" disabled={busy || !name.trim() || !location.trim()}>{busy ? 'Saving…' : 'Link location'}</button>
      </div>
    </form>

    {#if browsing}
      <section class="browser" aria-label="Browse server locations">
        <div class="browser-head"><h3>Server locations</h3><button class="secondary" type="button" onclick={closeBrowser}>Close browser</button></div>
        {#if browseError}<p class="error" role="alert">{browseError}</p>{/if}
        {#if browseBusy}<p class="hint" role="status">Loading locations…</p>{/if}
        {#if directory}
          <p class="path">{directory.current}</p>
          <div class="actions">
            <button type="button" class="secondary" disabled={browseBusy || directory.parent === directory.current} onclick={() => browse(directory.parent)}>Parent location</button>
            <button type="button" class="cta" disabled={browseBusy || !!browseError} onclick={useLocation}>Use this location</button>
          </div>
          <div class="directories">
            {#each directory.dirs as dir (dir)}
              <button type="button" disabled={browseBusy} onclick={() => browse(childPath(dir))}>▸ {dir}</button>
            {/each}
            {#if !directory.dirs.length}<p class="hint">No subfolders.</p>{/if}
          </div>
          {#if directory.mediaCount != null}<p class="hint">{directory.mediaCount} supported media files directly in this location. Subfolders are included when the library scans.</p>{/if}
        {:else if !browseBusy}<button type="button" class="secondary" onclick={() => browse('')}>Browse media locations</button>{/if}
      </section>
    {/if}
  </section>

  <section class="panel">
    <h2>Linked locations</h2>
    {#if loadError}<p class="error" role="alert">{loadError} <button class="secondary" disabled={busy} onclick={refresh}>Retry locations</button></p>{/if}
    {#if folders === null && !loadError}<p class="hint" role="status">Loading linked locations…</p>{/if}
    {#if folders?.length === 0}<p class="hint">No locations linked yet.</p>{/if}
    {#each folders || [] as folder (folder.path)}
      <article class="location">
        <div class="location-top"><h3>{folder.label || folder.path}</h3><span class:missing={!folder.exists} class="status">{folder.exists ? 'Connected' : 'Unavailable'}</span></div>
        <p class="path">{folder.path}</p>
        <p class="hint">{folderKind(folder)} · {Number(folder.fileCount || 0).toLocaleString()} files</p>
        <div class="actions">
          {#if folder.id}<a class="secondary" href={`/library/${encodeURIComponent(folder.id)}`} onclick={(e) => { e.preventDefault(); navigate(`/library/${encodeURIComponent(folder.id)}`); }}>Open library</a>{/if}
          <button type="button" class="secondary" disabled={busy} onclick={() => { unlink = folder; actionError = ''; message = ''; }}>Unlink</button>
        </div>
        {#if unlink?.path === folder.path}
          <div class="confirmation" role="region" aria-label="Confirm unlink">
            <p>Unlink <strong>{folder.label || folder.path}</strong>? Its titles will leave the library. No files will be deleted; everything remains at this server location.</p>
            <div class="actions"><button class="danger" disabled={busy} onclick={remove}>{busy ? 'Unlinking…' : 'Unlink location'}</button><button class="secondary" disabled={busy} onclick={() => { unlink = null; actionError = ''; }}>Cancel</button></div>
          </div>
        {/if}
      </article>
    {/each}
  </section>
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1050px; margin: 0 auto; }
  header { margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); margin-bottom: var(--s3); }
  header p, .hint { color: var(--ink-soft); font-size: .9rem; line-height: 1.6; }
  .panel { background: var(--bg-raised); padding: var(--s4); border: 1px solid var(--line); border-radius: var(--r-md); margin-bottom: var(--s4); }
  h2 { font-size: 1.12rem; margin-bottom: var(--s2); }
  h3 { font-size: 1rem; overflow-wrap: anywhere; }
  form { margin-top: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }
  label { display: flex; flex-direction: column; gap: var(--s2); font-size: .9rem; font-weight: 600; min-width: 0; }
  input, select { width: 100%; min-width: 0; }
  select { font: inherit; color: var(--ink); background: var(--bg-raised); border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s2); }
  .cta, .secondary, .danger { display: inline-block; padding: 10px 15px; border-radius: var(--r-sm); font-size: .9rem; font-weight: 600; min-height: 44px; }
  .cta { background: var(--cta); color: var(--cta-ink); }
  .secondary { border: 1px solid var(--line-strong); color: var(--ink); }
  .secondary:hover { background: var(--line); }
  button:disabled, input:disabled, select:disabled { opacity: .5; cursor: default; }
  .cta:disabled { opacity: 1; background: rgba(243, 237, 228, 0.1); color: var(--ink-faint); }
  .success { color: #7ed491; margin-bottom: var(--s4); }
  .error { color: #ff6b6b; margin-bottom: var(--s3); overflow-wrap: anywhere; }
  .location { border-top: 1px solid var(--line-strong); margin-top: var(--s4); padding-top: var(--s4); }
  .location-top, .browser-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; }
  .status { color: #7ed491; font-size: .8rem; }
  .status.missing { color: #ffb46b; }
  .path { overflow-wrap: anywhere; font-size: .86rem; color: var(--ink-soft); margin: var(--s2) 0; }
  .confirmation { border: 1px solid #ffb46b; border-radius: var(--r-sm); padding: var(--s3); margin-top: var(--s3); font-size: .9rem; }
  .danger { color: #ff6b6b; border: 1px solid currentColor; }
  .browser { margin-top: var(--s4); padding-top: var(--s4); border-top: 1px solid var(--line-strong); }
  .directories { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; margin: var(--s3) 0; overscroll-behavior: contain; }
  .directories button { text-align: left; padding: 10px; min-height: 44px; border-radius: var(--r-sm); overflow-wrap: anywhere; }
  .directories button:hover { background: var(--line); }
  @media (max-width: 560px) { .fields { grid-template-columns: 1fr; } .panel { padding: var(--s3); } }
</style>
