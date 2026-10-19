<script>
  // The player's bottom bar: scrubber with seek preview, transport, volume,
  // episode navigation and the subtitle/audio/speed/quality menus. It shows
  // what it is given and reports actions; Player.svelte owns playback.
  // `openMenu` and `scrubbing` are shared: the player closes menus on Escape or
  // a click on the video, and pauses its watchdogs and up-next while scrubbing.
  import { fmtTime } from '../player-core.js';
  import { episodeCode } from '../format.js';
  import { spriteThumbStyle } from '../sprite-thumb.js';

  let {
    itemId, total, cur, bufferedEnd, sprite, paused, muted, volume,
    prev, next, subtitles, subIdx, audioTracks, audioTrack, isDirect, speed, quality,
    openMenu = $bindable(''), scrubbing = $bindable(false),
    onseek, ontoggleplay, ontogglemute, onvolume, onprev, onnext, onsub, onaudio, onspeed, onquality, onfullscreen,
  } = $props();

  const QUALITIES = [
    { key: 'low', label: 'Data Saver (720p, up to 2 Mbps)' },
    { key: 'auto', label: 'Auto (1080p)' },
    { key: 'high', label: 'Full quality (up to 4K)' },
  ];
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

  let scrubTarget = $state(0);
  let hoverT = $state(-1);
  let hoverX = $state(0);
  const shownTime = $derived(scrubbing ? scrubTarget : cur);
  // What the scrub thumbnail/clock is aiming at: the drag target while
  // dragging, the pointer position while merely hovering.
  const previewT = $derived(scrubbing ? scrubTarget : hoverT);

  let bar = $state(null);
  function barTime(clientX) {
    const r = bar.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return p * total;
  }
  // Keep the preview pinned to the pointer for both hover and drag — a
  // thumbnail that vanishes the moment you press down is missing at exactly
  // the moment you're using it to aim (and touch never hovers at all).
  function trackPointer(clientX) {
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    hoverX = Math.max(124, Math.min(r.width - 124, clientX - r.left));
  }
  function barDown(e) {
    if (!total) return;
    scrubbing = true;
    scrubTarget = barTime(e.clientX);
    trackPointer(e.clientX);
    bar.setPointerCapture(e.pointerId);
  }
  function barMove(e) {
    if (scrubbing) {
      scrubTarget = barTime(e.clientX);
      trackPointer(e.clientX);
    } else if (total) {
      hoverT = barTime(e.clientX);
      trackPointer(e.clientX);
    }
  }
  function barUp(e) {
    if (!scrubbing) return;
    scrubbing = false;
    onseek(barTime(e.clientX));
  }
</script>

<div class="controls">
  <!-- Scrubber -->
  <!-- Arrow keys seek through the player's own key handler. -->
  <div class="scrub" bind:this={bar} role="slider" tabindex="0" aria-label="Seek"
       aria-valuemin="0" aria-valuemax={Math.round(total || 0)} aria-valuenow={Math.round(shownTime || 0)}
       aria-valuetext={`${fmtTime(shownTime)} of ${fmtTime(total)}`}
       onpointerdown={barDown} onpointermove={barMove} onpointerup={barUp}
       onpointerleave={() => { hoverT = -1; }}>
    <div class="rail">
      <div class="buffered" style={`width:${total ? Math.min(100, (bufferedEnd / total) * 100) : 0}%`}></div>
      <div class="filled" style={`width:${total ? Math.min(100, (shownTime / total) * 100) : 0}%`}></div>
      <div class="knob" style={`left:${total ? Math.min(100, (shownTime / total) * 100) : 0}%`}></div>
    </div>
    {#if scrubbing || hoverT >= 0}
      <div class="hoverwrap" style={`left:${hoverX}px`}>
        {#if sprite}
          <div class="hoverthumb" style={spriteThumbStyle(sprite, previewT, itemId)}></div>
        {/if}
        <div class="hovertime">{fmtTime(previewT)}</div>
      </div>
    {/if}
  </div>

  <div class="buttons">
    <div class="zone zleft">
      <span class="time">{fmtTime(shownTime)} / {fmtTime(total)}</span>
    </div>

    <div class="zone zcenter">
      <button class="iconbtn skip" onclick={() => onseek(cur - 10)} aria-label="Back 10 seconds">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/><text x="9" y="16.5" font-size="7" font-weight="700" fill="currentColor" stroke="none">10</text></svg>
      </button>
      <button class="iconbtn playbtn" onclick={ontoggleplay} aria-label={paused ? 'Play' : 'Pause'}>
        {#if paused}
          <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        {/if}
      </button>
      <button class="iconbtn skip" onclick={() => onseek(cur + 10)} aria-label="Forward 10 seconds">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M12 5V1l5 5-5 5V7c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z"/><text x="9" y="16.5" font-size="7" font-weight="700" fill="currentColor" stroke="none">10</text></svg>
      </button>
      <div class="vol">
        <button class="iconbtn" onclick={ontogglemute} aria-label={muted ? 'Unmute' : 'Mute'}>
          {#if muted || volume === 0}
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          {/if}
        </button>
        <input type="range" min="0" max="150" step="2" value={muted ? 0 : volume}
               oninput={(e) => onvolume(parseFloat(e.target.value))}
               aria-label="Volume (over 100 boosts)" />
        <span class="pct" class:boost={volume > 100 && !muted}>{muted ? 0 : volume}%</span>
      </div>
    </div>

    <div class="zone zright">
    {#if prev || next}<div class="episode-nav" aria-label="Episode navigation">
    {#if prev}
      <button class="nextbtn prevbtn" onclick={() => onprev(prev)} aria-label={`Previous episode ${episodeCode(prev)}`} title={`Previous — ${episodeCode(prev)}`}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18 18l-8.5-6L18 6v12zM8 6v12H6V6h2z"/></svg>
        Prev <strong>{episodeCode(prev)}</strong>
      </button>
    {/if}
    {#if next}
      <button class="nextbtn" onclick={() => onnext(next)} aria-label={`Next episode ${episodeCode(next)}`} title={`Next — ${episodeCode(next)}`}>
        Next <strong>{episodeCode(next)}</strong>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
      </button>
    {/if}

    </div>{/if}

    {#if subtitles?.length}
      <div class="menuwrap">
        <button class="iconbtn" class:on={subIdx >= 0} aria-label="Subtitles"
                onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'subs' ? '' : 'subs'; }}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>
        </button>
        {#if openMenu === 'subs'}
          <div class="menu">
            <button class:active={subIdx === -1} onclick={() => onsub(-1)}>Off</button>
            {#each subtitles as s, i (s.url)}
              <button class:active={subIdx === i} onclick={() => onsub(i)}>{s.label}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if !isDirect && audioTracks?.length > 1}
      <div class="menuwrap">
        <button class="iconbtn" aria-label="Audio track"
                onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'audio' ? '' : 'audio'; }}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1a7 7 0 0 1 14 0v1h-4v8h4c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z"/></svg>
        </button>
        {#if openMenu === 'audio'}
          <div class="menu">
            {#each audioTracks as a (a.index)}
              <button class:active={audioTrack === a.index || (audioTrack == null && a.isDefault)}
                      aria-pressed={audioTrack === a.index || (audioTrack == null && a.isDefault)}
                      onclick={() => onaudio(a.index)}>{a.label}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Speed is a property of the video element, so it applies to direct
         play and transcoded streams alike — not gated on !isDirect. -->
    <div class="menuwrap">
      <button class="iconbtn speedbtn" aria-label="Playback speed"
              onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'speed' ? '' : 'speed'; }}>
        <span class:on={speed !== 1}>{speed}×</span>
      </button>
      {#if openMenu === 'speed'}
        <div class="menu">
          {#each SPEEDS as s (s)}
            <button class:active={speed === s} onclick={() => onspeed(s)}>{s === 1 ? 'Normal' : `${s}×`}</button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Quality applies to every video: Data Saver also caps files that would
         otherwise play directly. -->
    <div class="menuwrap">
      <button class="iconbtn" aria-label="Quality"
              onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'quality' ? '' : 'quality'; }}>
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.61 3.61 0 0 1 8.4 12c0-1.98 1.62-3.6 3.6-3.6s3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
      </button>
      {#if openMenu === 'quality'}
        <div class="menu">
          {#each QUALITIES as q (q.key)}
            <button class:active={quality === q.key} onclick={() => onquality(q.key)}>{q.label}</button>
          {/each}
        </div>
      {/if}
    </div>

    <button class="iconbtn" onclick={onfullscreen} aria-label="Fullscreen">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
    </button>
    </div>
  </div>
</div>

<style>
  .controls {
    position: absolute; left: 0; right: 0; bottom: 0;
    padding: 0 max(var(--s4), env(safe-area-inset-right))
             max(var(--s3), env(safe-area-inset-bottom)) max(var(--s4), env(safe-area-inset-left));
    background: linear-gradient(transparent, rgba(0,0,0,0.85));
    transition: opacity var(--t-med);
  }
  /* Hidden with the rest of the chrome while the player is idle. */
  :global(.player.idle) .controls { opacity: 0; pointer-events: none; }

  .scrub { position: relative; padding: 12px 0 8px; cursor: pointer; touch-action: none; }
  .rail {
    position: relative; height: 4px;
    background: rgba(243, 237, 228, 0.22); border-radius: 99px;
    transition: height var(--t-fast);
  }
  .scrub:hover .rail { height: 6px; }
  .buffered { position: absolute; inset: 0 auto 0 0; background: rgba(243, 237, 228, 0.35); border-radius: 99px; }
  .filled { position: absolute; inset: 0 auto 0 0; background: #fff; border-radius: 99px; }
  .knob {
    position: absolute; top: 50%; width: 14px; height: 14px;
    transform: translate(-50%, -50%) scale(0);
    background: #fff; border-radius: 99px;
    transition: transform var(--t-fast);
  }
  .scrub:hover .knob { transform: translate(-50%, -50%) scale(1); }
  .hoverwrap {
    position: absolute; bottom: 22px; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 5px;
    pointer-events: none;
  }
  .hoverthumb {
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7), 0 0 0 1.5px rgba(243, 237, 228, 0.35);
    background-color: #000;
  }
  .hovertime {
    background: rgba(0, 0, 0, 0.85); color: #fff;
    font-size: 0.78rem; font-weight: 600; font-variant-numeric: tabular-nums;
    padding: 3px 8px; border-radius: 5px;
  }

  .buttons {
    display: grid; grid-template-columns: 1fr auto 1fr;
    align-items: center; gap: var(--s2);
  }
  .zone { display: flex; align-items: center; gap: var(--s2); min-width: 0; }
  .zleft { justify-self: start; }
  .zcenter { justify-self: center; gap: var(--s3); }
  .zright { justify-self: end; }
  .episode-nav {display:flex;align-items:center;gap:var(--s2);}
  .iconbtn, .nextbtn {flex-shrink:0;}
  .iconbtn {
    display: grid; place-items: center;
    width: 42px; height: 42px; border-radius: 99px;
    color: var(--ink);
    transition: background var(--t-fast), transform var(--t-fast);
  }
  .iconbtn:hover { background: rgba(243, 237, 228, 0.12); }
  .iconbtn.on { color: var(--star); }
  .iconbtn.skip { width: 48px; height: 48px; }
  .iconbtn.playbtn { width: 54px; height: 54px; }
  .time {
    font-size: 0.86rem; color: var(--ink-soft); font-weight: 500;
    font-variant-numeric: tabular-nums; margin-left: var(--s2);
    white-space: nowrap;
  }

  /* Volume lives in the centered cluster — keep its width constant so the
     transport never shifts under the pointer. */
  .vol { display: flex; align-items: center; gap: 6px; margin-left: var(--s2); }
  .vol input[type='range'] {
    width: 100px;
    accent-color: #fff; background: transparent; border: none; padding: 0;
  }
  .pct {
    font-size: 0.78rem; font-weight: 700; color: var(--ink-soft);
    font-variant-numeric: tabular-nums; min-width: 4ch;
  }
  .pct.boost { color: #6db3ff; }

  .nextbtn {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(243, 237, 228, 0.14); color: var(--ink);
    font-size: 0.88rem; font-weight: 600;
    padding: 9px 16px; border-radius: 99px;
    transition: background var(--t-fast);
    white-space: nowrap;
  }
  .nextbtn:hover { background: rgba(243, 237, 228, 0.24); }

  /* Speed reads as a value, not a glyph, so it gets type instead of an icon.
     It stays dim at 1x and lights up when you've changed it — the control
     should be able to tell you it's on without opening the menu. */
  .speedbtn span {
    font-size: 0.82rem; font-weight: 700; letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  .speedbtn span.on { color: #6db3ff; }

  .menuwrap { position: relative; }
  .menu {
    position: absolute; bottom: 52px; right: 0; z-index: 5;
    min-width: 180px; max-height: 40vh; overflow-y: auto;
    background: rgba(25, 22, 20, 0.98);
    border-radius: var(--r-md); padding: var(--s2);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-strong);
    display: flex; flex-direction: column; gap: 2px;
  }
  .menu button {
    text-align: left; font-size: 0.9rem; font-weight: 500;
    padding: 9px 12px; border-radius: var(--r-sm); color: var(--ink-soft);
    transition: background var(--t-fast), color var(--t-fast);
    white-space: nowrap;
  }
  .menu button:hover { background: rgba(243, 237, 228, 0.1); color: var(--ink); }
  .menu button.active { color: var(--ink); background: rgba(243, 237, 228, 0.14); font-weight: 600; }

  /* The desktop's centered cluster cannot share a single row with episode
     navigation on phones. Give each group real layout space, not overlap. */
  @media (max-width: 1400px) {
    .buttons {grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;}
    .zleft {grid-column:1;grid-row:1;}
    .zcenter {grid-column:2;grid-row:1;justify-self:end;gap:8px;}
    .zright {grid-column:1 / -1;grid-row:2;justify-self:stretch;justify-content:flex-end;flex-wrap:wrap;gap:6px;}
    .nextbtn strong {display:none;}
    .vol input[type='range'], .pct {display:none;}
    .iconbtn {width:44px;height:44px;}
    .iconbtn.skip {width:44px;height:44px;}
    .iconbtn.playbtn {width:48px;height:48px;}
    .nextbtn {min-height:44px;padding:8px 14px;}
    .episode-nav {margin-right:auto;}
    .time {margin-left:0;font-size:.75rem;}
    .scrub {padding:16px 0;}
    .menu {position:fixed;left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));bottom:calc(64px + env(safe-area-inset-bottom));max-height:45dvh;min-width:0;}
    .menu button {min-height:44px;white-space:normal;overflow-wrap:anywhere;}
  }
  @media (max-width: 640px) {
    .controls {padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right));}
    .buttons {grid-template-columns:minmax(0,1fr);gap:4px;}
    .zleft {grid-column:1;grid-row:1;justify-self:center;}
    .zcenter {grid-column:1;grid-row:2;justify-self:center;gap:12px;}
    .zright {grid-column:1;grid-row:3;justify-content:center;}
    .episode-nav {flex-basis:100%;justify-content:center;margin:0;gap:12px;}
    .episode-nav .nextbtn {min-width:110px;justify-content:center;}
    .vol {margin-left:4px;}
  }
</style>
