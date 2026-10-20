<script>
  // A small pill on a cover saying what kind of title it is. Rows that mix audiobooks with films
  // and series badge the audiobooks; the featured cards on Tonight badge both.
  let { kind } = $props();   // 'audio' | 'series' | 'film'
  const label = $derived(kind === 'audio' ? 'Audiobook' : kind === 'series' ? 'Series' : 'Film');
</script>

<span class="kind-badge" title={label}>
  {#if kind === 'audio'}
    <svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>
  {:else if kind === 'series'}
    <svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M12 18v3"/></svg>
  {:else}
    <svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 4v5M12 4v5M17 4v5"/></svg>
  {/if}
  <span>{label}</span>
</span>

<style>
  .kind-badge {
    position: absolute; left: 6px; bottom: 7px; z-index: 1;
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 8px 4px 7px; border-radius: 99px;
    font-size: 0.72rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; line-height: 1;
    /* Amber, like a primary button: the one cover in a row of posters that is a book must be seen at a glance. */
    background: var(--accent); color: #1a1409;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
    pointer-events: none;
  }
</style>
