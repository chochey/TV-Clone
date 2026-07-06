<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { session } from '../lib/stores.js';

  // The complete permission set — v1 defines exactly these four
  // (lib/auth.js VALID_PERMISSIONS). Admins implicitly hold all of them
  // plus the admin-only surface (this page, profile/config management).
  const PERMISSIONS = [
    { key: 'canDownload', label: 'Downloads', desc: 'Downloads page — add & manage torrents' },
    { key: 'canScan', label: 'Scan library', desc: 'Trigger library rescans' },
    { key: 'canRestart', label: 'Restart server', desc: 'Restart the media server & organizer' },
    { key: 'canLogs', label: 'Monitoring', desc: 'Dashboard, Organizer & Logs pages' },
  ];
  const AVATARS = ['#00a4dc', '#e8734d', '#7ed491', '#c58af9', '#f5c518', '#6db3ff'];

  let profiles = $state(null);
  let err = $state('');
  let msg = $state('');

  // Editor state — null = closed, {} = new user, {...profile} = editing
  let edit = $state(null);
  let busy = $state(false);
  let confirmDelete = $state('');

  async function refresh() {
    try { profiles = await api.profiles(); } catch { profiles = []; }
  }
  onMount(refresh);

  function startNew() {
    confirmDelete = '';
    edit = { id: null, name: '', username: '', password: '', role: 'user', permissions: [], avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)] };
  }
  function startEdit(p) {
    confirmDelete = '';
    edit = { id: p.id, name: p.name, username: p.username || '', password: '', role: p.role || 'user', permissions: [...(p.permissions || [])], avatar: p.avatar || AVATARS[0] };
  }
  function togglePerm(key) {
    edit.permissions = edit.permissions.includes(key)
      ? edit.permissions.filter((p) => p !== key)
      : [...edit.permissions, key];
  }

  async function save(e) {
    e.preventDefault();
    if (busy || !edit.name.trim()) return;
    busy = true; err = ''; msg = '';
    const body = {
      name: edit.name.trim(),
      username: edit.username.trim().toLowerCase() || undefined,
      role: edit.role,
      permissions: edit.role === 'admin' ? [] : edit.permissions,
      avatar: edit.avatar,
    };
    // Only send a password when one was typed — PUT with '' would clear it.
    if (edit.password) body.password = edit.password;
    try {
      if (edit.id) await api.profileUpdate(edit.id, body);
      else await api.profileCreate(body);
      msg = edit.id ? `Saved ${body.name}.` : `Created ${body.name}.`;
      edit = null;
      await refresh();
    } catch (e2) {
      err = e2.body?.error || 'Could not save the profile.';
    } finally { busy = false; }
  }

  async function remove(p) {
    err = ''; msg = '';
    try {
      await api.profileDelete(p.id);
      msg = `Deleted ${p.name}.`;
      confirmDelete = '';
      await refresh();
    } catch (e2) {
      err = e2.body?.error || 'Could not delete the profile.';
    }
  }
</script>

<div class="page">
  <header>
    <h1 class="display">Users</h1>
    {#if profiles}<span class="count meta">{profiles.length}</span>{/if}
    <button class="cta new" onclick={startNew}>New User</button>
  </header>

  {#if msg}<p class="ok">{msg}</p>{/if}
  {#if err && !edit}<p class="err">{err}</p>{/if}

  {#if edit}
    <form class="editor" onsubmit={save}>
      <h2>{edit.id ? `Edit ${edit.name || 'user'}` : 'New user'}</h2>
      <div class="fields">
        <label>Display name<input type="text" bind:value={edit.name} autofocus /></label>
        <label>Username<input type="text" bind:value={edit.username} placeholder={edit.name ? edit.name.toLowerCase().replace(/[^a-z0-9]/g, '') : 'username'} autocomplete="off" /></label>
        <label>{edit.id ? 'New password (leave blank to keep)' : 'Password'}
          <input type="password" bind:value={edit.password} autocomplete="new-password" />
        </label>
        <label>Role
          <select bind:value={edit.role}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>

      {#if edit.role !== 'admin'}
        <div class="permwrap">
          <span class="meta">Permissions</span>
          <div class="perms">
            {#each PERMISSIONS as p (p.key)}
              <label class="perm">
                <input type="checkbox" checked={edit.permissions.includes(p.key)} onchange={() => togglePerm(p.key)} />
                <span class="ptext">
                  <span class="plabel">{p.label}</span>
                  <span class="pdesc">{p.desc}</span>
                </span>
              </label>
            {/each}
          </div>
          <p class="meta permnote">These four are the complete set — everything else (this page, profile & config management) is admin-only.</p>
        </div>
      {:else}
        <p class="meta admnote">Admins have every permission, plus user and config management.</p>
      {/if}

      <div class="avatars">
        <span class="meta">Color</span>
        {#each AVATARS as c (c)}
          <button type="button" class="swatch" class:sel={edit.avatar === c}
                  style={`background:${c}`} aria-label={`Avatar color ${c}`}
                  onclick={() => { edit.avatar = c; }}></button>
        {/each}
      </div>

      {#if err}<p class="err">{err}</p>{/if}
      <div class="editactions">
        <button class="cta" type="submit" disabled={busy || !edit.name.trim()}>{busy ? 'Saving…' : (edit.id ? 'Save' : 'Create')}</button>
        <button class="ghost" type="button" onclick={() => { edit = null; err = ''; }}>Cancel</button>
      </div>
    </form>
  {/if}

  {#if !profiles}
    <div class="spinner"></div>
  {:else}
    <div class="list">
      {#each profiles as p (p.id)}
        <div class="row">
          <span class="avatar" style={`background:${p.avatar || '#555'}`}>{p.name.slice(0, 1)}</span>
          <div class="text">
            <span class="t">{p.name} {#if p.id === $session?.profileId}<em class="you">you</em>{/if}</span>
            <span class="sub meta">
              {p.username ? `@${p.username}` : 'no username'} · {p.role === 'admin' ? 'Admin' : 'User'}
              {#if p.role !== 'admin' && p.permissions?.length}
                · {p.permissions.map((k) => PERMISSIONS.find((x) => x.key === k)?.label || k).join(', ')}
              {/if}
              {#if !p.hasPassword}· <strong class="warn">no password</strong>{/if}
            </span>
          </div>
          <div class="actions">
            <button onclick={() => startEdit(p)}>Edit</button>
            {#if p.id !== $session?.profileId}
              {#if confirmDelete === p.id}
                <button class="danger" onclick={() => remove(p)}>Really delete?</button>
              {:else}
                <button class="danger" onclick={() => { confirmDelete = p.id; }}>Delete</button>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 860px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: var(--s3); margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .new { margin-left: auto; }
  .cta {
    background: var(--cta); color: var(--cta-ink); font-weight: 700;
    padding: 10px 22px; border-radius: var(--r-sm);
  }
  .cta:disabled { opacity: 0.4; cursor: default; }
  .ghost {
    background: rgba(242, 242, 244, 0.14); color: var(--ink);
    font-weight: 600; padding: 10px 22px; border-radius: var(--r-sm);
  }
  .ok { color: #7ed491; font-size: 0.9rem; margin-bottom: var(--s3); }
  .err { color: #ff6b6b; font-size: 0.9rem; margin: var(--s2) 0; }
  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .editor {
    background: var(--bg-raised); border-radius: var(--r-md);
    padding: var(--s4); margin-bottom: var(--s5);
    box-shadow: inset 0 0 0 1px var(--line);
    display: flex; flex-direction: column; gap: var(--s4);
  }
  .editor h2 { font-size: 1.05rem; font-weight: 700; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--s3); }
  .fields label { display: flex; flex-direction: column; gap: 6px; font-size: 0.82rem; color: var(--ink-soft); }
  .fields select {
    font-family: inherit; font-size: 1rem; color: var(--ink);
    background: var(--bg); border: 1px solid var(--line-strong);
    border-radius: var(--r-sm); padding: 12px 14px; cursor: pointer;
  }
  .fields input { background: var(--bg); }

  .permwrap { display: flex; flex-direction: column; gap: var(--s3); }
  .perms {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--s2);
  }
  .perm {
    display: flex; align-items: flex-start; gap: 10px;
    padding: var(--s3);
    background: var(--bg); border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--line);
    cursor: pointer;
    transition: box-shadow var(--t-fast);
  }
  .perm:hover { box-shadow: inset 0 0 0 1px var(--line-strong); }
  .perm input { margin-top: 2px; accent-color: var(--cta); }
  .ptext { display: flex; flex-direction: column; gap: 2px; }
  .plabel { font-size: 0.9rem; font-weight: 600; color: var(--ink); }
  .pdesc { font-size: 0.78rem; color: var(--ink-faint); }
  .permnote, .admnote { text-transform: none; letter-spacing: 0.02em; }

  .avatars { display: flex; align-items: center; gap: var(--s2); }
  .swatch {
    width: 26px; height: 26px; border-radius: 99px;
    transition: transform var(--t-fast), box-shadow var(--t-fast);
  }
  .swatch.sel { transform: scale(1.2); box-shadow: 0 0 0 2px var(--bg-raised), 0 0 0 4px var(--ink); }
  .editactions { display: flex; gap: var(--s2); }

  .list { display: flex; flex-direction: column; }
  .row {
    display: flex; gap: var(--s4); align-items: center;
    padding: var(--s3) 0; border-top: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .avatar {
    flex: 0 0 40px; width: 40px; height: 40px; border-radius: 99px;
    display: grid; place-items: center;
    font-weight: 800; color: #0b0b0e; text-transform: uppercase;
  }
  .text { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 2px; }
  .t { font-weight: 600; }
  .you {
    font-style: normal; font-size: 0.68rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--ink-faint); margin-left: 6px;
  }
  .sub { text-transform: none; letter-spacing: 0.02em; font-size: 0.8rem; }
  .warn { color: #ffb46b; }
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
