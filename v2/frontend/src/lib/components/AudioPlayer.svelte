<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { api, posterUrl } from '../api.js';
  import { session, updateWatchState, dismissed, AUTO_WATCHED_PERCENT } from '../stores.js';
  import { audioProgressPayload, audioResumePosition, audioPlaybackError, audioPlaybackIssue, startAudioPlayback, audioTime } from '../audio-playback.js';
  import { audioPresentation, audioRemaining, audioChapters, activeAudioChapter, audioChapterLabel } from '../audio-presentation.js';
  import { mergeAudioDetail } from '../audio-detail.js';
  import { AUDIO_SPEEDS, rememberedAudioSpeed, rememberedAudioVolume, rememberAudioVolume, audioBookmarks, createSleepTimer } from '../listening-tools.js';
  import AudioReadAlong from './AudioReadAlong.svelte';

  let { item, onclose, minimized = false, onminimize, onexpand } = $props();
  let audio = $state(null), dialog = $state(null), closeButton = $state(null);
  let error = $state(''), notice = $state('Loading audio…');
  let currentTime = $state(0), duration = $state(0), speed = $state(1), volume = $state(rememberedAudioVolume()), muted = $state(false);
  let playing = $state(false), ready = $state(false), full = $state(null), artworkIndex = $state(0);
  let readAlongOpen = $state(false);
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
        currentTime = audio.currentTime; ready = true; audio.playbackRate = speed; audio.volume = volume;
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
    if (audio) { audio.muted = false; audio.volume = volume; }
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
  function onHidden() { if (document.visibilityState === 'hidden') saveProgress(false, true); }
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
    load(audioResumePosition(item.progress));
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
    saveProgress(); destroyed = true; sequence++; cancelStartup(); clearInterval(timer); clearInterval(clockTimer); sleep.destroy();
    window.removeEventListener('pagehide', onPageHide); window.removeEventListener('keydown', keydown);
    document.removeEventListener('visibilitychange', onHidden);
    audio?.pause(); audio?.removeAttribute('src'); audio?.load();
    if (opener?.isConnected) opener.focus?.();
  });
</script>

<div class="audio-player" class:minimized role={minimized ? 'region' : 'dialog'} aria-modal={minimized ? undefined : 'true'} aria-label={minimized ? 'Audio mini player' : 'Audio player'} tabindex="-1" bind:this={dialog}>
  <div class="panel" class:reading={readAlongOpen} hidden={minimized}>
    <header class="listening-header">
      <span class="listening-label"><span class="listening-dot" class:playing aria-hidden="true"></span>Now listening</span>
      <div class="header-actions"><button class="close reader-toggle" class:active={readAlongOpen} aria-expanded={readAlongOpen} onclick={() => readAlongOpen = !readAlongOpen}>Read along</button><button class="close" onclick={minimize} aria-label="Minimize audio player">Browse while listening</button><button class="close" bind:this={closeButton} onclick={close} aria-label="Close audio player"><span aria-hidden="true">✕</span> Close</button></div>
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
            onplaying={() => { playing = true; notice = ''; error = ''; audio.playbackRate = speed; }}
            onwaiting={() => { if (!error) notice = 'Buffering audio…'; }}
            onpause={() => { playing = false; saveProgress(); }}
            onseeked={() => { currentTime = audio.currentTime; saveProgress(); }}
            onvolumechange={() => { volume = audio.volume; muted = audio.muted; }}
            onratechange={() => { speed = audio.playbackRate; }}
            onended={() => { playing = false; sleep.clear(); sleepChoice = 'off'; notice = 'Finished listening.'; saveProgress(true); }}
            onerror={() => { cancelStartup(); playing = !audio.paused; error = audioPlaybackError(audio?.error); notice = ''; }}
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
            <label class="volume"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9zm12-1v8a5 5 0 0 0 0-8zm0-4v2a7 7 0 0 1 0 12v2a9 9 0 0 0 0-16z"/></svg><span class="sr-only">Volume</span><input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} style={`--fill:${(muted ? 0 : volume) * 100}%`} aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} percent`} oninput={(event) => setVolume(event.currentTarget.value)} /></label>
          </div>
          {#if preferenceError}<p class="tool-error" role="status">{preferenceError}</p>{/if}
          {#if chapters.length}
            <label class="chapter-picker"><span>Chapter <small>{chapterIndex + 1} of {chapters.length}</small></span><select aria-label="Chapter" value={String(chapterIndex)} disabled={!ready} onchange={(event) => seekTo(chapters[Number(event.currentTarget.value)].start)}>
              {#each chapters as chapter, index (chapter.start)}<option value={String(index)}>{audioChapterLabel(chapter)}</option>{/each}
            </select></label>
          {/if}
          <div class="listening-tools">
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
          </div>
          {#if notice && !error}<p class="notice" role="status">{notice}</p>{/if}
          {#if error}<div class="error" role="alert"><p>{error}</p><button onclick={() => load(currentTime)}>Retry</button></div>{/if}
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
  .audio-player { position:fixed; inset:0; z-index:90; overflow:auto; display:flex; align-items:center; justify-content:center; padding:32px; background:radial-gradient(ellipse at 50% 20%,#241b36 0,#0c0b12 70%); color:var(--ink,#fff); }
  .audio-player.minimized {inset:auto 0 0;overflow:visible;padding:0;background:transparent;}
  .panel[hidden] {display:none;}
  .header-actions {display:flex;align-items:center;gap:8px;}
  .mini-panel {display:flex;align-items:center;gap:10px;width:100%;padding:12px max(16px,var(--gutter));padding-bottom:calc(12px + env(safe-area-inset-bottom));background:#1d1728;border-top:1px solid #bd9cff66;box-shadow:0 -8px 30px #0005;}
  .mini-book {display:flex;align-items:center;gap:12px;flex:1;min-width:0;text-align:left;min-height:48px;}
  .mini-book img {width:48px;height:48px;object-fit:cover;border-radius:7px;}
  .mini-book span {display:flex;flex-direction:column;gap:4px;min-width:0;}
  .mini-book strong {font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .mini-book small {font-size:.72rem;color:#bfb2d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .mini-control {flex-shrink:0;min-width:44px;min-height:44px;border-radius:8px;color:#dfcdff;}
  .mini-play {background:#bd9cff;color:#21162f;font-size:1.25rem;}
  @media(max-width:720px) {.audio-player.minimized {bottom:calc(60px + env(safe-area-inset-bottom));}}
  .listening-tools {border-top:1px solid #ffffff15;margin-top:16px;padding-top:16px;}
  .sleep-picker {display:flex;align-items:center;justify-content:space-between;gap:12px;color:#c2b5ce;font-size:.85rem;}
  .sleep-status {margin-top:8px;color:#bfb2d0;font-size:.8rem;}
  .bookmarks {margin-top:20px;}
  .bookmarks h2 {font-size:.95rem;margin-bottom:10px;}
  .bookmark-add {display:flex;gap:8px;flex-wrap:wrap;}
  .bookmark-add input {min-width:0;flex:1 1 180px;min-height:42px;border:1px solid #ffffff26;background:#24202e;color:#f4f1f7;border-radius:8px;padding:9px 12px;font-size:.8rem;}
  .bookmark-add button {min-height:42px;padding:9px 12px;background:#ffffff10;border:1px solid #ffffff26;border-radius:8px;font-size:.8rem;}
  .bookmarks ul {list-style:none;margin:12px 0 0;padding:0;max-height:190px;overflow:auto;}
  .bookmarks li {display:flex;align-items:center;border-top:1px solid #ffffff0c;}
  .bookmark-seek {display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;flex:1;min-width:0;text-align:left;padding:8px 4px;font-size:.8rem;}
  .bookmark-seek span {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bookmark-seek small {color:#bfb2d0;font-variant-numeric:tabular-nums;}
  .bookmark-remove {min-width:44px;min-height:44px;color:#bfb2d0;}
  .tool-error {font-size:.8rem;line-height:1.5;color:#f4bcbe;margin-top:8px;}
  .tool-error button {text-decoration:underline;min-height:40px;}
  @media(max-width:600px) {.header-actions {gap:0;} .header-actions .close {font-size:.7rem;padding:8px;} .mini-panel {gap:6px;} .mini-book {gap:8px;} .mini-book img {width:38px;height:38px;} .mini-control {min-width:40px;} .mini-close {min-width:32px;} }
  .panel { width:min(100%,960px); margin:auto; border:1px solid #ffffff17; border-radius:20px; background:linear-gradient(145deg,#201b2b,#15121d 70%); box-shadow:0 28px 100px #0008; }
  .reader-toggle.active {background:#bd9cff25;color:#e1cbff;}
  .panel.reading {width:min(100%,1360px);}
  .reading .player-content {display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:24px;padding:24px;align-items:start;}
  .reading .listening-body {display:block;padding:0;}
  .reading .artwork {width:110px;margin:0 auto 20px;}
  .reading .book-info {text-align:center;}
  .reading h1 {font-size:1.35rem;}
  .reading .listening-tools,.reading .chapter-picker {display:none;}
  .reading .transport {margin:16px 0;}
  .listening-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 24px; border-bottom:1px solid #ffffff0e; }
  .listening-label { display:flex; align-items:center; gap:9px; font-size:.76rem; font-weight:650; letter-spacing:.1em; text-transform:uppercase; color:#bfb2d0; }
  .listening-dot { width:6px; height:6px; border-radius:50%; background:#6e627e; }
  .listening-dot.playing { background:#be9dff; box-shadow:0 0 12px #be9dff66; }
  .close { min-height:44px; padding:8px 12px; display:flex; align-items:center; gap:8px; border-radius:8px; color:#c6bcd2; font-size:.84rem; }
  .close:hover { background:#ffffff0b; color:var(--ink); }
  .listening-body { display:grid; grid-template-columns:224px minmax(0,1fr); gap:32px; padding:32px; align-items:start; }
  .artwork { width:100%; aspect-ratio:1; border-radius:12px; overflow:hidden; box-shadow:0 14px 35px #0006,0 0 0 1px #ffffff17; background:#322646; }
  .artwork img { width:100%; height:100%; object-fit:cover; }
  .book-cover { position:relative; height:100%; display:flex; flex-direction:column; justify-content:center; gap:14px; padding:25px 24px 25px 30px; background:radial-gradient(circle at 85% 5%,#8f63ac66,transparent 65%),linear-gradient(135deg,#523b74,#281f3d); }
  .book-cover::before { content:''; position:absolute; inset:0 auto 0 7px; width:2px; background:#e7c8ff24; box-shadow:5px 0 15px #0004; }
  .cover-kind { color:#d7bedf; font-size:.57rem; letter-spacing:.21em; font-weight:700; }
  .cover-title { font-family:Georgia,serif; font-size:clamp(1rem,2vw,1.45rem); font-weight:700; line-height:1.25; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:5; -webkit-box-orient:vertical; overflow:hidden; z-index:1; }
  .cover-artist { color:#dfcfea; font-size:.7rem; overflow-wrap:anywhere; z-index:1; }
  .cover-lines { position:absolute; width:150px; height:150px; border:1px solid #dfbcff13; border-radius:50%; bottom:-90px; right:-20px; box-shadow:0 0 0 18px #dfbcff09,0 0 0 36px #dfbcff06; }
  .listening-main { min-width:0; }
  .kind { font-size:.65rem; letter-spacing:.16em; color:#ad96c4; font-weight:650; }
  h1 { font-size:clamp(1.35rem,2.7vw,2rem); letter-spacing:-.025em; line-height:1.25; margin:8px 0 10px; overflow-wrap:anywhere; }
  .artist { color:#d6cddd; font-size:.95rem; }
  .album { margin-top:6px; color:#a69aad; font-size:.8rem; }
  .timeline { margin-top:24px; }
  input[type='range'] { appearance:none; -webkit-appearance:none; min-width:0; width:100%; height:28px; margin:0; padding:0; border:0; box-shadow:none; border-radius:0; background:transparent; cursor:pointer; }
  input[type='range']::-webkit-slider-runnable-track { height:5px; border-radius:99px; background:linear-gradient(to right,#bd9cff var(--fill),#ffffff1c var(--fill)); }
  input[type='range']::-moz-range-track { height:5px; border-radius:99px; background:linear-gradient(to right,#bd9cff var(--fill),#ffffff1c var(--fill)); }
  input[type='range']::-webkit-slider-thumb { appearance:none; -webkit-appearance:none; height:15px; width:15px; margin-top:-5px; border-radius:50%; background:#ded0ff; border:3px solid #bd9cff; box-shadow:0 2px 6px #0004; }
  input[type='range']::-moz-range-thumb { height:9px; width:9px; border-radius:50%; background:#ded0ff; border:3px solid #bd9cff; }
  .times { display:flex; align-items:center; justify-content:space-between; gap:12px; color:#a99fb4; font-size:.76rem; font-variant-numeric:tabular-nums; }
  .transport { display:flex; align-items:center; justify-content:center; gap:30px; margin:22px 0; }
  .play-pause { width:64px; height:64px; flex-shrink:0; display:grid; place-items:center; border-radius:50%; background:#bd9cff; color:#21162f; box-shadow:0 7px 25px #a879f323; }
  .play-pause:hover:not(:disabled) { background:#d1baff; }
  .skip { min-width:54px; min-height:54px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0; color:#cbbbdc; font-size:.65rem; font-weight:700; border-radius:10px; }
  .skip:hover:not(:disabled) { background:#ffffff08; color:var(--ink); }
  .skip-arrow { font-size:2rem; line-height:1; }
  .settings { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:14px 0; border-top:1px solid #ffffff0d; }
  .speed { display:flex; align-items:center; gap:10px; color:#a99fb4; font-size:.8rem; }
  select { color-scheme:dark; font:inherit; color:#f4f1f7; background:#24202e; border:1px solid #ffffff26; border-radius:8px; min-height:42px; padding:7px 10px; cursor:pointer; max-width:100%; }
  select option { color:#f4f1f7; background:#24202e; }
  select option:checked { color:#fff; background:#604480; }
  .volume { display:flex; align-items:center; gap:9px; width:145px; min-width:0; color:#aa9ab9; }
  .volume svg { flex-shrink:0; }
  .chapter-picker { display:flex; flex-direction:column; gap:8px; margin-top:12px; color:#a99fb4; font-size:.8rem; }
  .chapter-picker > span { display:flex; justify-content:space-between; }
  .chapter-picker small { font-size:inherit; color:#8e809b; }
  .chapter-picker select { width:100%; }
  .notice { margin-top:14px; color:#bdb0cc; font-size:.82rem; }
  .error,.compatibility { padding:16px; margin-top:18px; border:1px solid #a9717c77; border-radius:12px; line-height:1.6; font-size:.88rem; }
  .error button { margin-top:12px; min-height:40px; border:1px solid #ffffff2b; border-radius:8px; padding:8px 16px; }
  .compatibility { border-color:#bd9cff66; }
  .compatibility h2 { font-size:1rem; margin-bottom:8px; }
  button:focus-visible,select:focus-visible,input:focus-visible { outline:3px solid #bd9cff; outline-offset:4px; }
  button:disabled,input:disabled,select:disabled { opacity:.45; cursor:default; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
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
