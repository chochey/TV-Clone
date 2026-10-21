<script>
  // Change your own password: the current one proves it is you, and the server signs out your
  // other devices. Opened from the account menu; every account gets it.
  import { api } from '../api.js';
  let { onclose, ondone } = $props();
  let current = $state(''), next = $state(''), confirm = $state('');
  let busy = $state(false), problem = $state('');
  let first = $state(null);
  $effect(() => { first?.focus(); });

  async function submit(e) {
    e.preventDefault();
    problem = '';
    if (!current || !next) { problem = 'Enter your current password and a new one.'; return; }
    if (next !== confirm) { problem = 'The new passwords do not match.'; return; }
    busy = true;
    try { await api.changePassword(current, next); ondone?.(); }
    catch (err) { problem = err.body?.error || 'Could not change the password. Try again.'; }
    finally { busy = false; }
  }
</script>

<div class="backdrop" role="presentation" onclick={(ev) => { if (ev.target === ev.currentTarget && !busy) onclose?.(); }}
     onkeydown={(ev) => ev.key === 'Escape' && !busy && onclose?.()}>
  <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="chpw-title" tabindex="-1" onsubmit={submit}>
    <h2 id="chpw-title">Change password</h2>
    <label class="field"><span>Current password</span><input type="password" bind:value={current} bind:this={first} autocomplete="current-password" disabled={busy} /></label>
    <label class="field"><span>New password</span><input type="password" bind:value={next} autocomplete="new-password" disabled={busy} /></label>
    <label class="field"><span>Confirm new password</span><input type="password" bind:value={confirm} autocomplete="new-password" disabled={busy} /></label>
    {#if problem}<p class="err" role="alert">{problem}</p>{/if}
    <p class="note">Your other devices are signed out once it changes; this one stays signed in.</p>
    <div class="actions">
      <button type="button" class="ghost" onclick={() => onclose?.()} disabled={busy}>Cancel</button>
      <button type="submit" class="primary" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
    </div>
  </form>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.6); display: grid; place-items: center; padding: var(--s4); }
  .dialog { width: min(420px, 100%); background: var(--bg-raised); border: 1px solid var(--line-strong); border-radius: var(--r-md); padding: var(--s5); display: flex; flex-direction: column; gap: var(--s3); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6); }
  h2 { margin: 0; font-size: 1.2rem; }
  .field { display: flex; flex-direction: column; gap: 6px; font-size: 0.82rem; font-weight: 600; color: var(--ink-soft); }
  .field input { font-size: 1rem; }
  .err { margin: 0; color: var(--bad, #e5484d); font-size: 0.88rem; }
  .note { margin: 0; color: var(--ink-faint); font-size: 0.8rem; }
  .actions { display: flex; justify-content: flex-end; gap: var(--s2); margin-top: var(--s2); }
  .primary { background: var(--cta); color: var(--cta-ink); font-weight: 700; padding: 10px 18px; border-radius: var(--r-sm); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost { color: var(--ink-soft); padding: 10px 14px; }
</style>
