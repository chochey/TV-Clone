<script>
  import { updateWatchState } from '../stores.js';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { api, streamUrl } from '../api.js';
  import { session, dismissed, AUTO_WATCHED_PERCENT } from '../stores.js';
  import { startPlayback, STARTUP_ERROR, startupFragmentCount, startHlsFromPosition } from '../playback-startup.js';
  import { startDirectPlayback, directPlaybackError } from '../direct-playback.js';
  import { createSpriteLoader } from '../sprite-loader.js';
  import { loadHls, parseVtt, cueAt } from '../player-core.js';
  import { createPauseBookmark } from '../pause-resume.js';
  import { forcedEnglishSubtitle } from '../subtitle-selection.js';
  import { episodeCode, episodeTitle } from '../format.js';
  import { isSeriesItem } from '../series-playback.js';
  import { hevcMaxLevel, demoteHevc, isFirefoxDesktopLinux } from '../hevc-probe.js';
  import { createStallWatchdog, RESUME_GRACE_MS } from '../stall-watchdog.js';
  import { createQualityWatchdog } from '../quality-watchdog.js';
  import { createResumeSync } from '../resume-sync.js';
  import { hlsSettings } from '../hls-settings.js';
  import { createPlaybackReport } from '../playback-report.js';
  import { playerKeyAction } from '../player-keys.js';
  import { createTapGestures } from '../tap-gestures.js';
  import { createVolumeBoost, savedVolumePercent } from '../volume-boost.js';
  import { introOffer, upNext } from '../upnext-timing.js';
  import PlayerControls from './PlayerControls.svelte';
  import UpNextCard from './UpNextCard.svelte';

  // Remounted per item via {#key} in App — `item` is static for this mount.
  let { item, next = null, prev = null, onclose, onnext, onprev } = $props();

  // Data Saver promises a bitrate ceiling, so it streams a capped encode even
  // for files the browser could play as they are.
  const isDirect = $derived((full?.streamMode || item.streamMode) === 'direct' && quality !== 'low'
    && !full?.subtitles?.[subIdx]?.bitmap);
  // HEVC can be copied straight through to a browser that can decode it,
  // instead of being re-encoded to H.264 for the whole runtime.
  const isHevc = $derived((item.codec || '').toLowerCase() === 'hevc');
  // Set when passthrough has already failed on this item, so the retry after a
  // failure asks for a plain transcode instead of looping on the same fault.
  // hevcBlockedBy: 'decode' (the browser failed to decode it) or 'stall' (weaker
  // evidence, retried on the next seek that starts a new session).
  let hevcBlocked = false, hevcBlockedBy = null;
  // Whether the session currently loading/playing is a passthrough attempt —
  // the fallback must only fire for those, never for an ordinary transcode.
  let passthroughActive = false;
  // Firefox/Linux VAAPI puts <video> on an independent overlay plane that
  // flashes garbage even while paused (same Ranch episode is clean in Brave
  // and in Firefox on Windows). A 1px radius takes it off that plane.
  const forceCompositorLayer = isFirefoxDesktopLinux();
  const isSeries = $derived(isSeriesItem(item));
  const title = $derived(isSeries ? item.showName : (item.title || ''));
  const subline = $derived(isSeries ? `${episodeCode(item)} — ${episodeTitle(item)}` : (item.year || ''));

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
  let scrubbing = $state(false);  // shared with PlayerControls
  let openMenu = $state('');       // shared with PlayerControls

  let speed = $state(parseFloat(localStorage.getItem('v2Speed')) || 1);
  function setSpeed(s) {
    speed = s;
    localStorage.setItem('v2Speed', String(s));
    openMenu = '';
    applySpeed();
  }
  // An HLS session restart swaps the source out from under the element, and a
  // reloaded source can come back at 1x — so re-assert the rate rather than
  // setting it once.
  function applySpeed() { if (video && video.playbackRate !== speed) video.playbackRate = speed; }

  const total = $derived(totalDur || (isDirect ? videoDur : seekOffset + videoDur));

  // ── Skip Intro ───────────────────────────────────────────────────────
  // The server already knows where intros are (a per-episode override, a
  // show-level entry, or IntroDB). It answers {} when it doesn't — that's
  // the common case for films, so treat it as normal, not an error.
  let intro = $state(null); // { start, end } in real-timeline seconds
  // When it is offered: lib/upnext-timing.js.
  const introState = $derived(introOffer({ intro, total, cur, scrubbing }));

  function skipIntro() {
    if (!introState.valid) return;
    seekTo(intro.end);
    poke();
  }

  // ── Up next / autoplay ───────────────────────────────────────────────
  // Rolls on shortly into known credits, else at the true end
  // (lib/upnext-timing.js explains why).
  let outro = $state(null);
  let upnextDismissed = $state(false);
  let advanced = false;     // one-shot: `ended` and the countdown both land here

  const upnextState = $derived(upNext({ total, cur, outro, dismissed: upnextDismissed, scrubbing, error }));
  const upnextIn = $derived(upnextState.secondsLeft);
  const nearEnd = $derived(upnextState.nearEnd);
  const showUpnext = $derived(nearEnd && !!next);
  // Finishing the last episode used to just dump you back on whatever page was
  // behind the player with no explanation. Say so instead.
  const showFinale = $derived(nearEnd && !next && isSeries);

  function goNext() {
    if (advanced) return;
    advanced = true;
    saveProgress(true);
    if (next) onnext?.(next);
    else onclose?.();
  }

  $effect(() => {
    if (showUpnext && upnextIn <= 0) goNext();
  });

  let hls = null;
  let loadSeq = 0;
  let playbackId = null;
  let destroyed = false;
  let startupPending = false;
  let cancelStartup = () => {};
  let hlsRetries = 0;
  const pauseBookmark = createPauseBookmark();
  let timelineReady = true; // ignore old-source events until the replacement is attached
  let recoverAttempts = 0; // consecutive dead-session restarts without playback progress
  let recoverFromT = -1;   // position of the last auto-restart
  let root = $state(null);
  let progressTimer = null;
  // What this viewing was like, for the dashboard; sent once when the player closes.
  const report = createPlaybackReport();
  let reportSent = false;
  function sendReport() {
    if (reportSent || !report.worthSending()) return;
    reportSent = true;
    api.playbackReport(report.finish({ itemId: item.id, direct: isDirect, playbackId, quality }));
  }
  $effect(() => { if (error) report.failed(); });
  let stallTimer = null;
  let idleTimer = null;

  // ── Media loading ───────────────────────────────────────────────────
  function destroyHls() {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
  }

  function loadDirect(start) {
    const seq = ++loadSeq;
    cancelStartup();
    startupPending = true;
    timelineReady = false;
    buffering = true;
    cur = start;
    seekOffset = 0;
    // The title page's answer (which probes the file) knows the stream mode; the catalog entry
    // may still say "unknown" for a file that arrived minutes ago, and that must not turn a
    // direct play into a transcode playlist fed to a plain <video>.
    cancelStartup = startDirectPlayback(video, streamUrl({ ...item, streamMode: full?.streamMode || item.streamMode }), start, {
      isCurrent: () => seq === loadSeq && !destroyed,
      onMetadata: () => { timelineReady = true; },
      onSlow: () => { notice = 'Preparing video…'; },
      onBlocked: () => { startupPending = false; buffering = false; notice = 'Press Play to resume.'; },
      onTimeout: () => { startupPending = false; buffering = false; error = STARTUP_ERROR; },
    });
    stopFrameCounter(); startFrameCounter();
  }

  function onVideoError() {
    if (destroyed || !isDirect || !video?.error) return;
    cancelStartup();
    startupPending = false;
    buffering = false;
    error = directPlaybackError(video.error);
  }

  let busyRetries = 0;
  let retryTimer = null;
  async function loadHlsSession(start) {
    const seq = ++loadSeq;
    cancelStartup();
    startupPending = true;
    timelineReady = false;
    cur = start;
    video?.pause();
    clearTimeout(retryTimer);
    buffering = true;
    let H;
    try { H = await loadHls(); } catch { error = 'Failed to load the video engine.'; return; }
    if (seq !== loadSeq || destroyed) return;
    destroyHls(); // stop old fragment requests before retiring their session
    const previousPlayback = playbackId;
    playbackId = null;
    if (previousPlayback) {
      try { await fetch(`/api/hls/${previousPlayback}/stop`, { method: 'POST', credentials: 'same-origin' }); } catch {}
    }
    if (seq !== loadSeq || destroyed) return;
    const currentPlayback = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    playbackId = currentPlayback;
    const params = new URLSearchParams({ start: String(start), quality });
    if (audioTrack != null) params.set('audio', String(audioTrack));
    const selectedSub = full?.subtitles?.[subIdx];
    if (selectedSub?.bitmap) params.set('subtitle', String(selectedSub.streamIndex));
    // Ask for passthrough only after this browser has actually decoded a real
    // HEVC clip. The probe runs once per browser build and is cached, so this
    // costs nothing after the first HEVC play. The server still applies its own
    // level ceiling, so a claim here is a request, not a guarantee.
    passthroughActive = false;
    if (isHevc && !hevcBlocked && !selectedSub?.bitmap && quality !== 'low') {
      const lvl = await hevcMaxLevel();
      if (seq !== loadSeq) return;  // a seek landed while probing
      if (lvl > 0) { params.set('hevcMaxLevel', String(lvl)); passthroughActive = true; }
    }
    const url = `/hls/${encodeURIComponent(item.id)}/${currentPlayback}/master.m3u8?${params}`;

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
    const startupFragments = startupFragmentCount(await r.text());
    if (seq !== loadSeq || destroyed) return;
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

    hls = new H(hlsSettings({ startupFragments, worker: !forceCompositorLayer }));
    hls.loadSource(url);
    hls.attachMedia(video);
    // Fresh measurement window per session — a seek restarts the decoder, and
    // carrying counts across would blame the new session for the old one.
    // The frame counter runs for every session: the quality watchdog only judges passthrough,
    // but the resync after a tab switch (lib/resume-sync.js) needs frames from any stream.
    stopFrameCounter(); startFrameCounter();
    hls.on(H.Events.MANIFEST_PARSED, () => {
      if (seq !== loadSeq) return;
      timelineReady = true;
      startHlsFromPosition(hls);
      cancelStartup();
      cancelStartup = startPlayback(video, {
        isCurrent: () => seq === loadSeq && !destroyed,
        onSlow: () => { notice = 'Still preparing video… playback will start automatically.'; },
        onBlocked: () => { startupPending = false; buffering = false; notice = 'Press Play to begin.'; },
        onTimeout: () => {
          startupPending = false;
          if (fallbackFromPassthrough('startup timed out', false)) return;
          buffering = false;
          error = STARTUP_ERROR;
        },
      });
    });
    hls.on(H.Events.ERROR, async (_e, data) => {
      if (seq !== loadSeq || destroyed || !data.fatal) return;
      // Paused streams may expire; reopen them only when the viewer resumes.
      if (paused && !startupPending) return;
      // A passthrough session that dies on a media error is a capability
      // misjudgement, not a transient fault — hls.recoverMediaError() would
      // just fail the same way. Give up the claim and rebuild as a transcode.
      if (data.type === H.ErrorTypes.MEDIA_ERROR
          && fallbackFromPassthrough('fatal media error', true)) return;
      hlsRetries++;
      if (hlsRetries > 3) { error = 'Playback failed after several retries.'; return; }
      if (data.type === H.ErrorTypes.NETWORK_ERROR) {
        // Segments 404 forever once the server reaped the session — only a
        // fresh session at the current position can revive playback.
        if (await sessionDead()) { if (seq === loadSeq && !video?.paused) recoverSession(); return; }
        if (seq === loadSeq) startHlsFromPosition(hls, video.currentTime);
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
      const r = await fetch(`/api/hls/${playbackId}/alive`, { credentials: 'same-origin' });
      if (r.status === 404 || r.status === 410) return true;
      if (!r.ok) return false;
      return !(await r.json()).alive;
    } catch { return false; }
  }
  // ── Playback-quality watchdog (passthrough only) ───────────────────
  // Passthrough moves decoding from the server to this browser. The capability
  // probe proves a frame comes out of the decoder — it cannot prove the
  // decoder sustains 24fps, and those are different questions. A browser
  // software-decoding 10-bit HEVC drops frames while audio stays perfect,
  // which reads as stuttering video rather than as an error, so nothing else
  // in the player notices it.
  //
  // getVideoPlaybackQuality() is the obvious signal but Firefox has reported
  // totalVideoFrames as 0 here, and Firefox is exactly the browser that
  // software-decodes HEVC. requestVideoFrameCallback fires once per frame
  // actually presented, works in both, and needs no knowledge of the source
  // frame rate: if fewer than MIN_PRESENTED_FPS frames reach the screen per
  // second of ordinary playback, the picture is visibly breaking up whatever
  // the source was.
  // Crucially, one bad window is NOT enough. Observed in testing: passthrough
  // stuttered for a while after a seek and then settled on its own with no
  // intervention — a decoder warming up, or a burst of segment fetches
  // competing with decode. Demoting on that would have permanently disabled a
  // tier that was about to work fine. Only sustained trouble counts.
  // Dropped-frame judgement for passthrough (lib/quality-watchdog.js).
  const qualityWatchdog = createQualityWatchdog();

  // ── Picture behind the sound after a tab switch (lib/resume-sync.js) ──
  // Firefox stops decoding a hidden tab's video after 10 s and keeps the sound. On Windows with
  // 10-bit HEVC passthrough the picture then stayed behind the sound until the page was
  // refreshed. After a return, a jump in place resyncs both tracks; if the picture is still
  // behind, the stream is rebuilt at the same spot, which is what the refresh did.
  const resumeSync = createResumeSync();
  function resumeCheck() {
    if (!video) return;
    const { action } = resumeSync.check({
      playing: !paused && !video.paused && !error && !scrubbing && !startupPending && timelineReady
        && video.readyState >= 3 && document.visibilityState === 'visible',
      currentTime: video.currentTime,
    });
    if (action === 'none') return;
    stallWatchdog.reset(RESUME_GRACE_MS);
    if (action === 'resync') {
      console.info('[player] picture behind the sound after returning to the tab; resyncing in place');
      try { video.currentTime = video.currentTime; } catch {}
    } else if (action === 'rebuild') {
      console.info('[player] picture still behind the sound; rebuilding the stream here');
      if (isDirect) loadDirect(cur); else loadHlsSession(cur);
    }
  }
  let rvfcHandle = null;

  function countPresentedFrame(_now, meta) {
    qualityWatchdog.frame();
    if (meta && video) resumeSync.frame(meta.mediaTime, video.currentTime);
    if (video?.requestVideoFrameCallback) {
      rvfcHandle = video.requestVideoFrameCallback(countPresentedFrame);
    }
  }

  function startFrameCounter() {
    qualityWatchdog.start();
    if (video?.requestVideoFrameCallback && rvfcHandle === null) {
      rvfcHandle = video.requestVideoFrameCallback(countPresentedFrame);
    }
  }

  function stopFrameCounter() {
    if (video?.cancelVideoFrameCallback && rvfcHandle !== null) {
      try { video.cancelVideoFrameCallback(rvfcHandle); } catch {}
    }
    rvfcHandle = null;
  }

  function qualityCheck() {
    if (!video) return;
    // `paused` is our reactive mirror; video.paused is the truth. Measured on
    // Firefox, a paused element still fires requestVideoFrameCallback ~6 times
    // a second while decoding nothing, so both are checked.
    const q = video.getVideoPlaybackQuality?.();
    const { action, reason } = qualityWatchdog.check({
      active: passthroughActive && !paused && !video.paused && !error && !scrubbing,
      playbackRate: video.playbackRate, readyState: video.readyState, hidden: document.visibilityState !== 'visible',
      quality: q ? { dropped: q.droppedVideoFrames, total: q.totalVideoFrames } : null,
      countsFrames: !!video.requestVideoFrameCallback,
    });
    // Sustained across every window since it started going wrong; persist it,
    // because the next episode would stutter identically.
    if (action === 'demote') fallbackFromPassthrough(reason, true);
  }

  // ── Stall watchdog ─────────────────────────────────────────────────
  // The hls.js ERROR handler above bails on `!data.fatal`, but a buffer
  // stall is NOT fatal — hls.js nudges a few times and then simply gives
  // up, leaving the video frozen with nothing reported. Remuxed files are
  // the usual cause: `-c:v copy` can only cut segments on keyframes, so a
  // source with irregular keyframes yields segments from ~1s to ~10s and
  // the playhead can land in a gap the nudger won't cross.
  // Nothing else notices this, so watch playback directly: if we're meant
  // to be playing and the clock isn't moving, hop the gap; if that keeps
  // failing, rebuild the session.
  const stallWatchdog = createStallWatchdog();

  function stallCheck() {
    if (!video) return;
    let aheadTarget = -1;
    for (let i = 0; i < (video.buffered?.length || 0); i++) {
      const s = video.buffered.start(i);
      if (s > video.currentTime && s - video.currentTime < 30) { aheadTarget = s + 0.05; break; }
    }
    const { action, target } = stallWatchdog.check({
      active: !paused && !error && !scrubbing && !startupPending && timelineReady,
      hidden: document.visibilityState !== 'visible', position: video.currentTime,
      aheadTarget, passthrough: passthroughActive, direct: isDirect,
    });
    if (action === 'nudge') { video.currentTime = target; video.play().catch(() => {}); }   // skip the hole between segments
    else if (action === 'play') video.play().catch(() => {});
    else if (action === 'fallback') fallbackFromPassthrough('stalled', false);
    else if (action === 'rebuild') {
      // Rebuild the same stream from here. A passthrough session that keeps
      // coming back empty is the last-resort case for the transcode.
      if (passthroughActive && recoverAttempts >= 2) fallbackFromPassthrough('stalled', false);
      else recoverSession();
    }
  }

  // Abandon HEVC passthrough and rebuild the session as an ordinary transcode.
  // `persist` distinguishes the two ways it can go wrong: a fatal media error
  // means this browser genuinely could not decode what the probe said it could,
  // so the claimed level comes down a step for the whole browser. A stall is
  // weaker evidence — it can be a network hiccup or one oddly-cut file — so it
  // only disables passthrough for the item in hand and leaves the verdict alone.
  function fallbackFromPassthrough(reason, persist) {
    if (!passthroughActive) return false;
    passthroughActive = false;
    hevcBlocked = true; hevcBlockedBy = persist ? 'decode' : 'stall';
    if (persist) demoteHevc(reason);
    // The failed attempt was a gamble on a capability; the transcode that
    // replaces it starts with a clean retry budget rather than inheriting the
    // strikes spent proving the gamble wrong.
    hlsRetries = 0;
    recoverAttempts = 0;
    notice = 'Switching to a compatible stream…';
    loadHlsSession(cur);
    return true;
  }

  function recoverSession() {
    if (recoverAttempts >= 3) { error = 'Playback failed after several retries.'; return; }
    recoverAttempts++;
    recoverFromT = cur;
    loadHlsSession(cur);
  }
  function resumePausedPlayback() {
    const saved = pauseBookmark.take(cur);
    if (!saved.expired && !error) return false;
    // Reopen before calling play(): dead media can reject play without ever
    // firing onplay, and a long pause has already outlived the server lease.
    error = '';
    recoverAttempts = 0;
    recoverFromT = saved.position;
    stallWatchdog.reset(RESUME_GRACE_MS);
    paused = false;
    if (isDirect) loadDirect(saved.position);
    else loadHlsSession(saved.position);
    return true;
  }

  function seekTo(t) {
    report.seeking();
    if (!total) return;
    t = Math.max(0, Math.min(t, Math.max(0, total - 1)));
    pauseBookmark.seek(t);
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
      // A stall was weak evidence against passthrough; a fresh session is the
      // natural moment to give it another chance.
      if (hevcBlockedBy === 'stall') { hevcBlocked = false; hevcBlockedBy = null; }
      loadHlsSession(t);
    }
  }

  // ── Progress sync (v1 contract: every 5s + on pause/close/ended) ────
  // The position we'd persist right now, or null if we don't know one yet.
  function progressPayload(ended = false) {
    if (!total) return null;
    const t = ended ? total : cur;
    return { id: item.id, currentTime: t, duration: total, profile: $session?.profileId };
  }

  // Last-gasp save for when the document is going away: closing the tab,
  // quitting the browser, locking the phone. onDestroy does NOT run then, and
  // a normal fetch would be cancelled mid-flight, so this goes out by beacon.
  // Without it the only thing standing between you and a lost position is the
  // 5s autosave -- and that doesn't run at all while paused, so a seek made
  // while paused was simply lost.
  let teardownSaved = false;
  function flushProgressOnTeardown() {
    if (teardownSaved) return;   // pagehide can follow visibilitychange
    const body = progressPayload();
    if (!body) return;
    teardownSaved = true;
    api.progressBeacon(body);
  }

  function saveProgress(ended = false) {
    const body = progressPayload(ended);
    if (!body) return;
    const t = body.currentTime;
    const pct = Math.round((t / total) * 100);
    teardownSaved = false; // a fresh position supersedes any teardown flush
    api.progress(body);
    const prog = { currentTime: t, duration: total, percent: pct, updatedAt: Date.now() };
    // Mirror the two things the server does with this same call, so the UI
    // doesn't lag a page-load behind: it auto-marks watched above
    // AUTO_WATCHED_PERCENT, and it un-dismisses anything you actively play.
    // Without the first, finishing an episode leaves the show page still
    // offering the episode you just watched.
    updateWatchState(item.id, current => ({ progress: prog, watched: current.watched || pct > AUTO_WATCHED_PERCENT }));
    if (pct > 0) {
      dismissed.update((d) => {
        if (!d.continueWatching?.[item.id]) return d;
        const cw = { ...d.continueWatching };
        delete cw[item.id];
        return { ...d, continueWatching: cw };
      });
    }
  }

  // ── Subtitles: custom cue rendering so HLS session restarts (video
  // timeline resets to 0) can't desync the text — we track real time. ──
  let subSeq = 0;
  async function setSub(i, initial = false) {
    const wasBitmap = !!full?.subtitles?.[subIdx]?.bitmap;
    subIdx = i;
    cues = [];
    cueText = '';
    openMenu = '';
    const seq = ++subSeq;
    const selected = full?.subtitles?.[i];
    if (!initial && (wasBitmap || selected?.bitmap)) {
      error = '';
      if (isDirect) switchToDirect(cur);
      else loadHlsSession(cur);
    }
    if (!selected || selected.bitmap) return;
    try {
      const r = await fetch(full.subtitles[i].url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('Subtitle request failed');
      const text = await r.text();
      if (seq === subSeq) cues = parseVtt(text);
    } catch { if (seq === subSeq && !destroyed) notice = 'Could not load subtitles. Please try again.'; }
  }

  // ── Menus / controls chrome ─────────────────────────────────────────
  function setQuality(q) {
    const wasDirect = isDirect;
    quality = q;
    localStorage.setItem('v2Quality', q);
    openMenu = '';
    error = '';
    if (!isDirect) loadHlsSession(cur);
    else if (!wasDirect) switchToDirect(cur);
  }
  // Leave an HLS session for direct play of the file (subtitle or quality change).
  function switchToDirect(t) {
    ++loadSeq;
    cancelStartup();
    clearTimeout(retryTimer);
    startupPending = false;
    destroyHls();
    if (playbackId) fetch(`/api/hls/${playbackId}/stop`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    playbackId = null;
    seekOffset = 0;
    loadDirect(t);
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
    if (video.paused || error) {
      if (resumePausedPlayback()) return;
      video.play().catch(() => {
        if (!destroyed && video?.paused) notice = 'Press Play to resume.';
      });
    }
    else { startupPending = false; cancelStartup(); video.pause(); }
  }

  // ── Volume: 0–100 native, 101–150 through a WebAudio gain stage ──────
  const volumeBoost = createVolumeBoost({ getVideo: () => video });
  function setVolume(pct) {
    const next = volumeBoost.set(pct);
    volume = next.volume;
    muted = next.muted;
  }
  function toggleMute() { muted = volumeBoost.setMuted(!muted, volume); }

  // ── Touch: double-tap left/right half seeks ±10s; single tap toggles.
  // Desktop keeps click = play/pause, double-click = fullscreen. Synthetic
  // click/dblclick events that follow a touch are suppressed. ──
  const taps = createTapGestures({
    onSingle: () => { togglePlay(); poke(); },
    onDouble: side => { seekTo(cur + (side === 'right' ? 10 : -10)); poke(); },
  });
  function onVideoPointerUp(e) { taps.pointerUp(e, window.innerWidth); }
  function onVideoClick() {
    if (taps.touchedRecently()) return;
    // An open menu should close on the next click anywhere, like every other
    // player — and closing it shouldn't also pause what you're watching.
    if (openMenu) { openMenu = ''; poke(); return; }
    togglePlay();
    poke();
  }
  function onVideoDblClick() {
    if (taps.touchedRecently()) return;
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
    // Cancelling the up-next card means "don't roll on". Honour that at the
    // natural end too — otherwise Cancel only hides the card and the episode
    // advances anyway, which is exactly what the viewer said no to.
    if (upnextDismissed) {
      saveProgress(true);
      onclose?.();
      return;
    }
    goNext(); // shared one-shot, so the countdown can't fire this a second time
  }

  // ── Seek-preview sprites (v1's sheets: cols×rows tiles, one per
  // interval seconds; generate-on-demand, poll while the server bakes) ──
  let sprite = $state(null); // {totalSheets, cols, rows, width, height, interval}
  function preloadSheets(meta) {
    for (let s = 0; s < meta.totalSheets; s++) {
      const img = new Image();
      img.src = `/api/sprites/${encodeURIComponent(item.id)}/${s}`;
    }
  }
  const spriteLoader = createSpriteLoader({
    id: untrack(() => item.id),   // the player is remounted per item
    isCurrent: () => !destroyed,
    onData: data => { if (data.totalSheets > 0 && (!sprite || data.status === 'ready')) sprite = data; },
    preload: preloadSheets,
  });
  function onKey(e) {
    const hit = playerKeyAction(e);
    if (!hit) return;
    if (hit.prevent) e.preventDefault();
    switch (hit.action) {
      case 'toggle': togglePlay(); poke(); break;
      case 'back': seekTo(cur - 10); poke(); break;
      case 'forward': seekTo(cur + 10); poke(); break;
      case 'louder': setVolume(volume + 5); poke(); break;
      case 'quieter': setVolume(volume - 5); poke(); break;
      case 'mute': toggleMute(); poke(); break;
      case 'fullscreen': toggleFullscreen(); poke(); break;
      case 'escape':
        if (openMenu) openMenu = '';
        else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else close();
        break;
    }
  }

  onMount(async () => {
    document.body.style.overflow = 'hidden';
    volume = savedVolumePercent();
    muted = volume === 0;
    video.volume = Math.min(1, volume / 100);
    video.muted = muted;
    // Note: the boost graph is only built when the user pushes past 100.

    // Full record: fresh resume point, subtitles, sync offset, audio tracks.
    try { full = await api.item(item.id); } catch { full = null; }
    if (destroyed) return;
    audioTrack = full?.defaultAudioTrack ?? full?.audioTracks?.find(track => track.isDefault)?.index ?? null;
    const prog = full?.progress || item.progress || {};
    const start = (prog.percent || 0) >= AUTO_WATCHED_PERCENT ? 0 : (prog.currentTime > 5 ? prog.currentTime : 0);
    cur = start;
    const forcedEnglish = forcedEnglishSubtitle(full?.subtitles);
    if (forcedEnglish >= 0) setSub(forcedEnglish, true);

    if (isDirect) { seekOffset = 0; loadDirect(start); }
    else loadHlsSession(start);

    spriteLoader.load();
    // Don't block playback on this — the button just appears once it lands.
    api.skipSegments(item.id).then((s) => {
      const i = s?.intro;
      if (i && typeof i.start === 'number' && typeof i.end === 'number') intro = i;
      const o = s?.outro;
      if (o && typeof o.start === 'number') outro = o;
    }).catch(() => {});
    progressTimer = setInterval(() => { if (!paused) saveProgress(); }, 5000);
    stallTimer = setInterval(() => { stallCheck(); qualityCheck(); resumeCheck(); }, 1000);
    // Both events, deliberately: pagehide is the reliable desktop signal for a
    // closing tab, but mobile browsers frequently kill a backgrounded page
    // without ever firing it, and visibilitychange is the one that survives an
    // app switch or screen lock. flushProgressOnTeardown de-dupes.
    window.addEventListener('pagehide', flushProgressOnTeardown);
    window.addEventListener('pagehide', sendReport);
    document.addEventListener('visibilitychange', onVisibilityChange);
    poke();
  });

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') { flushProgressOnTeardown(); resumeSync.hidden(); return; }
    // A backgrounded player needs a moment to catch up: neither watchdog judges it meanwhile,
    // and the resync check watches whether the picture actually catches up with the sound.
    stallWatchdog.reset(RESUME_GRACE_MS);
    qualityWatchdog.resume();
    resumeSync.shown();
  }

  onDestroy(() => {
    destroyed = true;
    cancelStartup();
    clearInterval(progressTimer);
    clearInterval(stallTimer);
    clearTimeout(idleTimer);
    clearTimeout(retryTimer);
    taps.stop();
    spriteLoader.stop();
    stopFrameCounter();
    // Must come off before the final save: a listener left behind would keep a
    // closure over this item and could beacon a stale position later, clobbering
    // whatever the viewer moved on to.
    window.removeEventListener('pagehide', flushProgressOnTeardown);
    window.removeEventListener('pagehide', sendReport);
    sendReport();   // before the stop beacon, while the server still knows this stream
    document.removeEventListener('visibilitychange', onVisibilityChange);
    saveProgress();
    loadSeq++; // invalidate in-flight session loads
    destroyHls();
    // Free the transcode slot immediately instead of waiting out the
    // server's 2-minute idle timeout (the main source of 503s).
    if (playbackId) {
      try { navigator.sendBeacon(`/api/hls/${playbackId}/stop`); } catch {}
    }
    volumeBoost.close();
    document.body.style.overflow = '';
  });

  function clearStartupError() {
    // A slow start may recover after the watchdog fired. Preserve unrelated errors.
    if (error === STARTUP_ERROR) error = '';
  }
  function onTimeUpdate() {
    if (!video || !timelineReady || startupPending) return;
    const nextTime = seekOffset + video.currentTime;
    if (nextTime > cur && !video.paused && !video.seeking && video.readyState >= 3) {
      clearStartupError();
    }
    cur = nextTime;
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
    class:sw-layer={forceCompositorLayer}
    playsinline
    onclick={onVideoClick}
    ondblclick={onVideoDblClick}
    onpointerup={onVideoPointerUp}
    onplay={() => {
      if (!timelineReady) return;
      if (resumePausedPlayback()) return;
      stallWatchdog.reset(RESUME_GRACE_MS);   // loading restarts on play; let the buffer refill
      paused = false; poke();
      try { if (!startupPending && hls) startHlsFromPosition(hls, video.currentTime); } catch {}
    }}
    onpause={() => {
      report.paused();
      // load()/detach can deliver a late pause while the next stream starts.
      if (startupPending || !timelineReady) return;
      paused = true;
      cur = seekOffset + video.currentTime;
      pauseBookmark.capture(cur);
      saveProgress(); poke();
      // Stop MSE appends while paused — Firefox/Linux was flashing on each
      // fragment even with the clock frozen and hardware decode off.
      try { hls?.stopLoad(); } catch {}
    }}
    onwaiting={() => { buffering = true; report.waiting(); }}
    onstalled={() => { buffering = true; }}
    onplaying={() => { if (!timelineReady) return; report.playing(); paused = false; clearStartupError(); startupPending = false; cancelStartup(); buffering = false; notice = ''; applySpeed(); }}
    oncanplay={() => { if (!startupPending) buffering = false; applySpeed(); }}
    ontimeupdate={onTimeUpdate}
    onprogress={onProgress}
    ondurationchange={() => { videoDur = video?.duration || 0; }}
    onended={() => { report.paused(); handleEnded(); }}
    onerror={onVideoError}
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
      <button class="ghost" onclick={() => { error = ''; recoverAttempts = 0; if (isDirect) loadDirect(cur); else loadHlsSession(cur); }}>Retry</button>
      <button class="ghost" onclick={close}>Close</button>
    </div>
  {/if}

  {#if introState.show && !error}
    <button class="skipintro" class:lifted={controlsOn} onclick={skipIntro}>
      Skip Intro
    </button>
  {/if}

  {#if showUpnext || showFinale}
    <UpNextCard next={showUpnext ? next : null} {title} secondsLeft={upnextIn} lifted={controlsOn}
                onplay={goNext} oncancel={() => { upnextDismissed = true; }} onclose={close} />
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

  <PlayerControls
    itemId={item.id} {total} {cur} {bufferedEnd} {sprite} {paused} {muted} {volume}
    {prev} {next} subtitles={full?.subtitles} {subIdx} audioTracks={full?.audioTracks} {audioTrack}
    {isDirect} {speed} {quality} bind:openMenu bind:scrubbing
    onseek={seekTo} ontoggleplay={togglePlay} ontogglemute={toggleMute} onvolume={setVolume}
    onprev={p => { saveProgress(); onprev?.(p); }} onnext={n => { saveProgress(); onnext?.(n); }}
    onsub={i => setSub(i)} onaudio={setAudio} onspeed={setSpeed} onquality={setQuality} onfullscreen={toggleFullscreen} />
</div>

<style>
  .player {
    position: fixed; inset: 0; z-index: 90;
    background: #000;
  }
  .player.idle { cursor: none; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  /* 1px radius is enough for Firefox/Linux to stop using a hardware video
     overlay (zero-copy VAAPI surfaces that flash garbage even when paused)
     without a visible rounded corner. transform keeps it on a compositor
     texture. Only applied via .sw-layer on that UA. */
  video.sw-layer {
    border-radius: 1px;
    transform: translateZ(0);
  }

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
  .cue.lifted { bottom: max(13%, 96px); }

  /* Bottom-right, the convention viewers already know. Deliberately NOT
     hidden by `.idle` like the other chrome: the intro window is short, so a
     button that vanishes with the controls is one you miss. */
  .skipintro {
    position: absolute; right: max(var(--s4), env(safe-area-inset-right)); bottom: 12%;
    z-index: 6;
    background: rgba(14, 12, 11, 0.72); color: var(--ink);
    border: 1.5px solid rgba(243, 237, 228, 0.55);
    font-size: 0.95rem; font-weight: 600; letter-spacing: 0.01em;
    padding: 11px 26px; border-radius: var(--r-sm);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), bottom var(--t-med);
    animation: skipin var(--t-med) var(--ease);
  }
  .skipintro.lifted { bottom: max(17%, 108px); }
  .skipintro:hover, .skipintro:focus-visible {
    background: var(--cta); color: var(--cta-ink); border-color: var(--cta);
  }
  @keyframes skipin {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  /* The fade starts at opacity 0, so anything that stops it from advancing
     would leave an invisible-but-clickable button. Drop the animation
     entirely rather than risk that. */
  @media (prefers-reduced-motion: reduce) {
    .skipintro { animation: none; }
  }
  @media (max-width: 560px) {
    .skipintro { padding: 9px 18px; font-size: 0.86rem; }
  }

  .spin-wrap {
    position: absolute; inset: 0; display: grid; place-items: center;
    pointer-events: none;
  }
  .spinner {
    width: 52px; height: 52px;
    border: 3px solid rgba(243, 237, 228, 0.25); border-top-color: #fff;
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
    background: rgba(243, 237, 228, 0.14); color: var(--ink);
    font-weight: 600; padding: 11px 24px; border-radius: var(--r-sm);
  }

  /* index.html opts into viewport-fit=cover, so on a notched phone — and
     landscape is the main way anyone watches — the notch and the home
     indicator sit over the chrome unless we pad around them. */
  .topbar-p {
    position: absolute; top: 0; left: 0; right: 0;
    display: flex; align-items: center; gap: var(--s3);
    padding: max(var(--s4), env(safe-area-inset-top)) max(var(--s4), env(safe-area-inset-right))
             var(--s4) max(var(--s4), env(safe-area-inset-left));
    background: linear-gradient(rgba(0,0,0,0.7), transparent);
    transition: opacity var(--t-med);
  }
  .ptitle { display: flex; flex-direction: column; min-width: 0; }
  .ptitle .t { font-weight: 700; font-size: 1.05rem; }
  .ptitle .s { font-size: 0.82rem; color: var(--ink-soft); }
  .idle .topbar-p { opacity: 0; pointer-events: none; }

  /* Same round icon button as the control bar's, for the back button. */
  .iconbtn {
    display: grid; place-items: center; flex-shrink: 0;
    width: 42px; height: 42px; border-radius: 99px;
    color: var(--ink);
    transition: background var(--t-fast), transform var(--t-fast);
  }
  .iconbtn:hover { background: rgba(243, 237, 228, 0.12); }

  .notice {
    position: absolute; left: 50%; top: 62%;
    transform: translateX(-50%);
    font-size: 0.9rem; color: var(--ink-soft);
    background: rgba(14, 12, 11, 0.92);
    padding: 8px 18px; border-radius: 99px;
    pointer-events: none;
  }

  @media (max-width: 1400px) {
    .iconbtn {width:44px;height:44px;}
    .cue.lifted {bottom:calc(145px + env(safe-area-inset-bottom));}
    .skipintro.lifted {bottom:calc(155px + env(safe-area-inset-bottom));}
  }
  @media (max-width: 640px) {
    .cue.lifted {bottom:calc(230px + env(safe-area-inset-bottom));}
    .skipintro.lifted {bottom:calc(240px + env(safe-area-inset-bottom));}
  }
</style>
