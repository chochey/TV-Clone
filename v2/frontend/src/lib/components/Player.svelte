<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, streamUrl } from '../api.js';
  import { library, session } from '../stores.js';
  import { loadHls, parseVtt, cueAt, fmtTime } from '../player-core.js';
  import { episodeCode, episodeTitle } from '../format.js';

  // Remounted per item via {#key} in App — `item` is static for this mount.
  let { item, next = null, prev = null, onclose, onnext, onprev } = $props();

  const isDirect = item.streamMode === 'direct';
  const title = $derived(item.showName || item.title || '');
  const subline = $derived(item.showName ? `${episodeCode(item)} — ${episodeTitle(item)}` : (item.year || ''));

  let video = $state(null);
  let full = $state(null);        // /api/item record: subtitles, offset, audioTracks
  let error = $state('');
  let notice = $state('');        // transient status (busy-retry), not fatal
  let buffering = $state(true);
  let paused = $state(true);
  let cur = $state(0);            // real timeline position (offset + video time)
  let videoDur = $state(0);
  let bufferedEnd = $state(0);    // real timeline
  let seekOffset = $state(0);     // HLS session start offset
  let totalDur = $state(0);       // from X-Total-Duration
  let volume = $state(100); // percent, 0–150; >100 engages the WebAudio booster
  let muted = $state(false);
  let quality = $state(localStorage.getItem('v2Quality') || 'auto');
  let audioTrack = $state(null);
  let subIdx = $state(-1);
  let cues = $state([]);
  let cueText = $state('');
  let controlsOn = $state(true);
  let scrubbing = $state(false);
  let scrubTarget = $state(0);
  let hoverT = $state(-1);
  let hoverX = $state(0);
  let openMenu = $state('');

  const QUALITIES = [
    { key: 'low', label: 'Data Saver' },
    { key: 'auto', label: 'Auto' },
    { key: 'high', label: 'High' },
  ];

  const total = $derived(totalDur || (isDirect ? videoDur : seekOffset + videoDur));
  const shownTime = $derived(scrubbing ? scrubTarget : cur);

  let hls = null;
  let loadSeq = 0;
  let hlsRetries = 0;
  let pausedAt = 0;        // when the user paused — long pauses outlive the server session
  let recoverAttempts = 0; // consecutive dead-session restarts without playback progress
  let recoverFromT = -1;   // position of the last auto-restart
  let root = $state(null);
  let progressTimer = null;
  let idleTimer = null;

  // ── Media loading ───────────────────────────────────────────────────
  function destroyHls() {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
  }

  function loadDirect(start) {
    video.src = streamUrl(item);
    if (start > 0) {
      const fallback = setTimeout(() => { video.currentTime = start; video.play().catch(() => {}); }, 5000);
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(fallback);
        video.currentTime = start;
        video.play().catch(() => {});
      }, { once: true });
    } else {
      video.play().catch(() => {});
    }
  }

  let busyRetries = 0;
  let retryTimer = null;
  async function loadHlsSession(start) {
    const seq = ++loadSeq;
    clearTimeout(retryTimer);
    buffering = true;
    let H;
    try { H = await loadHls(); } catch { error = 'Failed to load the video engine.'; return; }
    const params = new URLSearchParams({ start: String(start), quality });
    if (audioTrack != null) params.set('audio', String(audioTrack));
    const url = `/hls/${encodeURIComponent(item.id)}/master.m3u8?${params}`;

    // Warm the ffmpeg session and read the duration/offset headers; hls.js
    // then re-fetches the same URL and hits the session-reuse fast path.
    let r;
    try { r = await fetch(url, { credentials: 'same-origin' }); }
    catch { if (seq === loadSeq) error = 'Could not reach the server.'; return; }
    if (seq !== loadSeq) return; // stale seek
    if (!r.ok) {
      if (r.status === 503 && busyRetries < 3) {
        // All transcode slots taken — they free up fast now that closing a
        // player kills its session, so retry quietly a few times.
        busyRetries++;
        notice = `All transcode slots are busy — retrying (${busyRetries}/3)…`;
        retryTimer = setTimeout(() => { if (seq === loadSeq) loadHlsSession(start); }, 5000);
        return;
      }
      error = r.status === 503
        ? 'The server is busy with other streams right now — try again in a moment.'
        : `Stream failed to start (${r.status}).`;
      return;
    }
    busyRetries = 0;
    notice = '';
    totalDur = parseFloat(r.headers.get('X-Total-Duration')) || totalDur;
    seekOffset = parseFloat(r.headers.get('X-Seek-Offset')) || start || 0;
    cur = seekOffset;

    destroyHls();
    video.removeAttribute('src');
    video.load();
    bufferedEnd = seekOffset;
    hlsRetries = 0;

    // Config mirrors v1's battle-tested setup (public/app.js): treat the
    // EVENT playlist as VOD from segment 0, start loading only after the
    // manifest parses, play once canplaythrough fires.
    hls = new H({
      maxBufferLength: 30, maxMaxBufferLength: 120, startFragPrefetch: true,
      startPosition: 0,
      highBufferWatchdogPeriod: 2, nudgeOffset: 0.2, nudgeMaxRetry: 5, enableWorker: true,
      fragLoadingTimeOut: 30000, fragLoadingMaxRetry: 4, fragLoadingRetryDelay: 1000,
      autoStartLoad: false,
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(H.Events.MANIFEST_PARSED, () => {
      if (seq !== loadSeq) return;
      video.addEventListener('canplaythrough', () => { video.play().catch(() => {}); }, { once: true });
      hls.startLoad();
    });
    hls.on(H.Events.ERROR, async (_e, data) => {
      if (!data.fatal) return;
      hlsRetries++;
      if (hlsRetries > 3) { error = 'Playback failed after several retries.'; return; }
      if (data.type === H.ErrorTypes.NETWORK_ERROR) {
        // Segments 404 forever once the server reaped the session — only a
        // fresh session at the current position can revive playback.
        if (await sessionDead()) { if (seq === loadSeq) recoverSession(); return; }
        if (seq === loadSeq) hls.startLoad();
      } else if (data.type === H.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    });
  }

  // ── Dead-session recovery: the server reaps idle transcode sessions after
  // 2 minutes, so a pause longer than that (or a server restart) leaves
  // hls.js asking for segments that no longer exist — the video plays out
  // its buffer and then freezes until a page refresh. Restarting the session
  // at the current position is the same path a long seek takes; we just
  // have to notice that we need it. ──
  async function sessionDead() {
    try {
      const r = await fetch(`/api/hls/${encodeURIComponent(item.id)}/alive`, { credentials: 'same-origin' });
      if (!r.ok) return false;
      return !(await r.json()).alive;
    } catch { return false; }
  }
  function recoverSession() {
    if (recoverAttempts >= 3) { error = 'Playback failed after several retries.'; return; }
    recoverAttempts++;
    recoverFromT = cur;
    loadHlsSession(cur);
  }
  async function resumeCheck() {
    // Only worth checking after a pause long enough that the session might
    // be gone (server reaps at 2min idle; 60s leaves margin for clock skew).
    const wasPausedFor = pausedAt ? Date.now() - pausedAt : 0;
    pausedAt = 0;
    if (isDirect || wasPausedFor < 60_000) return;
    if (await sessionDead()) {
      if (video?.paused) return; // paused again while we were checking
      recoverSession();
    }
  }

  function seekTo(t) {
    if (!total) return;
    t = Math.max(0, Math.min(t, Math.max(0, total - 1)));
    if (isDirect) {
      video.currentTime = t;
      cur = t;
      return;
    }
    // Short skips shouldn't restart ffmpeg. Everything the session has
    // already transcoded (from seekOffset to the seekable edge) is
    // native-seekable inside the video element — instant, no re-buffer.
    // The grace window covers "just ahead of the edge": ffmpeg encodes
    // faster than realtime, so a target ~15s past the edge arrives within
    // a few seconds — a brief spinner beats a 10s session restart.
    const local = t - seekOffset;
    let withinSession = false;
    if (local >= 0 && video?.seekable?.length) {
      withinSession = local <= video.seekable.end(video.seekable.length - 1) + 15;
    }
    if (withinSession) {
      video.currentTime = local;
      cur = t;
    } else {
      cur = t;
      loadHlsSession(t);
    }
  }

  // ── Progress sync (v1 contract: every 5s + on pause/close/ended) ────
  function saveProgress(ended = false) {
    if (!total) return;
    const t = ended ? total : cur;
    const pct = Math.round((t / total) * 100);
    api.progress({ id: item.id, currentTime: t, duration: total, profile: $session?.profileId });
    const prog = { currentTime: t, duration: total, percent: pct, updatedAt: Date.now() };
    library.update((list) => list.map((i) => (i.id === item.id ? { ...i, progress: prog } : i)));
  }

  // ── Subtitles: custom cue rendering so HLS session restarts (video
  // timeline resets to 0) can't desync the text — we track real time. ──
  let subSeq = 0;
  async function setSub(i) {
    subIdx = i;
    cues = [];
    cueText = '';
    openMenu = '';
    const seq = ++subSeq;
    if (i < 0 || !full?.subtitles?.[i]) return;
    try {
      const r = await fetch(full.subtitles[i].url, { credentials: 'same-origin' });
      const text = await r.text();
      if (seq === subSeq) cues = parseVtt(text);
    } catch {}
  }

  // ── Menus / controls chrome ─────────────────────────────────────────
  function setQuality(q) {
    quality = q;
    localStorage.setItem('v2Quality', q);
    openMenu = '';
    if (!isDirect) loadHlsSession(cur);
  }
  function setAudio(idx) {
    audioTrack = idx;
    openMenu = '';
    loadHlsSession(cur);
  }

  function poke() {
    controlsOn = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!paused && !openMenu && !scrubbing) controlsOn = false; }, 3000);
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  // ── Volume: 0–100 native, 101–150 through a WebAudio gain stage ──────
  let audioCtx = null, gainNode = null;
  function ensureBoostGraph() {
    if (audioCtx || !video) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      const src = audioCtx.createMediaElementSource(video);
      gainNode = audioCtx.createGain();
      src.connect(gainNode);
      gainNode.connect(audioCtx.destination);
    } catch { audioCtx = null; gainNode = null; }
  }
  function setVolume(pct) {
    volume = Math.max(0, Math.min(150, Math.round(pct)));
    const v = volume / 100;
    video.volume = Math.min(1, v);
    muted = volume === 0;
    video.muted = muted;
    if (v > 1) ensureBoostGraph(); // lazily route audio through the booster
    if (gainNode) gainNode.gain.value = muted ? 0 : Math.max(1, v);
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    localStorage.setItem('playerVolumePct', String(volume));
  }
  function toggleMute() {
    muted = !muted;
    video.muted = muted;
    if (gainNode) gainNode.gain.value = muted ? 0 : Math.max(1, volume / 100);
  }

  // ── Touch: double-tap left/right half seeks ±10s; single tap toggles.
  // Desktop keeps click = play/pause, double-click = fullscreen. Synthetic
  // click/dblclick events that follow a touch are suppressed. ──
  let lastTouchTap = 0;
  let touchTapTimer = null;
  let touchRecently = false;
  function onVideoPointerUp(e) {
    if (e.pointerType !== 'touch') return;
    touchRecently = true;
    setTimeout(() => { touchRecently = false; }, 600);
    const now = Date.now();
    if (now - lastTouchTap < 320) {
      clearTimeout(touchTapTimer);
      lastTouchTap = 0;
      const mid = window.innerWidth / 2;
      seekTo(cur + (e.clientX > mid ? 10 : -10));
      poke();
    } else {
      lastTouchTap = now;
      clearTimeout(touchTapTimer);
      touchTapTimer = setTimeout(() => { togglePlay(); poke(); }, 320);
    }
  }
  function onVideoClick() {
    if (touchRecently) return;
    togglePlay();
    poke();
  }
  function onVideoDblClick() {
    if (touchRecently) return;
    toggleFullscreen();
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root?.requestFullscreen().catch(() => {});
  }
  function close() {
    saveProgress();
    onclose?.();
  }
  function handleEnded() {
    saveProgress(true);
    if (next) onnext?.(next);
    else onclose?.();
  }

  // ── Seek-preview sprites (v1's sheets: cols×rows tiles, one per
  // interval seconds; generate-on-demand, poll while the server bakes) ──
  let sprite = $state(null); // {totalSheets, cols, rows, width, height, interval}
  let spritePollTimer = null;
  let spritePreloaded = false;
  function preloadSheets(meta) {
    for (let s = 0; s < meta.totalSheets; s++) {
      const img = new Image();
      img.src = `/api/sprites/${encodeURIComponent(item.id)}/${s}`;
    }
  }
  async function loadSprites() {
    try {
      const r = await fetch(`/api/sprites/${encodeURIComponent(item.id)}/generate`, { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      // Use the meta as soon as it exists (v1 does the same): sheets that are
      // already on disk preview immediately, missing ones 404 to a black tile
      // and pop in on the next poll. Waiting for 'ready' meant files whose
      // last sheet can never bake showed no previews at all.
      if (data.totalSheets > 0 && !sprite) sprite = data;
      if (data.status === 'ready') {
        sprite = data;
        preloadSheets(data);
      } else {
        if (!spritePreloaded && data.totalSheets > 0) {
          spritePreloaded = true;
          preloadSheets(data);
        }
        spritePollTimer = setTimeout(loadSprites, 5000);
      }
    } catch {}
  }
  function thumbStyle(t) {
    const per = sprite.cols * sprite.rows;
    const fi = Math.min(Math.floor(t / sprite.interval), sprite.totalSheets * per - 1);
    const sheet = Math.floor(fi / per);
    const pos = fi % per;
    const col = pos % sprite.cols;
    const row = Math.floor(pos / sprite.cols);
    return `background-image:url(/api/sprites/${encodeURIComponent(item.id)}/${sheet});` +
      `background-size:${sprite.cols * sprite.width}px ${sprite.rows * sprite.height}px;` +
      `background-position:-${col * sprite.width}px -${row * sprite.height}px;` +
      `width:${sprite.width}px;height:${sprite.height}px`;
  }

  // ── Scrubber ────────────────────────────────────────────────────────
  let bar = $state(null);
  function barTime(clientX) {
    const r = bar.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return p * total;
  }
  function barDown(e) {
    if (!total) return;
    scrubbing = true;
    scrubTarget = barTime(e.clientX);
    bar.setPointerCapture(e.pointerId);
  }
  function barMove(e) {
    if (scrubbing) scrubTarget = barTime(e.clientX);
    else if (total) {
      hoverT = barTime(e.clientX);
      const r = bar.getBoundingClientRect();
      hoverX = Math.max(40, Math.min(r.width - 40, e.clientX - r.left));
    }
  }
  function barUp(e) {
    if (!scrubbing) return;
    scrubbing = false;
    seekTo(barTime(e.clientX));
  }

  function onKey(e) {
    if (e.target.closest('input')) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); poke(); break;
      case 'ArrowLeft': e.preventDefault(); seekTo(cur - 10); poke(); break;
      case 'ArrowRight': e.preventDefault(); seekTo(cur + 10); poke(); break;
      case 'ArrowUp': e.preventDefault(); setVolume(volume + 5); poke(); break;
      case 'ArrowDown': e.preventDefault(); setVolume(volume - 5); poke(); break;
      case 'm': toggleMute(); poke(); break;
      case 'f': toggleFullscreen(); poke(); break;
      case 'Escape':
        if (openMenu) openMenu = '';
        else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else close();
        break;
    }
  }

  onMount(async () => {
    document.body.style.overflow = 'hidden';
    // Prefer the percent key; migrate from the old 0–1 'playerVolume'.
    let savedPct = parseFloat(localStorage.getItem('playerVolumePct'));
    if (isNaN(savedPct)) {
      const legacy = parseFloat(localStorage.getItem('playerVolume'));
      savedPct = isNaN(legacy) ? 100 : legacy * 100;
    }
    volume = Math.max(0, Math.min(150, Math.round(savedPct)));
    muted = volume === 0;
    video.volume = Math.min(1, volume / 100);
    video.muted = muted;
    // Note: the boost graph is only built when the user pushes past 100.

    // Full record: fresh resume point, subtitles, sync offset, audio tracks.
    try { full = await api.item(item.id); } catch { full = null; }
    const prog = full?.progress || item.progress || {};
    const start = (prog.percent || 0) >= 95 ? 0 : (prog.currentTime > 5 ? prog.currentTime : 0);
    cur = start;

    if (isDirect) { seekOffset = 0; loadDirect(start); }
    else loadHlsSession(start);

    loadSprites();
    progressTimer = setInterval(() => { if (!paused) saveProgress(); }, 5000);
    poke();
  });

  onDestroy(() => {
    clearInterval(progressTimer);
    clearTimeout(idleTimer);
    clearTimeout(retryTimer);
    clearTimeout(touchTapTimer);
    clearTimeout(spritePollTimer);
    saveProgress();
    loadSeq++; // invalidate in-flight session loads
    destroyHls();
    // Free the transcode slot immediately instead of waiting out the
    // server's 2-minute idle timeout (the main source of 503s).
    if (!isDirect) {
      try { navigator.sendBeacon(`/api/hls/${encodeURIComponent(item.id)}/stop`); } catch {}
    }
    if (audioCtx) { try { audioCtx.close(); } catch {} }
    document.body.style.overflow = '';
  });

  function onTimeUpdate() {
    if (!video) return;
    cur = seekOffset + video.currentTime;
    // Real forward progress clears the dead-session recovery budget.
    if (recoverAttempts && cur > recoverFromT + 3) recoverAttempts = 0;
    if (cues.length) cueText = cueAt(cues, cur - (full?.subtitleOffset || 0));
    else cueText = '';
  }
  function onProgress() {
    if (!video || !video.buffered.length) return;
    bufferedEnd = seekOffset + video.buffered.end(video.buffered.length - 1);
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="player" bind:this={root} class:idle={!controlsOn}
     onmousemove={poke} ontouchstart={poke}
     role="region" aria-label="Video player">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={video}
    playsinline
    onclick={onVideoClick}
    ondblclick={onVideoDblClick}
    onpointerup={onVideoPointerUp}
    onplay={() => { paused = false; poke(); resumeCheck(); }}
    onpause={() => { paused = true; pausedAt = Date.now(); saveProgress(); poke(); }}
    onwaiting={() => { buffering = true; }}
    onstalled={() => { buffering = true; }}
    onplaying={() => { buffering = false; }}
    oncanplay={() => { buffering = false; }}
    ontimeupdate={onTimeUpdate}
    onprogress={onProgress}
    ondurationchange={() => { videoDur = video?.duration || 0; }}
    onended={handleEnded}
  ></video>

  {#if cueText}
    <div class="cue" class:lifted={controlsOn}>{cueText}</div>
  {/if}

  {#if buffering && !error}
    <div class="spin-wrap"><div class="spinner"></div></div>
  {/if}

  {#if notice && !error}
    <div class="notice">{notice}</div>
  {/if}

  {#if error}
    <div class="error">
      <p>{error}</p>
      <button class="ghost" onclick={close}>Close</button>
    </div>
  {/if}

  <div class="topbar-p">
    <button class="iconbtn back" onclick={close} aria-label="Close player">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button>
    <div class="ptitle">
      <span class="t">{title}</span>
      {#if subline}<span class="s">{subline}</span>{/if}
    </div>
  </div>

  <div class="controls">
    <!-- Scrubber -->
    <div class="scrub" bind:this={bar}
         onpointerdown={barDown} onpointermove={barMove} onpointerup={barUp}
         onpointerleave={() => { hoverT = -1; }}>
      <div class="rail">
        <div class="buffered" style={`width:${total ? Math.min(100, (bufferedEnd / total) * 100) : 0}%`}></div>
        <div class="filled" style={`width:${total ? Math.min(100, (shownTime / total) * 100) : 0}%`}></div>
        <div class="knob" style={`left:${total ? Math.min(100, (shownTime / total) * 100) : 0}%`}></div>
      </div>
      {#if hoverT >= 0 && !scrubbing}
        <div class="hoverwrap" style={`left:${hoverX}px`}>
          {#if sprite}
            <div class="hoverthumb" style={thumbStyle(hoverT)}></div>
          {/if}
          <div class="hovertime">{fmtTime(hoverT)}</div>
        </div>
      {/if}
    </div>

    <div class="buttons">
      <div class="zone zleft">
        <span class="time">{fmtTime(shownTime)} / {fmtTime(total)}</span>
      </div>

      <div class="zone zcenter">
        <button class="iconbtn skip" onclick={() => seekTo(cur - 10)} aria-label="Back 10 seconds">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/><text x="9" y="16.5" font-size="7" font-weight="700" fill="currentColor" stroke="none">10</text></svg>
        </button>
        <button class="iconbtn playbtn" onclick={togglePlay} aria-label={paused ? 'Play' : 'Pause'}>
          {#if paused}
            <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          {/if}
        </button>
        <button class="iconbtn skip" onclick={() => seekTo(cur + 10)} aria-label="Forward 10 seconds">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M12 5V1l5 5-5 5V7c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z"/><text x="9" y="16.5" font-size="7" font-weight="700" fill="currentColor" stroke="none">10</text></svg>
        </button>
        <div class="vol">
          <button class="iconbtn" onclick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {#if muted || volume === 0}
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
            {:else}
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
            {/if}
          </button>
          <input type="range" min="0" max="150" step="2" value={muted ? 0 : volume}
                 oninput={(e) => setVolume(parseFloat(e.target.value))}
                 aria-label="Volume (over 100 boosts)" />
          <span class="pct" class:boost={volume > 100 && !muted}>{muted ? 0 : volume}%</span>
        </div>
      </div>

      <div class="zone zright">
      {#if prev}
        <button class="nextbtn prevbtn" onclick={() => { saveProgress(); onprev?.(prev); }} title={`Previous — ${episodeCode(prev)}`}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18 18l-8.5-6L18 6v12zM8 6v12H6V6h2z"/></svg>
          Prev <strong>{episodeCode(prev)}</strong>
        </button>
      {/if}
      {#if next}
        <button class="nextbtn" onclick={() => { saveProgress(); onnext?.(next); }} title={`Next — ${episodeCode(next)}`}>
          Next <strong>{episodeCode(next)}</strong>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
        </button>
      {/if}

      {#if full?.subtitles?.length}
        <div class="menuwrap">
          <button class="iconbtn" class:on={subIdx >= 0} aria-label="Subtitles"
                  onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'subs' ? '' : 'subs'; }}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>
          </button>
          {#if openMenu === 'subs'}
            <div class="menu" onclick={(e) => e.stopPropagation()}>
              <button class:active={subIdx === -1} onclick={() => setSub(-1)}>Off</button>
              {#each full.subtitles as s, i (s.url)}
                <button class:active={subIdx === i} onclick={() => setSub(i)}>{s.label}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if !isDirect && full?.audioTracks?.length > 1}
        <div class="menuwrap">
          <button class="iconbtn" aria-label="Audio track"
                  onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'audio' ? '' : 'audio'; }}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1a7 7 0 0 1 14 0v1h-4v8h4c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z"/></svg>
          </button>
          {#if openMenu === 'audio'}
            <div class="menu" onclick={(e) => e.stopPropagation()}>
              {#each full.audioTracks as a (a.index)}
                <button class:active={audioTrack === a.index || (audioTrack == null && a === full.audioTracks[0])}
                        onclick={() => setAudio(a.index)}>{a.label}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if !isDirect}
        <div class="menuwrap">
          <button class="iconbtn" aria-label="Quality"
                  onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'quality' ? '' : 'quality'; }}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.61 3.61 0 0 1 8.4 12c0-1.98 1.62-3.6 3.6-3.6s3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          </button>
          {#if openMenu === 'quality'}
            <div class="menu" onclick={(e) => e.stopPropagation()}>
              {#each QUALITIES as q (q.key)}
                <button class:active={quality === q.key} onclick={() => setQuality(q.key)}>{q.label}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <button class="iconbtn" onclick={toggleFullscreen} aria-label="Fullscreen">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
      </button>
      </div>
    </div>
  </div>
</div>

<style>
  .player {
    position: fixed; inset: 0; z-index: 90;
    background: #000;
  }
  .player.idle { cursor: none; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }

  .cue {
    position: absolute; left: 50%; bottom: 6%;
    transform: translateX(-50%);
    max-width: 76%;
    text-align: center; white-space: pre-line;
    font-size: clamp(1rem, 2.4vw, 1.6rem); font-weight: 500; line-height: 1.35;
    color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.6);
    background: rgba(0, 0, 0, 0.35); border-radius: 6px;
    padding: 4px 14px;
    pointer-events: none;
    transition: bottom var(--t-med);
  }
  .cue.lifted { bottom: 13%; }

  .spin-wrap {
    position: absolute; inset: 0; display: grid; place-items: center;
    pointer-events: none;
  }
  .spinner {
    width: 52px; height: 52px;
    border: 3px solid rgba(242, 242, 244, 0.25); border-top-color: #fff;
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: var(--s4); text-align: center; padding: var(--s5);
    color: var(--ink);
  }
  .ghost {
    background: rgba(242, 242, 244, 0.14); color: var(--ink);
    font-weight: 600; padding: 11px 24px; border-radius: var(--r-sm);
  }

  .topbar-p {
    position: absolute; top: 0; left: 0; right: 0;
    display: flex; align-items: center; gap: var(--s3);
    padding: var(--s4);
    background: linear-gradient(rgba(0,0,0,0.7), transparent);
    transition: opacity var(--t-med);
  }
  .ptitle { display: flex; flex-direction: column; min-width: 0; }
  .ptitle .t { font-weight: 700; font-size: 1.05rem; }
  .ptitle .s { font-size: 0.82rem; color: var(--ink-soft); }

  .controls {
    position: absolute; left: 0; right: 0; bottom: 0;
    padding: 0 var(--s4) var(--s3);
    background: linear-gradient(transparent, rgba(0,0,0,0.85));
    transition: opacity var(--t-med);
  }
  .idle .topbar-p, .idle .controls { opacity: 0; pointer-events: none; }

  .scrub { position: relative; padding: 12px 0 8px; cursor: pointer; touch-action: none; }
  .rail {
    position: relative; height: 4px;
    background: rgba(242, 242, 244, 0.22); border-radius: 99px;
    transition: height var(--t-fast);
  }
  .scrub:hover .rail { height: 6px; }
  .buffered { position: absolute; inset: 0 auto 0 0; background: rgba(242, 242, 244, 0.35); border-radius: 99px; }
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
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7), 0 0 0 1.5px rgba(242, 242, 244, 0.35);
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
  .iconbtn {
    display: grid; place-items: center;
    width: 42px; height: 42px; border-radius: 99px;
    color: var(--ink);
    transition: background var(--t-fast), transform var(--t-fast);
  }
  .iconbtn:hover { background: rgba(242, 242, 244, 0.12); }
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

  .notice {
    position: absolute; left: 50%; top: 62%;
    transform: translateX(-50%);
    font-size: 0.9rem; color: var(--ink-soft);
    background: rgba(11, 11, 14, 0.7); backdrop-filter: blur(8px);
    padding: 8px 18px; border-radius: 99px;
    pointer-events: none;
  }

  .nextbtn {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(242, 242, 244, 0.14); color: var(--ink);
    font-size: 0.88rem; font-weight: 600;
    padding: 9px 16px; border-radius: 99px;
    transition: background var(--t-fast);
    white-space: nowrap;
  }
  .nextbtn:hover { background: rgba(242, 242, 244, 0.24); }

  .menuwrap { position: relative; }
  .menu {
    position: absolute; bottom: 52px; right: 0; z-index: 5;
    min-width: 180px; max-height: 40vh; overflow-y: auto;
    background: rgba(17, 17, 22, 0.96); backdrop-filter: blur(14px);
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
  .menu button:hover { background: rgba(242, 242, 244, 0.1); color: var(--ink); }
  .menu button.active { color: var(--ink); background: rgba(242, 242, 244, 0.14); font-weight: 600; }

  @media (max-width: 640px) {
    .time { display: none; }
    .nextbtn strong { display: none; }
    .vol input[type='range'], .pct { display: none; }
    .iconbtn.skip { width: 44px; height: 44px; }
    .iconbtn.playbtn { width: 48px; height: 48px; }
  }
</style>
