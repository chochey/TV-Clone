<script>
  // Admin dialog on the title page: add a subtitle file to the film, or to a
  // chosen episode of a series. See lib/subtitle-upload.js.
  import { api } from '../api.js';
  import { episodeCode, episodeTitle } from '../format.js';
  import { SUBTITLE_LANGUAGES, subtitleFileProblem, waitForSubtitle } from '../subtitle-upload.js';

  let { title, items, initialId = null, onclose } = $props();

  let targetId = $state(initialId || items[0]?.id);
  let lang = $state('eng');
  let file = $state(null);
  let busy = $state(false);
  let message = $state('');
  let problem = $state('');
  let done = $state(false);
  let alive = true;
  $effect(() => () => { alive = false; });

  async function upload() {
    problem = subtitleFileProblem(file);
    if (problem) return;
    busy = true; message = 'Uploading…'; done = false;
    try {
      const result = await api.subtitleUpload(targetId, lang, file);
      message = `Saved as “${result.label}”. Adding it to the library…`;
      const listed = await waitForSubtitle({ load: () => api.item(targetId), subtitleId: result.subtitleId });
      if (!alive) return;
      message = listed
        ? `“${result.label}” is ready in the player's subtitle menu.`
        : `Saved as “${result.label}”. It will appear in the player once the library finishes refreshing.`;
      done = true;
    } catch (err) {
      message = '';
      problem = err.body?.error || 'Could not upload the subtitle file. Try again.';
    } finally { busy = false; }
  }
</script>

<div class="backdrop" role="presentation" onclick={() => { if (!busy) onclose?.(); }}
     onkeydown={(ev) => ev.key === 'Escape' && !busy && onclose?.()}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="subup-title" tabindex="-1" onclick={(ev) => ev.stopPropagation()}>
    <h2 id="subup-title">Add subtitles</h2>
    <p class="for">{title}</p>
    {#if items.length > 1}
      <label class="field">
        <span>Episode</span>
        <select bind:value={targetId} disabled={busy}>
          {#each items as e (e.id)}<option value={e.id}>{episodeCode(e)} — {episodeTitle(e)}</option>{/each}
        </select>
      </label>
    {/if}
    <label class="field">
      <span>Language</span>
      <select bind:value={lang} disabled={busy}>
        {#each SUBTITLE_LANGUAGES as l (l.code)}<option value={l.code}>{l.label}</option>{/each}
      </select>
    </label>
    <label class="field">
      <span>Subtitle file (.srt or .vtt)</span>
      <input type="file" accept=".srt,.vtt" disabled={busy}
             onchange={(ev) => { file = ev.target.files?.[0] || null; problem = ''; message = ''; done = false; }} />
    </label>
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    {#if message}<p class="message" role="status">{message}</p>{/if}
    <div class="actions">
      <button class="ghost" onclick={() => onclose?.()} disabled={busy}>{done ? 'Close' : 'Cancel'}</button>
      <button class="go" onclick={upload} disabled={busy || !file}>{busy ? 'Working…' : done ? 'Add another' : 'Upload'}</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.7);
    display: grid; place-items: center; padding: var(--s4);
  }
  .dialog {
    width: min(460px, 100%); background: var(--bg-raised); border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--line-strong), 0 24px 60px rgba(0, 0, 0, 0.6);
    padding: var(--s5); display: flex; flex-direction: column; gap: var(--s3);
  }
  h2 { margin: 0; font-size: 1.2rem; }
  .for { margin: 0; color: var(--ink-soft); }
  .field { display: flex; flex-direction: column; gap: 6px; font-size: 0.82rem; font-weight: 600; color: var(--ink-soft); }
  select, input[type='file'] {
    font: inherit; font-weight: 500; color: var(--ink); background: var(--bg);
    border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: 8px 10px; min-width: 0;
  }
  .problem { margin: 0; color: #ff8a80; }
  .message { margin: 0; color: var(--ink-soft); }
  .actions { display: flex; justify-content: flex-end; gap: var(--s2); margin-top: var(--s2); }
  .ghost, .go { font-weight: 600; padding: 9px 18px; border-radius: var(--r-sm); }
  .ghost { background: rgba(242, 242, 244, 0.12); color: var(--ink); }
  .go { background: var(--cta); color: var(--cta-ink); }
  .go:disabled, .ghost:disabled { opacity: 0.5; cursor: default; }
</style>
