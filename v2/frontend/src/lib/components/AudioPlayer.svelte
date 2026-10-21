<script>
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { api, posterUrl } from '../api.js';
  import { session, updateWatchState, dismissed, AUTO_WATCHED_PERCENT } from '../stores.js';
  import { readAlongIds, loadReadAlongIds } from '../home-data.js';
  import { audioProgressPayload, audioResumePosition, audioPlaybackError, audioPlaybackIssue, startAudioPlayback, audioTime } from '../audio-playback.js';
  import { audioPresentation, audioRemaining, audioChapters, activeAudioChapter, audioChapterLabel } from '../audio-presentation.js';
  import { mergeAudioDetail } from '../audio-detail.js';
  import { fmtBytes } from '../dashboard-format.js';
  import { AUDIO_SPEEDS, rememberedAudioSpeed, rememberedAudioVolume, rememberAudioVolume, rememberedAudioMuted, rememberAudioMuted, audioBookmarks, createSleepTimer } from '../listening-tools.js';
  import { DATA_SAVER_POLL_MS, DATA_SAVER_MAX_BACKOFF_MS, DATA_SAVER_RETRY_FAILED_MS, rememberedDataSaver, rememberDataSaver, dataSaverFormat, rememberDataSaverFailure,
    forgetDataSaverFailures, dataSaverCopy, dataSaverMessage, originalMegabytesPerHour, copyDownloads } from '../audio-data-saver.js';
  import AudioReadAlong from './AudioReadAlong.svelte';

  // startReading: opened from Home's "Read along", so the text panel starts open.
  let { item, onclose, minimized = false, onminimize, onexpand, startReading = false } = $props();
  let audio = $state(null), dialog = $state(null), closeButton = $state(null);
  let error = $state(''), notice = $state('Loading audio…');
  let currentTime = $state(0), duration = $state(0), speed = $state(1), volume = $state(rememberedAudioVolume()), muted = $state(rememberedAudioMuted());
  let playing = $state(false), ready = $state(false), full = $state(null), artworkIndex = $state(0);
  let readAlongOpen = $state(untrack(() => startReading));
  // Read along opens by itself for a book that has reading text, unless the listener closed it
  // (remembered on this device until they open it again).
  const READ_ALONG_PREF = 'v2ReadAlongAuto';
  let readAlongChosen = false;
  const readAlongWanted = () => { try { return localStorage.getItem(READ_ALONG_PREF) !== 'off'; } catch { return true; } };
  function toggleReadAlong() {
    readAlongOpen = !readAlongOpen; readAlongChosen = true;
    try { localStorage.setItem(READ_ALONG_PREF, readAlongOpen ? 'on' : 'off'); } catch { /* private window */ }
  }
  $effect(() => { loadReadAlongIds(); });
  $effect(() => { item.id; readAlongChosen = false; });
  $effect(() => { if ($readAlongIds.has(item.id) && !readAlongChosen && !readAlongOpen && readAlongWanted()) readAlongOpen = true; });
  // Data saver: liteSource is the smaller copy now loaded (null = the original);
  // pendingLite is a ready copy waiting for a safe moment to switch to.
  let dataSaver = $state(rememberedDataSaver()), liteFormat = $state(null), liteStatus = $state(null);
  let liteSource = $state(null), pendingLite = $state(null), litePoll, liteAttempt = 0, startPending = false;
  // unreachableWait backs off status checks while the server can't be reached;
  // liteBlocked holds back a copy whose download just failed ({ url, wait, until }).
  let unreachableWait = DATA_SAVER_POLL_MS, liteBlocked = null, loadAutoplay = true;
  const book = $derived(mergeAudioDetail(item, full));
  const presentation = $derived(audioPresentation(book));
  const title = $derived(presentation.title);
  const artworkSources = $derived([...new Set([posterUrl(full), posterUrl(item), presentation.coverUrl].filter(Boolean))]);
  const artwork = $derived(artworkSources[artworkIndex] || '');
  const artworkKey = $derived(artworkSources.join('\n'));
  $effect(() => { artworkKey; artworkIndex = 0; });
  const playbackIssue = $derived(audioPlaybackIssue(book));
  const totalTime = $derived(duration || presentation.duration || 0);
  const position = $derived(totalTime ? Math.min(currentTime, totalTime) : 0);
  const percent = $derived(totalTime ? Math.max(0, Math.min(100, position / totalTime * 100)) : 0);
  const chapters = $derived(audioChapters(book.audioMetadata?.chapters, totalTime));
  const chapterIndex = $derived(activeAudioChapter(chapters, position));
  const dataSaverText = $derived(dataSaverMessage({ on: dataSaver, format: liteFormat, status: liteStatus, active: !!liteSource,
    pending: !!pendingLite, original: originalMegabytesPerHour(book, totalTime) }));
  let sleepChoice = $state('off'), sleepPlan = $state(null), clock = $state(Date.now());
  const sleepRemaining = $derived(sleepPlan?.deadline ? Math.max(0, Math.ceil((sleepPlan.deadline - clock) / 60000)) : 0);
  let bookmarks = $state([]), bookmarkLabel = $state(''), bookmarkBusy = $state(false), bookmarksLoading = $state(true);
  let bookmarkError = $state(''), preferenceError = $state(''), speedTouched = false;
  let destroyed = false, sequence = 0, profile = null, opener, userPlaybackIntent = false;
  let cancelStartup = () => {}, timer, clockTimer, teardownSaved = false, resumePoint = 0;
  const sleep = createSleepTimer({ onChange: plan => { sleepPlan = plan; }, onExpire: plan => {
    sleepChoice = 'off';
    if (plan.mode === 'chapter' && ready && audio) audio.currentTime = Math.min(plan.end, audio.duration);
    audio?.pause(); notice = 'Sleep timer paused playback.'; saveProgress();
  } });

  $effect(() => {
    if (minimized) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  });

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

  function load(start = 0, source = null, autoplay = true) {
    const attempt = ++sequence;
    cancelStartup(); ready = false; error = ''; notice = 'Loading audio…';
    if (playbackIssue) { notice = ''; return; }
    resumePoint = start; liteSource = source; loadAutoplay = autoplay;
    cancelStartup = startAudioPlayback(audio, item, start, { source, autoplay,
      isCurrent: () => !destroyed && sequence === attempt,
      onMetadata: value => {
        duration = value;
        audio.currentTime = value > 0 && resumePoint >= value ? 0 : resumePoint;
        currentTime = audio.currentTime; ready = true; audio.playbackRate = speed; audio.volume = volume; audio.muted = muted;
        if (!autoplay) notice = '';
      },
      onBlocked: () => { notice = 'Press Play to listen.'; },
      onSlow: () => { notice = 'Waiting for audio…'; },
      onTimeout: () => { error = 'Audio is taking longer than expected. Retry or check the server connection.'; notice = ''; },
      onError: message => { error = message; notice = ''; },
    });
  }
  // Where to continue from when the source changes: the live position once
  // playing, otherwise the resume point that a load is still heading for.
  const switchPoint = () => ready && audio ? audio.currentTime || currentTime : resumePoint;
  // Whether the listener wants sound: what the element is doing once a source
  // has loaded, otherwise what the load under way was asked to do. ("Not ready"
  // alone says nothing: a paused source switch is not ready either.)
  const wantsPlayback = () => ready ? playing : loadAutoplay;
  async function liteRequest(prepare) {
    const attempt = liteAttempt, format = liteFormat;
    try {
      const value = await (prepare ? api.audioLitePrepare(item.id, format.variant) : api.audioLite(item.id, format.variant));
      if (destroyed || attempt !== liteAttempt) return null;
      liteStatus = value; return value;
    } catch {
      if (!destroyed && attempt === liteAttempt) liteStatus = { state: 'unreachable' };
      return null;
    }
  }
  // Asks for this book's smaller copy if needed, follows its preparation, and
  // moves to it once it is ready. The original keeps playing meanwhile.
  async function followLite(known = null) {
    clearTimeout(litePoll);
    if (!dataSaver || !liteFormat || playbackIssue) return;
    const attempt = liteAttempt;
    let status = known || await liteRequest(false);
    if (status && (status.state === 'none' || status.state === 'failed')) status = await liteRequest(true);
    if (destroyed || attempt !== liteAttempt) return;
    const copy = dataSaverCopy(status, liteFormat);
    const blockedFor = copy && liteBlocked?.url === copy.url ? liteBlocked.until - Date.now() : 0;
    if (copy && blockedFor <= 0) { useLite(copy); return; }
    if (blockedFor > 0) liteStatus = { state: 'retrying' };
    // Keep following: the copy may still be in the making, the server may be
    // restarting (it forgets a copy in the making, and the request above asks
    // again), or the copy's last download failed and gets another go later.
    let delay;
    if (!status) { delay = unreachableWait; unreachableWait = Math.min(unreachableWait * 2, DATA_SAVER_MAX_BACKOFF_MS); }
    else {
      unreachableWait = DATA_SAVER_POLL_MS;
      delay = blockedFor > 0 ? blockedFor : status.state === 'failed' ? DATA_SAVER_RETRY_FAILED_MS : DATA_SAVER_POLL_MS;
    }
    litePoll = setTimeout(() => followLite(), delay);
  }
  function useLite(copy) {
    if (liteSource?.url === copy.url) { pendingLite = null; return; }
    // Nothing to gain in the last seconds, and a copy a few ms shorter than the
    // original would restart a finished book from 0.
    if (audio?.ended || (ready && duration > 0 && switchPoint() > duration - 2)) { pendingLite = null; return; }
    // Changing the source behind a locked screen can cost the phone its
    // lock-screen controls (the next headphone "play" does nothing), so the
    // switch waits until the listener looks at the player, playing or paused.
    if (document.visibilityState === 'hidden') { pendingLite = copy; return; }
    pendingLite = null;
    load(switchPoint(), copy, wantsPlayback());
  }
  function useOriginal(autoplay) {
    pendingLite = null;
    load(switchPoint(), null, autoplay);
  }
  async function startWithDataSaver(start) {
    resumePoint = start; notice = 'Loading audio…'; startPending = true;
    // Checking first means a ready copy plays without touching the original,
    // whose index alone is ~10 MB for a long book. A slow answer must not hold
    // up listening, though.
    const status = await Promise.race([liteRequest(false), new Promise(resolve => setTimeout(resolve, 3000, null))]);
    startPending = false;
    if (destroyed) return;
    // The switch may have been flipped meanwhile: whatever it says now wins.
    const copy = dataSaver ? dataSaverCopy(status, liteFormat) : null;
    load(resumePoint, copy);
    if (dataSaver && !copy) followLite(status?.variant === liteFormat?.variant ? status : null);
  }
  function setDataSaver(on) {
    dataSaver = rememberDataSaver(on);
    if (on) forgetDataSaverFailures();
    liteAttempt++; clearTimeout(litePoll); pendingLite = null; liteStatus = null; liteBlocked = null;
    liteFormat = dataSaver ? dataSaverFormat(audio) : null;
    if (startPending) return;   // the start under way reads the switch when it finishes
    if (dataSaver) followLite();
    else if (liteSource) useOriginal(wantsPlayback());
  }
  // A copy the browser rejected. If the copy was remade meanwhile, its old link
  // simply went away: play the new one. Otherwise fetch a small part of it: if
  // that arrives as audio, this device cannot play the format (canPlayType only
  // promises "maybe"), so remember that and try the next format; if it does
  // not, the download failed (server restarting, signal lost), so play the
  // original for now and give the copy another go later.
  async function liteFailed() {
    const failed = liteSource, at = switchPoint(), resume = wantsPlayback();
    liteAttempt++; clearTimeout(litePoll);
    const attempt = liteAttempt;
    sequence++; cancelStartup(); notice = 'Loading audio…';
    const status = await liteRequest(false);
    if (destroyed || attempt !== liteAttempt) return;
    const copy = dataSaverCopy(status, liteFormat);
    if (copy && copy.url !== failed.url) { load(at, copy, resume); return; }
    let next = null;
    if (copy) {
      const downloads = await copyDownloads(failed.url);
      if (destroyed || attempt !== liteAttempt) return;
      if (downloads) {
        rememberDataSaverFailure(failed.variant); liteFormat = dataSaverFormat(audio);
        if (dataSaver && liteFormat) { next = await liteRequest(false); if (destroyed || attempt !== liteAttempt) return; }
        const nextCopy = dataSaverCopy(next, liteFormat);
        if (nextCopy) { load(at, nextCopy, resume); return; }
        liteStatus = { state: 'unplayable' };
      } else {
        const wait = Math.min(liteBlocked?.url === failed.url ? liteBlocked.wait * 2 : DATA_SAVER_POLL_MS, DATA_SAVER_MAX_BACKOFF_MS);
        liteBlocked = { url: failed.url, wait, until: Date.now() + wait };
      }
    }
    load(at, null, resume);
    if (dataSaver && liteFormat) followLite(next || (copy ? null : status));
  }
  function stopUnsupportedAudio() {
    sequence++; cancelStartup(); ready = false; notice = ''; error = '';
    audio?.pause(); audio?.removeAttribute('src'); audio?.load();
  }
  function seekTo(seconds) {
    if (!ready || !audio || !Number.isFinite(audio.duration)) return;
    userPlaybackIntent = true;
    audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
    currentTime = audio.currentTime; saveProgress();
  }
  function seek(seconds) { seekTo((audio?.currentTime || 0) + seconds); }
  async function togglePlayback() {
    if (!audio || playbackIssue) return;
    userPlaybackIntent = true;
    if (!audio.paused && !audio.ended) { audio.pause(); return; }
    if (audio.ended) seekTo(0);
    const attempt = sequence;
    try { await audio.play(); }
    catch (failure) {
      if (destroyed || sequence !== attempt) return;
      if (failure.name === 'NotAllowedError') notice = 'Press Play to listen.';
      else { error = 'Could not start the audio. Please retry.'; notice = ''; }
    }
  }
  function setVolume(value) {
    volume = rememberAudioVolume(value);
    muted = rememberAudioMuted(false);
    if (audio) { audio.muted = false; audio.volume = volume; }
  }
  function toggleMute() {
    muted = rememberAudioMuted(!muted);
    if (audio) audio.muted = muted;
  }
  async function setSpeed(value) {
    speedTouched = true; speed = rememberedAudioSpeed(value); preferenceError = '';
    if (audio) audio.playbackRate = speed;
    try { await api.audioPreferencesUpdate({ speed }); }
    catch { if (!destroyed && $session?.profileId === profile) preferenceError = 'Speed changed, but could not be remembered. Try again.'; }
  }
  async function loadBookmarks() {
    bookmarksLoading = true; bookmarkError = '';
    try {
      const value = await api.audioBookmarks(item.id);
      if (!destroyed && $session?.profileId === profile) bookmarks = audioBookmarks(value);
    } catch { if (!destroyed && $session?.profileId === profile) bookmarkError = 'Could not load bookmarks. Please retry.'; }
    finally { if (!destroyed) bookmarksLoading = false; }
  }
  async function addBookmark() {
    if (!ready || bookmarkBusy || $session?.profileId !== profile) return;
    bookmarkBusy = true; bookmarkError = '';
    const time = Math.max(0, audio.currentTime);
    const label = bookmarkLabel.trim() || chapters[chapterIndex]?.title || `Bookmark at ${audioTime(time)}`;
    try {
      const value = await api.audioBookmarkAdd(item.id, { time, label });
      if (!destroyed && $session?.profileId === profile) { bookmarks = audioBookmarks(value); bookmarkLabel = ''; }
    } catch { if (!destroyed && $session?.profileId === profile) bookmarkError = 'Bookmark was not saved. Please retry.'; }
    finally { if (!destroyed) bookmarkBusy = false; }
  }
  async function removeBookmark(bookmarkId) {
    if (bookmarkBusy || $session?.profileId !== profile) return;
    bookmarkBusy = true; bookmarkError = '';
    try {
      const value = await api.audioBookmarkRemove(item.id, bookmarkId);
      if (!destroyed && $session?.profileId === profile) bookmarks = audioBookmarks(value);
    } catch { if (!destroyed && $session?.profileId === profile) bookmarkError = 'Bookmark could not be removed. Please retry.'; }
    finally { if (!destroyed) bookmarkBusy = false; }
  }
  function setSleep(value) {
    sleepChoice = value; clock = Date.now();
    if (!sleep.set(value, chapters[chapterIndex]?.end)) sleepChoice = 'off';
  }
  function minimize() { saveProgress(); onminimize?.(); if (opener?.isConnected) opener.focus?.(); }
  async function expand() { onexpand?.(); await tick(); closeButton?.focus(); }
  function close() { saveProgress(); onclose?.(); }
  function onHidden() {
    if (document.visibilityState === 'hidden') saveProgress(false, true);
    else if (pendingLite) useLite(pendingLite);
  }
  function onPageHide() { saveProgress(false, true); }
  function keydown(event) {
    if (minimized && !dialog?.contains(event.target)) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') {
      const focusable = [...(dialog?.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') || [])]
        .filter(element => element.getClientRects().length && !element.closest('[hidden],[inert]'));
      const first = focusable[0], last = focusable.at(-1), outside = !dialog?.contains(document.activeElement);
      if (!first) { event.preventDefault(); dialog?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.('button,a,input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="slider"]')) return;
    if (event.key === ' ') { event.preventDefault(); togglePlayback(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(-15); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seek(30); }
  }

  onMount(() => {
    profile = $session?.profileId; opener = document.activeElement;
    closeButton?.focus();
    liteFormat = dataSaver ? dataSaverFormat(audio) : null;
    if (dataSaver && liteFormat && !playbackIssue) startWithDataSaver(audioResumePosition(item.progress));
    else load(audioResumePosition(item.progress));
    api.audioPreferences().then(value => {
      if (!destroyed && $session?.profileId === profile && !speedTouched) {
        speed = rememberedAudioSpeed(value?.speed); if (audio) audio.playbackRate = speed;
      }
    }).catch(() => {});
    loadBookmarks();
    // Fresh metadata must never delay autoplay or rewind active listening.
    api.item(item.id).then(value => {
      if (destroyed) return;
      full = value;
      if (audioPlaybackIssue({ ...item, ...(value || {}) })) { stopUnsupportedAudio(); return; }
      if (!ready && !userPlaybackIntent) resumePoint = audioResumePosition(value?.progress || item.progress);
      if (ready && audio.paused && currentTime === 0 && !userPlaybackIntent) {
        const resume = audioResumePosition(value?.progress);
        if (resume > 0 && resume < audio.duration) { audio.currentTime = resume; currentTime = resume; }
      }
    }).catch(() => {});
    timer = setInterval(() => { if (audio && !audio.paused && !audio.ended) saveProgress(); }, 5000);
    clockTimer = setInterval(() => { clock = Date.now(); sleep.position(audio?.currentTime || 0); }, 1000);
    window.addEventListener('pagehide', onPageHide); window.addEventListener('keydown', keydown);
    document.addEventListener('visibilitychange', onHidden);
  });
  onDestroy(() => {
    saveProgress(); destroyed = true; sequence++; cancelStartup(); clearInterval(timer); clearInterval(clockTimer); clearTimeout(litePoll); sleep.destroy();
    window.removeEventListener('pagehide', onPageHide); window.removeEventListener('keydown', keydown);
    document.removeEventListener('visibilitychange', onHidden);
    audio?.pause(); audio?.removeAttribute('src'); audio?.load();
    if (opener?.isConnected) opener.focus?.();
  });
</script>

<div class="audio-player" class:minimized role={minimized ? 'region' : 'dialog'} aria-modal={minimized ? undefined : 'true'} aria-label={minimized ? 'Audio mini player' : 'Audio player'} tabindex="-1" bind:this={dialog}>
  {#if artwork && !minimized}<div class="ambient" aria-hidden="true" style={`--cover:url("${artwork.replace(/"/g, '%22')}")`}></div>{/if}
  <div class="panel" class:reading={readAlongOpen} hidden={minimized}>
    <header class="listening-header">
      <span class="listening-label"><span class="listening-dot" class:playing aria-hidden="true"></span>Now listening</span>
      <div class="header-actions"><button class="close reader-toggle" class:active={readAlongOpen} aria-expanded={readAlongOpen} onclick={toggleReadAlong}>Read along</button><button class="close" onclick={minimize} aria-label="Minimize audio player">Browse while listening</button><button class="close" bind:this={closeButton} onclick={close} aria-label="Close audio player"><span aria-hidden="true">✕</span> Close</button></div>
    </header>
    <div class="player-content">
    <div class="listening-body">
      <div class="artwork">
        {#if artwork}<img src={artwork} alt={`Cover of ${title}`} onerror={() => { artworkIndex++; }} />
        {:else}
          <div class="book-cover" aria-label={`Audiobook: ${title}`}>
            <span class="cover-kind">AUDIOBOOK</span><span class="cover-title">{title}</span>
            {#if presentation.artist}<span class="cover-artist">{presentation.artist}</span>{/if}
            <span class="cover-lines" aria-hidden="true"></span>
          </div>
        {/if}
      </div>
      <div class="listening-main">
        <div class="book-info">
          <span class="kind">AUDIOBOOK</span><h1>{title}</h1>
          {#if presentation.artist}<p class="artist">{presentation.artist}</p>{/if}
          {#if presentation.album}<p class="album">{presentation.album}</p>{/if}
        </div>
        {#if playbackIssue}
          <div class="compatibility" role="status"><h2>Compatible audiobook needed</h2><p>{playbackIssue}</p></div>
        {:else}
          <audio bind:this={audio} hidden preload="metadata"
            onloadedmetadata={() => { duration = Number.isFinite(audio.duration) ? audio.duration : 0; }}
            ondurationchange={() => { duration = Number.isFinite(audio.duration) ? audio.duration : 0; }}
            ontimeupdate={() => { if (ready) { currentTime = audio.currentTime; teardownSaved = false; sleep.position(currentTime); } }}
            onplay={() => { playing = !audio.paused; }}
            onplaying={() => { playing = true; notice = ''; error = ''; audio.playbackRate = speed; if (liteSource) liteBlocked = null; }}
            onwaiting={() => { if (!error) notice = 'Buffering audio…'; }}
            onpause={() => { playing = false; saveProgress(); }}
            onseeked={() => { currentTime = audio.currentTime; saveProgress(); }}
            onvolumechange={() => { volume = audio.volume; muted = audio.muted; }}
            onratechange={() => { speed = audio.playbackRate; }}
            onended={() => { playing = false; sleep.clear(); sleepChoice = 'off'; notice = 'Finished listening.'; saveProgress(true); }}
            onerror={() => {
              // Only a format or decode error says the copy is unplayable here; a
              // network drop on a walk is retried like any other.
              if (liteSource && [3, 4].includes(audio?.error?.code)) { liteFailed(); return; }
              cancelStartup(); playing = !audio.paused; error = audioPlaybackError(audio?.error); notice = '';
            }}
          ></audio>
          <div class="timeline">
            <input class="position" type="range" min="0" max={totalTime || 1} step="1" value={position} disabled={!ready || !totalTime}
              style={`--fill:${percent}%`} aria-label="Playback position" aria-valuetext={`${audioTime(position)} of ${audioTime(totalTime)}`}
              oninput={(event) => seekTo(Number(event.currentTarget.value))} />
            <div class="times"><span>{audioTime(position)}</span><span>{totalTime ? audioRemaining(Math.max(0, totalTime - position)) : 'Duration loading…'}</span></div>
          </div>
          <div class="transport">
            <button class="skip" onclick={() => seek(-15)} disabled={!ready} aria-label="Back 15 seconds"><span class="skip-arrow" aria-hidden="true">↶</span><span>15</span></button>
            <button class="play-pause" onclick={togglePlayback} disabled={!audio || !!error} aria-label={playing ? 'Pause audio' : 'Play audio'}>
              {#if playing}<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
              {:else}<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>{/if}
            </button>
            <button class="skip" onclick={() => seek(30)} disabled={!ready} aria-label="Forward 30 seconds"><span class="skip-arrow" aria-hidden="true">↷</span><span>30</span></button>
          </div>
          <div class="settings">
            <label class="speed">Speed <select aria-label="Speed" value={speed} onchange={(event) => setSpeed(event.currentTarget.value)}>
              {#each AUDIO_SPEEDS as rate}<option value={rate}>{rate}×</option>{/each}
            </select></label>
            <div class="volume">
              <button type="button" class="mute" onclick={toggleMute} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                  {#if muted}<path d="M3 9v6h4l5 4V5L7 9zm13.59 3L14 9.41 15.41 8 18 10.59 20.59 8 22 9.41 19.41 12 22 14.59 20.59 16 18 13.41 15.41 16 14 14.59z"/>
                  {:else}<path d="M3 9v6h4l5 4V5L7 9zm12-1v8a5 5 0 0 0 0-8zm0-4v2a7 7 0 0 1 0 12v2a9 9 0 0 0 0-16z"/>{/if}
                </svg>
              </button>
              <input type="range" min="0" max="1" step="0.05" aria-label="Volume" value={muted ? 0 : volume} style={`--fill:${(muted ? 0 : volume) * 100}%`} aria-valuetext={muted ? 'Muted' : `${Math.round(volume * 100)} percent`} oninput={(event) => setVolume(event.currentTarget.value)} />
            </div>
          </div>
          {#if preferenceError}<p class="tool-error" role="status">{preferenceError}</p>{/if}
          {#if chapters.length}
            <label class="chapter-picker"><span>Chapter <small>{chapterIndex + 1} of {chapters.length}</small></span><select aria-label="Chapter" value={String(chapterIndex)} disabled={!ready} onchange={(event) => seekTo(chapters[Number(event.currentTarget.value)].start)}>
              {#each chapters as chapter, index (chapter.start)}<option value={String(index)}>{audioChapterLabel(chapter)}</option>{/each}
            </select></label>
          {/if}
          <div class="listening-tools">
            <div class="data-saver">
              <label class="data-saver-toggle"><span>Data saver <small>smaller audio for mobile data</small></span><input type="checkbox" role="switch" checked={dataSaver} onchange={(event) => setDataSaver(event.currentTarget.checked)} /></label>
              {#if dataSaverText}<p class="data-saver-status" role="status">{dataSaverText}</p>{/if}
            </div>
            <label class="sleep-picker">Sleep timer <select aria-label="Sleep timer" value={sleepChoice} onchange={(event) => setSleep(event.currentTarget.value)}>
              <option value="off">Off</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option>
              {#if chapters[chapterIndex]?.end}<option value="chapter">End of this chapter</option>{/if}
            </select></label>
            {#if sleepPlan}<p class="sleep-status" role="status">{sleepPlan.mode === 'chapter' ? 'Pauses at the end of this chapter.' : `Pauses in ${sleepRemaining} min.`}</p>{/if}
            <section class="bookmarks" aria-label="Audiobook bookmarks">
              <h2>Bookmarks</h2>
              <div class="bookmark-add"><input aria-label="Bookmark label" maxlength="120" placeholder="Optional bookmark label" bind:value={bookmarkLabel} /><button onclick={addBookmark} disabled={!ready || bookmarkBusy || bookmarksLoading}>Add bookmark</button></div>
              {#if bookmarksLoading}<p class="notice">Loading bookmarks…</p>{/if}
              {#if bookmarkError}<p class="tool-error" role="alert">{bookmarkError} <button onclick={loadBookmarks} disabled={bookmarkBusy}>Retry bookmarks</button></p>{/if}
              {#if bookmarks.length}<ul>{#each bookmarks as bookmark (bookmark.id)}<li><button class="bookmark-seek" onclick={() => seekTo(bookmark.time)} disabled={!ready}><span>{bookmark.label || 'Bookmark'}</span><small>{audioTime(bookmark.time)}</small></button><button class="bookmark-remove" disabled={bookmarkBusy || bookmarksLoading} aria-label={`Remove bookmark ${bookmark.label || audioTime(bookmark.time)}`} onclick={() => removeBookmark(bookmark.id)}>✕</button></li>{/each}</ul>{/if}
            </section>
            {#if $session?.role === 'admin' || $session?.permissions?.includes('canSaveMedia')}
              <a class="download-file" href={`/api/download/${encodeURIComponent(item.id)}`} download>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
                Download audiobook{item.fileSize ? ` · ${fmtBytes(item.fileSize)}` : ''}
              </a>
            {/if}
          </div>
          {#if notice && !error}<p class="notice" role="status">{notice}</p>{/if}
          {#if error}<div class="error" role="alert"><p>{error}</p><button onclick={() => load(switchPoint(), liteSource)}>Retry</button></div>{/if}
        {/if}
      </div>
    </div>
    {#if readAlongOpen}<AudioReadAlong itemId={item.id} {position} {ready} {audio} visible={!minimized} onseek={seekTo} />{/if}
    </div>
  </div>
  {#if minimized}
    <div class="mini-panel">
      <button class="mini-book" onclick={expand} aria-label="Expand audio player">{#if artwork}<img src={artwork} alt="" onerror={() => { artworkIndex++; }} />{/if}<span><strong>{title}</strong><small>{playbackIssue || error || notice || `${audioTime(position)} · ${audioTime(totalTime)}`}</small></span></button>
      <button class="mini-control" onclick={() => seek(-15)} disabled={!ready} aria-label="Back 15 seconds">↶15</button>
      <button class="mini-control mini-play" onclick={togglePlayback} disabled={!audio || !!error || !!playbackIssue} aria-label={playing ? 'Pause audio' : 'Play audio'}>{playing ? 'Ⅱ' : '▶'}</button>
      <button class="mini-control mini-close" onclick={close} aria-label="Close audio player">✕</button>
    </div>
  {/if}
</div>

<style>
  .download-file { display: inline-flex; align-items: center; gap: 6px; margin-top: var(--s3); font-size: 0.85rem; font-weight: 600; color: var(--ink-soft); min-height: 44px; }
  .download-file:hover { color: var(--ink); }
  .audio-player { position:fixed; inset:0; z-index:90; overflow:auto; display:flex; align-items:center; justify-content:center; padding:32px; background:var(--bg,#0e0c0b); color:var(--ink,#fff); }
  /* The cover behind the panel: a static blur (no animation, no backdrop-filter -- the Linux/Firefox lag rule), darkened to the page at the edges. */
  .ambient { position:fixed; inset:0; overflow:hidden; pointer-events:none; }
  .ambient::before { content:''; position:absolute; inset:-60px; background:var(--cover) center / cover no-repeat; filter:blur(48px) saturate(1.15) brightness(.5); opacity:.6; }
  .ambient::after { content:''; position:absolute; inset:0; background:radial-gradient(ellipse at 50% 35%, rgba(14,12,11,.15), rgba(14,12,11,.9) 80%); }
  /* On a computer the top bar stays in view above the player, so the library is one click away while listening. */
  @media(min-width:721px) { .audio-player:not(.minimized) { top:64px; z-index:45; } .ambient { top:64px; } }
  .audio-player.minimized {inset:auto 0 0;overflow:visible;padding:0;background:transparent;}
  .panel[hidden] {display:none;}
  .header-actions {display:flex;align-items:center;gap:8px;}
  .mini-panel {display:flex;align-items:center;gap:10px;width:100%;padding:12px max(16px,var(--gutter));padding-bottom:calc(12px + env(safe-area-inset-bottom));background:#262119;border-top:1px solid #e8b04a66;box-shadow:0 -8px 30px #0005;}
  .mini-book {display:flex;align-items:center;gap:12px;flex:1;min-width:0;text-align:left;min-height:48px;}
  .mini-book img {width:48px;height:48px;object-fit:cover;border-radius:7px;}
  .mini-book span {display:flex;flex-direction:column;gap:4px;min-width:0;}
  .mini-book strong {font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .mini-book small {font-size:.72rem;color:#cdc3b5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .mini-control {flex-shrink:0;min-width:44px;min-height:44px;border-radius:8px;color:#efe3cf;}
  .mini-play {background:#e8b04a;color:#0e0c0b;font-size:1.25rem;}
  @media(max-width:720px) {.audio-player.minimized {bottom:calc(60px + env(safe-area-inset-bottom));}}
  .listening-tools {border-top:1px solid #ffffff15;margin-top:16px;padding-top:16px;}
  .sleep-picker {display:flex;align-items:center;justify-content:space-between;gap:12px;color:#cec4b5;font-size:.85rem;}
  .sleep-status {margin-top:8px;color:#cdc3b5;font-size:.8rem;}
  .data-saver {margin-bottom:14px;}
  .data-saver-toggle {display:flex;align-items:center;justify-content:space-between;gap:12px;color:#cec4b5;font-size:.85rem;min-height:40px;cursor:pointer;}
  .data-saver-toggle span {display:flex;flex-direction:column;gap:2px;}
  .data-saver-toggle small {color:#aaa091;font-size:.74rem;}
  .data-saver-toggle input {appearance:none;-webkit-appearance:none;position:relative;flex:none;width:44px;height:26px;margin:0;border-radius:13px;background:#ffffff26;cursor:pointer;transition:background .15s;}
  .data-saver-toggle input::after {content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#eeebe6;transition:transform .15s;}
  .data-saver-toggle input:checked {background:#b98428;}
  .data-saver-toggle input:checked::after {transform:translateX(18px);}
  .data-saver-toggle input:focus-visible {outline:3px solid #e8b04a;outline-offset:3px;}
  .data-saver-status {margin-top:6px;color:#cdc3b5;font-size:.8rem;line-height:1.45;}
  .bookmarks {margin-top:20px;}
  .bookmarks h2 {font-size:.95rem;margin-bottom:10px;}
  .bookmark-add {display:flex;gap:8px;flex-wrap:wrap;}
  .bookmark-add input {min-width:0;flex:1 1 180px;min-height:42px;border:1px solid #ffffff26;background:#2e2820;color:#f6f4f2;border-radius:8px;padding:9px 12px;font-size:.8rem;}
  .bookmark-add button {min-height:42px;padding:9px 12px;background:#ffffff10;border:1px solid #ffffff26;border-radius:8px;font-size:.8rem;}
  .bookmarks ul {list-style:none;margin:12px 0 0;padding:0;max-height:190px;overflow:auto;}
  .bookmarks li {display:flex;align-items:center;border-top:1px solid #ffffff0c;}
  .bookmark-seek {display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;flex:1;min-width:0;text-align:left;padding:8px 4px;font-size:.8rem;}
  .bookmark-seek span {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bookmark-seek small {color:#cdc3b5;font-variant-numeric:tabular-nums;}
  .bookmark-remove {min-width:44px;min-height:44px;color:#cdc3b5;}
  .tool-error {font-size:.8rem;line-height:1.5;color:#f4bcbe;margin-top:8px;}
  .tool-error button {text-decoration:underline;min-height:40px;}
  @media(max-width:600px) {.header-actions {gap:0;} .header-actions .close {font-size:.7rem;padding:8px;} .mini-panel {gap:6px;} .mini-book {gap:8px;} .mini-book img {width:38px;height:38px;} .mini-control {min-width:40px;} .mini-close {min-width:32px;} }
  .panel { position:relative; z-index:1; width:min(100%,960px); margin:auto; border:1px solid #ffffff17; border-radius:20px; background:linear-gradient(145deg,#2a241c,#1c1813 70%); box-shadow:0 28px 100px #0008; }
  .reader-toggle.active {background:#e8b04a25;color:#f3ddb0;}
  .panel.reading {width:min(100%,1360px);background:#121619;border-color:#ffffff14;}
  .reading .player-content {display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:24px;padding:24px;align-items:start;}
  .reading .listening-body {display:block;padding:0;}
  .reading .artwork {width:110px;margin:0 auto 20px;}
  .reading .book-info {text-align:center;}
  .reading h1 {font-size:1.35rem;}
  /* Two columns: chapter, data saver, sleep timer and bookmarks stay under the controls, beside the text. */
  .reading .listening-tools {margin-top:14px;padding-top:14px;}
  .reading .transport {margin:16px 0;}
  .listening-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 24px; border-bottom:1px solid #ffffff0e; }
  .listening-label { display:flex; align-items:center; gap:9px; font-size:.76rem; font-weight:650; letter-spacing:.1em; text-transform:uppercase; color:#cdc3b5; }
  .listening-dot { width:6px; height:6px; border-radius:50%; background:#7e7262; }
  .listening-dot.playing { background:#e8b04a; box-shadow:0 0 12px #e8b04a66; }
  .close { min-height:44px; padding:8px 12px; display:flex; align-items:center; gap:8px; border-radius:8px; color:#d2c9bc; font-size:.84rem; }
  .close:hover { background:#ffffff0b; color:var(--ink); }
  .listening-body { display:grid; grid-template-columns:224px minmax(0,1fr); gap:32px; padding:32px; align-items:start; }
  .artwork { width:100%; aspect-ratio:1; border-radius:12px; overflow:hidden; box-shadow:0 14px 35px #0006,0 0 0 1px #ffffff17; background:#41382b; }
  .artwork img { width:100%; height:100%; object-fit:cover; }
  .book-cover { position:relative; height:100%; display:flex; flex-direction:column; justify-content:center; gap:14px; padding:25px 24px 25px 30px; background:radial-gradient(circle at 85% 5%,#b07a3a66,transparent 65%),linear-gradient(135deg,#5a4128,#2a2016); }
  .book-cover::before { content:''; position:absolute; inset:0 auto 0 7px; width:2px; background:#ffe2b524; box-shadow:5px 0 15px #0004; }
  .cover-kind { color:#d8d0c5; font-size:.57rem; letter-spacing:.21em; font-weight:700; }
  .cover-title { font-family:Georgia,serif; font-size:clamp(1rem,2vw,1.45rem); font-weight:700; line-height:1.25; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:5; -webkit-box-orient:vertical; overflow:hidden; z-index:1; }
  .cover-artist { color:#e3ded6; font-size:.7rem; overflow-wrap:anywhere; z-index:1; }
  .cover-lines { position:absolute; width:150px; height:150px; border:1px solid #ffe2b513; border-radius:50%; bottom:-90px; right:-20px; box-shadow:0 0 0 18px #ffe2b509,0 0 0 36px #ffe2b506; }
  .listening-main { min-width:0; }
  .kind { font-size:.65rem; letter-spacing:.16em; color:#bdb09d; font-weight:650; }
  h1 { font-size:clamp(1.35rem,2.7vw,2rem); letter-spacing:-.025em; line-height:1.25; margin:8px 0 10px; overflow-wrap:anywhere; }
  .artist { color:#ddd6cd; font-size:.95rem; }
  .album { margin-top:6px; color:#ada59a; font-size:.8rem; }
  .timeline { margin-top:24px; }
  input[type='range'] { appearance:none; -webkit-appearance:none; min-width:0; width:100%; height:28px; margin:0; padding:0; border:0; box-shadow:none; border-radius:0; background:transparent; cursor:pointer; }
  input[type='range']::-webkit-slider-runnable-track { height:5px; border-radius:99px; background:linear-gradient(to right,#e8b04a var(--fill),#ffffff1c var(--fill)); }
  input[type='range']::-moz-range-track { height:5px; border-radius:99px; background:linear-gradient(to right,#e8b04a var(--fill),#ffffff1c var(--fill)); }
  input[type='range']::-webkit-slider-thumb { appearance:none; -webkit-appearance:none; height:15px; width:15px; margin-top:-5px; border-radius:50%; background:#f6e3bd; border:3px solid #e8b04a; box-shadow:0 2px 6px #0004; }
  input[type='range']::-moz-range-thumb { height:9px; width:9px; border-radius:50%; background:#f6e3bd; border:3px solid #e8b04a; }
  .times { display:flex; align-items:center; justify-content:space-between; gap:12px; color:#b4ab9f; font-size:.76rem; font-variant-numeric:tabular-nums; }
  .transport { display:flex; align-items:center; justify-content:center; gap:30px; margin:22px 0; }
  .play-pause { width:64px; height:64px; flex-shrink:0; display:grid; place-items:center; border-radius:50%; background:#e8b04a; color:#0e0c0b; box-shadow:0 7px 25px #e8b04a23; }
  .play-pause:hover:not(:disabled) { background:#f0c066; }
  .skip { min-width:54px; min-height:54px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0; color:#d6cdc1; font-size:.65rem; font-weight:700; border-radius:10px; }
  .skip:hover:not(:disabled) { background:#ffffff08; color:var(--ink); }
  .skip-arrow { font-size:2rem; line-height:1; }
  .settings { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:14px 0; border-top:1px solid #ffffff0d; }
  .speed { display:flex; align-items:center; gap:10px; color:#b4ab9f; font-size:.8rem; }
  select { color-scheme:dark; font:inherit; color:#f6f4f2; background:#2e2820; border:1px solid #ffffff26; border-radius:8px; min-height:42px; padding:7px 10px; cursor:pointer; max-width:100%; }
  select option { color:#f6f4f2; background:#2e2820; }
  select option:checked { color:#fff; background:#6b5130; }
  .volume { display:flex; align-items:center; gap:9px; width:145px; min-width:0; color:#b9ac9a; }
  .volume svg { flex-shrink:0; }
  .volume .mute { display:flex; align-items:center; justify-content:center; padding:2px; border:0; border-radius:6px;
    background:none; color:inherit; cursor:pointer; flex-shrink:0; }
  .volume .mute:hover { color:#ece8e2; }
  .volume .mute:focus-visible { outline:2px solid #e8b04a; outline-offset:2px; }
  .volume .mute[aria-pressed="true"] { color:#d08a8a; }
  .chapter-picker { display:flex; flex-direction:column; gap:8px; margin-top:12px; color:#b4ab9f; font-size:.8rem; }
  .chapter-picker > span { display:flex; justify-content:space-between; }
  .chapter-picker small { font-size:inherit; color:#9b9080; }
  .chapter-picker select { width:100%; }
  .notice { margin-top:14px; color:#cbc0b1; font-size:.82rem; }
  .error,.compatibility { padding:16px; margin-top:18px; border:1px solid #a9717c77; border-radius:12px; line-height:1.6; font-size:.88rem; }
  .error button { margin-top:12px; min-height:40px; border:1px solid #ffffff2b; border-radius:8px; padding:8px 16px; }
  .compatibility { border-color:#e8b04a66; }
  .compatibility h2 { font-size:1rem; margin-bottom:8px; }
  button:focus-visible,select:focus-visible,input:focus-visible { outline:3px solid #e8b04a; outline-offset:4px; }
  button:disabled,input:disabled,select:disabled { opacity:.45; cursor:default; }
  @media(max-width:640px) {
    .audio-player { padding:16px; align-items:flex-start; }
    .panel { margin:auto; border-radius:16px; }
    .listening-header { padding:10px 16px; }
    .listening-body { grid-template-columns:1fr; gap:22px; padding:24px; }
    .artwork { width:min(44vw,180px); margin:0 auto; }
    .book-cover { gap:9px; padding:18px 17px 18px 23px; }
    .cover-title { font-size:1rem; -webkit-line-clamp:4; }
    .cover-kind { font-size:.5rem; }
    .cover-artist { font-size:.59rem; }
    .book-info { text-align:center; }
    h1 { font-size:1.35rem; margin-top:7px; }
    .timeline { margin-top:21px; }
    .transport { margin:20px 0; }
    .settings { gap:16px; }
    .volume { width:125px; }
  }
  @media(max-width:900px) {
    .reading .player-content {grid-template-columns:1fr;padding:18px;gap:20px;}
    /* Stacked: the text comes straight after the controls; closing Read along brings the tools back. */
    .reading .listening-tools,.reading .chapter-picker {display:none;}
    .reading .artwork {display:none;}
    .reading .kind,.reading .album {display:none;}
    .reading .timeline {margin-top:12px;}
    .reading .transport {margin:12px 0;gap:24px;}
    .reading .play-pause {width:52px;height:52px;}
    .reading .settings {padding:8px 0 0;}
    .reading .listening-main {max-width:580px;margin:auto;}
  }
  @media(max-width:640px) {.listening-header {flex-wrap:wrap;gap:4px;}.header-actions {flex:1;justify-content:flex-end;}.reading .player-content {padding:12px;}.reading h1 {font-size:1.12rem;margin:0 0 5px;}.reading .artist {font-size:.8rem;}}
  @media(max-width:360px) { .audio-player { padding:10px; } .listening-body { padding:20px; } .volume { width:105px; } .speed { gap:7px; } }
</style>
