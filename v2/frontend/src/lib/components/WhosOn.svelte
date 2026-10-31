<script>
  // "Who's on" (permission canActivity): the counter beside the bell and its panel.
  // GET /api/activity says who has the site open, who is watching or listening to
  // what, and what the server is busy with. It refreshes every 20 s while the tab is
  // visible, when the tab comes back, and each time the panel opens.
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../api.js';
  import { navigate } from '../router.js';

  let { onopen = () => {} } = $props();
  let snap = $state(null), open = $state(false);
  let timer, destroyed = false;
  const POLL_MS = 20_000;
  const DOING = { watching: 'Watching', listening: 'Listening', browsing: 'Browsing' };

  async function load() {
    try {
      const s = await api.activity();
      if (!destroyed && s?.counts && Array.isArray(s.people)) snap = { ...s, busy: Array.isArray(s.busy) ? s.busy : [] };
    } catch { /* keep the last reading; the next poll tries again */ }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (document.visibilityState === 'visible') await load();
      if (!destroyed) schedule();
    }, POLL_MS);
  }
  const onVisible = () => { if (document.visibilityState === 'visible') load(); };
  onMount(() => { load(); schedule(); document.addEventListener('visibilitychange', onVisible); });
  onDestroy(() => { destroyed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); });

  const online = $derived(snap?.counts.online ?? 0);
  const playing = $derived((snap?.counts.watching ?? 0) + (snap?.counts.listening ?? 0));
  const label = $derived(`Who's on: ${online} ${online === 1 ? 'person' : 'people'}${playing ? `, ${playing} playing` : ''}`);

  export function close() { open = false; }
  function toggle() {
    open = !open;
    if (open) { onopen(); load(); }
  }
  function openTitle(id) { open = false; navigate(`/title/${encodeURIComponent(id)}`); }
</script>

<svelte:window
  onkeydown={(e) => { if (e.key === 'Escape') open = false; }}
  onclick={(e) => { if (!e.target.isConnected || e.target.closest?.('[data-keep-open]')) return; open = false; }} />

{#if snap}
  <div class="whoson">
    <button class="whobtn" class:live={playing > 0} aria-label={label} aria-expanded={open} title={label}
            onclick={(e) => { e.stopPropagation(); toggle(); }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c.6-3.3 3-5.3 6-5.3s5.4 2 6 5.3"/>
        <path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.6c1.8.7 3 2.4 3.4 4.9"/>
      </svg>
      <span class="wcount">{online}</span>
      {#if playing > 0}<span class="wdot" aria-hidden="true"></span>{/if}
    </button>
    {#if open}
      <div class="wpanel" role="dialog" aria-label="Who's on" data-keep-open>
        <div class="whead"><span class="meta">Who's on</span></div>
        <p class="wsum">{online} on the site · {snap.counts.watching} watching · {snap.counts.listening} listening</p>
        {#if snap.people.length}
          <div class="wlist">
            {#each snap.people as p (p.name)}
              <div class="wrow">
                <span class="wav" aria-hidden="true">{(p.name || '?').slice(0, 1)}</span>
                <span class="wtext">
                  <span class="wname">{p.name}</span>
                  <span class="wdoing">
                    <span class={`wkind ${p.doing}`}>{DOING[p.doing] || p.doing}</span>
                    {#if p.title}
                      {#if p.itemId}<button class="wtitle" onclick={() => openTitle(p.itemId)}>{p.title}</button>
                      {:else}<span class="wtitle">{p.title}</span>{/if}
                    {/if}
                  </span>
                </span>
                {#if p.percent != null}<span class="wpct">{p.percent}%</span>{/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="wempty">Nobody is on right now.</p>
        {/if}
        <div class="whead sub"><span class="meta">Busy on the server</span></div>
        {#if snap.busy.length}
          <div class="wjobs">
            {#each snap.busy as b (b.key)}
              <div class="wbusy"><span>{b.label}</span><strong>{b.detail}</strong></div>
            {/each}
          </div>
        {:else}
          <p class="wempty">Nothing else is running.</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .whoson { position: relative; flex-shrink: 0; margin-right: var(--s2); }
  .whobtn {
    position: relative;
    height: 34px; padding: 0 10px 0 8px; border-radius: 99px;
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--ink-soft); font-size: 0.85rem; font-weight: 700; font-variant-numeric: tabular-nums;
    box-shadow: inset 0 0 0 1px var(--line);
    transition: color var(--t-fast), background var(--t-fast), box-shadow var(--t-fast);
  }
  .whobtn:hover { color: var(--ink); background: rgba(243, 237, 228, 0.1); }
  .whobtn.live { color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
  .wdot {
    position: absolute; top: 3px; right: 3px;
    width: 7px; height: 7px; border-radius: 99px;
    background: var(--good); box-shadow: 0 0 0 2px var(--bg);
  }
  .wpanel {
    position: absolute; top: 44px; right: 0; z-index: 60;
    width: 340px; max-width: 86vw;
    background: rgb(25, 22, 20);
    border-radius: var(--r-md); overflow: hidden;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-strong);
  }
  .whead { padding: var(--s3) var(--s3) var(--s1); }
  .whead.sub { border-top: 1px solid var(--line); margin-top: var(--s2); }
  .wsum { padding: 0 var(--s3) var(--s2); font-size: 0.82rem; color: var(--ink-soft); }
  .wlist { max-height: 40vh; overflow-y: auto; }
  .wrow {
    display: flex; align-items: center; gap: var(--s3);
    padding: var(--s2) var(--s3);
    border-top: 1px solid var(--line);
  }
  .wav {
    flex: 0 0 28px; width: 28px; height: 28px; border-radius: 99px;
    display: grid; place-items: center;
    background: var(--bg); color: var(--ink-soft);
    font-size: 0.8rem; font-weight: 800; text-transform: uppercase;
  }
  .wtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .wname { font-size: 0.88rem; font-weight: 600; color: var(--ink); }
  .wdoing { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 0.78rem; color: var(--ink-soft); }
  .wkind { flex-shrink: 0; font-weight: 600; }
  .wkind.watching, .wkind.listening { color: var(--good); }
  .wkind.browsing { color: var(--ink-faint); }
  .wtitle {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--ink-soft); text-align: left; font: inherit;
  }
  button.wtitle:hover { color: var(--ink); text-decoration: underline; }
  .wpct { flex: 0 0 auto; font-size: 0.75rem; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .wjobs { padding-bottom: var(--s2); }
  .wbusy {
    display: flex; justify-content: space-between; gap: var(--s3);
    padding: 6px var(--s3); font-size: 0.82rem; color: var(--ink-soft);
  }
  .wbusy strong { font-weight: 600; color: var(--ink); text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wempty { padding: var(--s2) var(--s3) var(--s3); font-size: 0.82rem; color: var(--ink-faint); }

  @media (max-width: 720px) {
    .whobtn { height: 44px; }
    .wpanel { position: fixed; left: var(--s4); right: var(--s4); top: 60px; width: auto; max-width: none; }
  }
</style>
