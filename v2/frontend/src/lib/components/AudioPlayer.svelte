<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, posterUrl } from '../api.js';
  import { session, updateWatchState, dismissed, AUTO_WATCHED_PERCENT } from '../stores.js';
  import { audioProgressPayload, audioResumePosition, audioPlaybackError, audioPlaybackIssue, startAudioPlayback, audioTime } from '../audio-playback.js';

  let { item, onclose } = $props();
  let audio = $state(null);
  let closeButton = $state(null);
  let error = $state('');
  let notice = $state('Loading audio…');
  let currentTime = $state(0);
  let duration = $state(0);
  let speed = $state(1);
  let posterFailed = $state(false);
  let full = $state(null);
  const title = $derived(full?.title || item.title || item.filename || 'Audio');
  const artwork = $derived(posterUrl(full) || posterUrl(item));
  const playbackIssue = $derived(audioPlaybackIssue({ ...item, ...(full || {}) }));
  let ready = $state(false);
  let destroyed = false, sequence = 0, profile = null;
  let cancelStartup = () => {}, timer, previousOverflow = '', teardownSaved = false, resumePoint = 0;

  function saveProgress(ended = false, beacon = false) {
    if (!ready || $session?.profileId !== profile) return;
    const body = audioProgressPayload(item, audio?.currentTime, audio?.duration, profile, ended);
    if (!body) return;
    if (beacon) { if (teardownSaved) return; teardownSaved = true; api.progressBeacon(body); }
    else { teardownSaved = false; api.progress(body); }
    const percent = Math.round(body.currentTime / body.duration * 100);
    updateWatchState(item.id, previous => ({
      progress: { currentTime: body.currentTime, duration: body.duration, percent, updatedAt: Date.now() },
      watched: previous.watched || percent > AUTO_WATCHED_PERCENT,
    }));
    if (percent > 0) dismissed.update(value => {
      const continueWatching = { ...value.continueWatching }; delete continueWatching[item.id];
      return { ...value, continueWatching };
    });
  }

  function load(start = 0) {
    const attempt = ++sequence;
    cancelStartup(); ready = false; error = ''; notice = 'Loading audio…';
    if (playbackIssue) { notice = ''; return; }
    resumePoint = start;
    cancelStartup = startAudioPlayback(audio, item, start, {
      isCurrent: () => !destroyed && sequence === attempt,
      onMetadata: value => {
        duration = value;
        audio.currentTime = value > 0 && resumePoint >= value ? 0 : resumePoint;
        currentTime = audio.currentTime; ready = true; audio.playbackRate = speed;
      },
      onBlocked: () => { notice = 'Press Play to listen.'; },
      onSlow: () => { notice = 'Waiting for audio…'; },
      onTimeout: () => { error = 'Audio is taking longer than expected. Retry or check the server connection.'; notice = ''; },
      onError: message => { error = message; notice = ''; },
    });
  }
  function stopUnsupportedAudio() {
    sequence++; cancelStartup(); ready = false; notice = ''; error = '';
    audio?.pause(); audio?.removeAttribute('src'); audio?.load();
  }
  function seek(seconds) {
    if (!ready || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
    currentTime = audio.currentTime; saveProgress();
  }
  function close() { saveProgress(); onclose?.(); }
  function onHidden() { if (document.visibilityState === 'hidden') saveProgress(false, true); }
  function onPageHide() { saveProgress(false, true); }
  function keydown(event) { if (event.key === 'Escape') { event.preventDefault(); close(); } }

  onMount(() => {
    profile = $session?.profileId;
    previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    closeButton?.focus();
    load(audioResumePosition(item.progress));
    // Fetch fresh state without delaying the native Play request. A late
    // response can update an unstarted resume, never rewind active listening.
    api.item(item.id).then(value => {
      if (destroyed) return;
      full = value;
      if (audioPlaybackIssue({ ...item, ...(value || {}) })) { stopUnsupportedAudio(); return; }
      if (!ready) resumePoint = audioResumePosition(value?.progress || item.progress);
      if (ready && audio.paused && currentTime === 0) {
        const resume = audioResumePosition(value?.progress);
        if (resume > 0 && resume < audio.duration) { audio.currentTime = resume; currentTime = resume; }
      }
    }).catch(() => {});
    timer = setInterval(() => { if (audio && !audio.paused && !audio.ended) saveProgress(); }, 5000);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('keydown', keydown);
    document.addEventListener('visibilitychange', onHidden);
  });
  onDestroy(() => {
    saveProgress(); destroyed = true; sequence++; cancelStartup(); clearInterval(timer);
    window.removeEventListener('pagehide', onPageHide); window.removeEventListener('keydown', keydown);
    document.removeEventListener('visibilitychange', onHidden);
    audio?.pause(); audio?.removeAttribute('src'); audio?.load();
    document.body.style.overflow = previousOverflow;
  });
</script>

<div class="audio-player" role="dialog" aria-modal="true" aria-label="Audio player" tabindex="-1">
  <div class="panel">
    <button class="close ghost" bind:this={closeButton} onclick={close} aria-label="Close audio player">✕ Close</button>
    <div class="artwork">
      {#if artwork && !posterFailed}<img src={artwork} alt="" onerror={() => { posterFailed = true; }} />
      {:else}<span aria-hidden="true">♫</span>{/if}
    </div>
    <span class="kind">AUDIO</span>
    <h1>{title}</h1>
    {#if full?.artist || item.artist}<p class="artist">{full?.artist || item.artist}</p>{/if}
    {#if playbackIssue}
      <div class="compatibility" role="status"><h2>Compatible audiobook needed</h2><p>{playbackIssue}</p></div>
    {:else}
    <audio bind:this={audio} controls preload="metadata"
      onloadedmetadata={() => { duration = Number.isFinite(audio.duration) ? audio.duration : 0; }}
      ondurationchange={() => { duration = Number.isFinite(audio.duration) ? audio.duration : 0; }}
      ontimeupdate={() => { if (ready) { currentTime = audio.currentTime; teardownSaved = false; } }}
      onplaying={() => { notice = ''; error = ''; audio.playbackRate = speed; }}
      onpause={() => saveProgress()}
      onseeked={() => { currentTime = audio.currentTime; saveProgress(); }}
      onended={() => saveProgress(true)}
      onerror={() => { cancelStartup(); error = audioPlaybackError(audio?.error); notice = ''; }}
    ></audio>
    <p class="time">{audioTime(currentTime)} / {audioTime(duration)}</p>
    <div class="extras">
      <button class="ghost" onclick={() => seek(-15)} disabled={!ready} aria-label="Back 15 seconds">↶ 15 seconds</button>
      <label>Speed <select bind:value={speed} onchange={() => { if (audio) audio.playbackRate = Number(speed); }}>
        {#each [0.75, 1, 1.25, 1.5, 1.75, 2] as rate}<option value={rate}>{rate}×</option>{/each}
      </select></label>
      <button class="ghost" onclick={() => seek(30)} disabled={!ready} aria-label="Forward 30 seconds">30 seconds ↷</button>
    </div>
    {#if notice && !error}<p class="notice" role="status">{notice}</p>{/if}
    {#if error}<div class="error" role="alert"><p>{error}</p><button class="ghost" onclick={() => load(currentTime)}>Retry</button></div>{/if}
    {/if}
  </div>
</div>

<style>
  .audio-player {position:fixed;inset:0;z-index:90;overflow:auto;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at top,#342447,var(--bg,#121217) 70%);color:var(--ink,#fff);}
  .panel {width:min(100%,600px);text-align:center;position:relative;padding:54px 20px 24px;}
  .close {position:absolute;right:0;top:0;}
  .artwork {width:min(65vw,270px);aspect-ratio:1;margin:0 auto 24px;border-radius:20px;overflow:hidden;display:grid;place-items:center;background:#ffffff12;border:1px solid var(--line);}
  .artwork img {width:100%;height:100%;object-fit:cover;}
  .artwork span {font-size:7rem;color:#bd9cff;}
  .kind {font-size:.7rem;letter-spacing:.16em;color:var(--ink-soft);}
  h1 {font-size:clamp(1.4rem,4vw,2rem);line-height:1.25;margin:8px 0 20px;}
  .artist {margin:-10px 0 20px;color:var(--ink-soft);}
  audio {width:100%;}
  .time,.notice {color:var(--ink-soft);font-size:.9rem;margin:12px 0;}
  .extras {display:flex;justify-content:center;align-items:center;gap:14px;flex-wrap:wrap;margin-top:20px;font-size:.85rem;}
  select {color:var(--ink);background:var(--bg-raised);border:1px solid var(--line);border-radius:8px;padding:8px;}
  .error {padding:16px;margin-top:20px;border:1px solid #b06d78;border-radius:12px;}
  .error button {margin-top:12px;}
  .compatibility {padding:20px;border:1px solid #bd9cff;border-radius:12px;line-height:1.6;}
  .compatibility h2 {font-size:1rem;margin-bottom:8px;}
  button:focus-visible,select:focus-visible {outline:3px solid #bd9cff;outline-offset:4px;}
  button:disabled {opacity:.5;}
  @media(max-width:480px){.audio-player{padding:16px;}.panel{padding-inline:0;}.extras{gap:10px;}}
</style>
