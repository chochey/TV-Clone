<script>
  // Admin and occasional pages load on their first visit (App.svelte `pages`), so people who never open
  // them never download them: 12 of the 19 pages, about 30% of the app's code (2026-11-09). A page that will
  // not load is nearly always a tab from before a deploy, so the app reloads once (lib/lazy-page.js).
  import { reloadOnceForMissingPage } from '../lazy-page.js';
  let { load, props = {} } = $props();
  let Page = $state(null);
  let failed = $state(false);

  $effect(() => {
    const loading = load;
    let current = true;
    Page = null;
    failed = false;
    loading().then(module => { if (current) Page = module.default; }, () => {
      if (!current) return;
      let storage;
      try { storage = window.sessionStorage; } catch {}
      if (reloadOnceForMissingPage(storage)) location.reload();
      else failed = true;
    });
    return () => { current = false; };
  });
</script>

{#if Page}
  <Page {...props} />
{:else if failed}
  <div class="state" role="alert">
    <p>This page could not load.</p>
    <button onclick={() => location.reload()}>Reload</button>
  </div>
{:else}
  <div class="state"><div class="spinner" aria-label="Loading"></div></div>
{/if}

<style>
  .state {
    display: flex; flex-direction: column; align-items: center; gap: var(--s3);
    padding: calc(64px + var(--s7)) var(--gutter) var(--s7);
    color: var(--ink-soft);
  }
  button {
    min-height: 40px; padding: 0 20px; border-radius: var(--r-pill);
    background: var(--accent); color: var(--accent-ink); font-weight: 700;
  }
  .spinner {
    width: 30px; height: 30px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 99px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
