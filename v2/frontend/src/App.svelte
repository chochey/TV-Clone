<script>
  import { onMount } from 'svelte';
  import { api } from './lib/api.js';
  import { session, libraryLoaded, loadLibrary } from './lib/stores.js';
  import Home from './routes/Home.svelte';

  let phase = $state('loading'); // loading | login | ready
  let profiles = $state([]);
  let error = $state('');

  onMount(async () => {
    // Wait for the v1 backend to be ready (it may be mid-scan).
    let health = await api.health();
    for (let i = 0; i < 30 && !(health && health.ready); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      health = await api.health();
    }
    const me = await api.me();
    if (me && me.loggedIn) {
      session.set(me);
      await loadLibrary(me.profileId);
      phase = 'ready';
    } else {
      profiles = await api.profiles();
      phase = 'login';
    }
  });

  async function pick(profile) {
    error = '';
    // No-password profiles log straight in; others would need a prompt (later).
    try {
      const res = await api.login(profile.id, '');
      if (res.ok) {
        const me = await api.me();
        session.set(me);
        await loadLibrary(me.profileId);
        phase = 'ready';
      }
    } catch (e) {
      error = profile.hasPassword ? 'This profile needs a password (coming soon — use v1 to sign in for now).' : 'Could not sign in.';
    }
  }

  function openItem(item) {
    // Detail view lands next; for now surface the choice.
    console.log('open', item.title);
  }
  function playItem(item) {
    console.log('play', item.title);
  }
</script>

{#if phase === 'loading'}
  <div class="splash">
    <div class="mark serif">Chochey's</div>
    <div class="spinner"></div>
    <span class="meta">Warming the projector…</span>
  </div>
{:else if phase === 'login'}
  <div class="splash">
    <div class="mark serif">Who's watching?</div>
    <div class="profiles">
      {#each profiles as p (p.id)}
        <button class="profile" onclick={() => pick(p)}>
          <span class="avatar" style={`background:${p.avatar || '#e8a33d'}`}>{p.name.slice(0, 1)}</span>
          <span class="pname">{p.name}</span>
        </button>
      {/each}
    </div>
    {#if error}<p class="err meta">{error}</p>{/if}
  </div>
{:else}
  <header class="topbar">
    <div class="brand serif">Chochey's</div>
    <nav class="meta">
      <a class="active" href="/">Home</a>
      <a href="/movies">Films</a>
      <a href="/shows">Series</a>
      <a href="/search">Search</a>
    </nav>
  </header>
  <main>
    <Home onopen={openItem} onplay={playItem} />
  </main>
{/if}

<style>
  .splash {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--s4);
  }
  .mark { font-size: clamp(2rem, 6vw, 3.4rem); font-weight: 800; }
  .spinner {
    width: 34px; height: 34px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--accent);
    border-radius: 99px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .profiles { display: flex; gap: var(--s5); flex-wrap: wrap; justify-content: center; margin-top: var(--s4); }
  .profile { display: flex; flex-direction: column; align-items: center; gap: var(--s3); }
  .avatar {
    width: 92px; height: 92px;
    border-radius: var(--r-lg);
    display: grid; place-items: center;
    font-family: var(--font-display);
    font-size: 2.2rem; font-weight: 800; color: #1a1206;
    transition: transform var(--t-fast) var(--ease);
  }
  .profile:hover .avatar { transform: scale(1.06); }
  .pname { font-size: 0.92rem; }
  .err { color: var(--accent); margin-top: var(--s4); }

  .topbar {
    position: sticky; top: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--s4) var(--gutter);
    background: linear-gradient(var(--paper), rgba(15, 14, 12, 0.4) 70%, transparent);
    backdrop-filter: blur(8px);
  }
  .brand { font-size: 1.5rem; font-weight: 800; }
  nav { display: flex; gap: var(--s4); }
  nav a { color: var(--ink-soft); transition: color var(--t-fast); }
  nav a:hover, nav a.active { color: var(--ink); }
</style>
