<script>
  // The card in the player's bottom-right corner near the end of an episode:
  // "Up next" with a countdown when there is a next episode, or "That's the
  // last one" at the end of a series. Player.svelte decides when it shows.
  import { posterUrl, backdropUrl } from '../api.js';
  import { episodeCode, episodeTitle } from '../format.js';

  let { next = null, title = '', secondsLeft = 0, lifted = false, onplay, oncancel, onclose } = $props();
  const art = $derived(next ? posterUrl(next) || backdropUrl(next) : null);
</script>

{#if next}
  <div class="upnext" class:lifted>
    {#if art}
      <img class="unart" src={art} alt="" loading="lazy" decoding="async" />
    {/if}
    <div class="unbody">
      <span class="unlabel">Up next in {secondsLeft}s</span>
      <span class="untitle">{episodeCode(next)}</span>
      <span class="unsub">{episodeTitle(next)}</span>
      <div class="unrow">
        <button class="unplay" onclick={onplay}>Play now</button>
        <button class="uncancel" onclick={oncancel}>Cancel</button>
      </div>
    </div>
  </div>
{:else}
  <div class="upnext" class:lifted>
    <div class="unbody">
      <span class="unlabel">That's the last one</span>
      <span class="untitle">{title}</span>
      <span class="unsub">You've reached the end of what's here.</span>
      <div class="unrow">
        <button class="unplay" onclick={onclose}>Back to browse</button>
        <button class="uncancel" onclick={oncancel}>Keep watching</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Up-next card: same bottom-right corner as Skip Intro. They can never be
     on screen together (one is the first minute, the other the last). */
  .upnext {
    position: absolute; right: max(var(--s4), env(safe-area-inset-right)); bottom: 12%;
    z-index: 6;
    display: flex; gap: var(--s3); align-items: stretch;
    width: min(400px, calc(100vw - 2 * var(--s4)));
    padding: var(--s3);
    background: rgba(11, 11, 14, 0.92);
    border-radius: var(--r-md);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-strong);
    transition: bottom var(--t-med);
    animation: skipin var(--t-med) var(--ease);
  }
  .upnext.lifted { bottom: max(17%, 108px); }
  .unart {
    width: 64px; flex: 0 0 64px;
    object-fit: cover; border-radius: var(--r-sm);
    background: var(--bg-raised);
  }
  .unbody { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .unlabel {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--ink-faint);
  }
  .untitle { font-size: 0.95rem; font-weight: 700; }
  .unsub {
    font-size: 0.8rem; color: var(--ink-soft);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .unrow { display: flex; gap: var(--s2); margin-top: var(--s2); }
  .unplay, .uncancel {
    font-size: 0.84rem; font-weight: 600;
    padding: 7px 16px; border-radius: 99px; cursor: pointer;
    transition: background var(--t-fast);
  }
  .unplay { background: var(--cta); color: var(--cta-ink); }
  .unplay:hover { background: var(--ink); }
  .uncancel { background: rgba(242, 242, 244, 0.14); color: var(--ink); }
  .uncancel:hover { background: rgba(242, 242, 244, 0.26); }

  @media (max-width: 560px) {
    .upnext { left: var(--s4); width: auto; }
    .unart { width: 48px; flex-basis: 48px; }
  }

  @keyframes skipin {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (max-width: 1400px) {
    .upnext.lifted {bottom:calc(155px + env(safe-area-inset-bottom));}
  }
  @media (max-width: 640px) {
    .upnext.lifted {bottom:calc(240px + env(safe-area-inset-bottom));}
  }
</style>
