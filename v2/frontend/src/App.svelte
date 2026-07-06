<script>
  import { onMount } from 'svelte';
  import { api } from './lib/api.js';
  import { session, loadLibrary } from './lib/stores.js';
  import Home from './routes/Home.svelte';

  let phase = $state('loading'); // loading | login | ready
  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  let scrollY = $state(0);

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
      phase = 'login';
    }
  });

  // v1 auth is username + password (profiles stay hidden until signed in).
  async function signIn(e) {
    e.preventDefault();
    if (busy || !username.trim()) return;
    busy = true;
    error = '';
    try {
      await api.login(username.trim(), password);
      const me = await api.me();
      session.set(me);
      await loadLibrary(me.profileId);
      phase = 'ready';
    } catch (err) {
      // Surface the server's own message (wrong password, rate limit, ...)
      error = err.body?.error || 'Could not sign in. Check the connection to the server.';
    } finally {
      busy = false;
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

<svelte:window bind:scrollY />

{#if phase === 'loading'}
  <div class="splash">
    <div class="mark display">CHOCHEY'S</div>
    <div class="spinner"></div>
  </div>
{:else if phase === 'login'}
  <div class="splash">
    <form class="login" onsubmit={signIn}>
      <div class="mark display">CHOCHEY'S</div>
      <input
        type="text" placeholder="Username" autocomplete="username"
        bind:value={username} autofocus
      />
      <input
        type="password" placeholder="Password" autocomplete="current-password"
        bind:value={password}
      />
      <button class="cta" type="submit" disabled={busy || !username.trim()}>
        {busy ? 'Signing in…' : 'Sign In'}
      </button>
      {#if error}<p class="err">{error}</p>{/if}
    </form>
  </div>
{:else}
  <header class="topbar" class:solid={scrollY > 24}>
    <div class="brand display">CHOCHEY'S</div>
    <nav>
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
    gap: var(--s5);
  }
  .mark {
    font-size: clamp(1.4rem, 4vw, 2rem);
    letter-spacing: 0.34em;
    /* optical: tracking adds a trailing gap; nudge back to center */
    margin-right: -0.34em;
    color: var(--ink);
  }
  .spinner {
    width: 30px; height: 30px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 99px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .login {
    display: flex; flex-direction: column; gap: var(--s3);
    width: min(340px, 86vw);
  }
  .login .mark { text-align: center; margin-bottom: var(--s4); }
  .cta {
    background: var(--cta); color: var(--cta-ink);
    font-weight: 700; font-size: 1rem;
    padding: 13px; border-radius: var(--r-sm);
    transition: opacity var(--t-fast);
  }
  .cta:disabled { opacity: 0.4; cursor: default; }
  .cta:not(:disabled):hover { opacity: 0.88; }
  .err { color: #ff6b6b; font-size: 0.88rem; text-align: center; margin-top: var(--s2); }

  .topbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--s3) var(--gutter);
    background: linear-gradient(rgba(11,11,14,0.72), transparent);
    border-bottom: 1px solid transparent;
    transition: background var(--t-med), border-color var(--t-med);
  }
  /* Once content scrolls under it, the bar goes solid so nav stays legible */
  .topbar.solid {
    background: rgba(11, 11, 14, 0.82);
    backdrop-filter: blur(14px);
    border-bottom-color: var(--line);
  }
  .brand {
    font-size: 1.02rem;
    letter-spacing: 0.34em;
    color: var(--ink);
  }
  nav { display: flex; gap: var(--s5); }
  nav a {
    color: var(--ink-soft); font-size: 0.9rem; font-weight: 500;
    letter-spacing: 0.02em; transition: color var(--t-fast);
    position: relative;
  }
  nav a:hover, nav a.active { color: var(--ink); }
  nav a.active::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -6px;
    height: 2px; background: var(--ink); border-radius: 2px;
  }
  main { position: relative; }

  @media (max-width: 560px) {
    .topbar { padding: var(--s3) var(--s4); }
    .brand { letter-spacing: 0.2em; font-size: 0.92rem; }
    nav { gap: var(--s3); }
    nav a { font-size: 0.82rem; }
  }
</style>
