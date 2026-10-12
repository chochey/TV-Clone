<script>
  import { tick } from 'svelte';
  import { api } from '../api.js';
  import { audioTime } from '../audio-playback.js';
  import { readAlongDocument, readAlongPosition, readAlongWordAt, readAlongWordParts } from '../audio-read-along.js';

  let { itemId, position = 0, ready = false, visible = true, audio = null, onseek } = $props();
  let document = $state(null), loading = $state(true), error = $state(''), unavailable = $state(false), retry = $state(0);
  let unavailableMessage = $state('');
  let readingChapter = $state(0), following = $state(true), fontSize = $state(19), scroller = $state(null);
  let autoScroll = $state(true);
  let narrationTime = $state(0);
  let lastScrolledChapter = -1, lastScrolledParagraph = -1;
  const active = $derived(readAlongPosition(document, narrationTime));
  const activeChapter = $derived(active.chapter), activeParagraph = $derived(active.paragraph);
  const chapter = $derived(document?.chapters[readingChapter]);
  const currentParagraph = $derived(activeChapter === readingChapter ? activeParagraph : -1);
  const activeKey = $derived(`${activeChapter}:${activeParagraph}`);
  const wordChapters = $derived(document?.chapters.filter(entry => entry.paragraphs.some(passage => passage.words?.length)).length || 0);
  const hasWordTimings = $derived(wordChapters > 0);
  const wordParagraph = $derived(currentParagraph >= 0 ? chapter?.paragraphs[currentParagraph] : null);
  const wordParts = $derived(readAlongWordParts(wordParagraph));
  const currentWord = $derived(readAlongWordAt(wordParagraph?.words, narrationTime));

  $effect(() => { narrationTime = position; });

  $effect(() => {
    if (!visible || !ready || !audio || !hasWordTimings) return;
    const media = audio;
    let frame = 0;
    const sync = () => { if (Number.isFinite(media.currentTime)) narrationTime = media.currentTime; };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; sync(); };
    const update = () => {
      frame = 0;
      sync();
      if (!media.paused && !media.ended && !window.document.hidden) frame = requestAnimationFrame(update);
    };
    const start = () => { stop(); if (!media.paused && !media.ended && !window.document.hidden) frame = requestAnimationFrame(update); };
    // timeupdate is too infrequent for short words. Read the real media clock,
    // never an estimated timer, and only while this reader is visible.
    media.addEventListener('play', start); media.addEventListener('playing', start);
    media.addEventListener('pause', stop); media.addEventListener('ended', stop);
    media.addEventListener('seeking', sync); media.addEventListener('seeked', sync);
    window.document.addEventListener('visibilitychange', start);
    start();
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener('play', start); media.removeEventListener('playing', start);
      media.removeEventListener('pause', stop); media.removeEventListener('ended', stop);
      media.removeEventListener('seeking', sync); media.removeEventListener('seeked', sync);
      window.document.removeEventListener('visibilitychange', start);
    };
  });

  $effect(() => {
    try { autoScroll = localStorage.getItem('tvclone.readAlong.autoScroll') !== 'off'; } catch { /* Storage may be disabled. */ }
  });

  $effect(() => {
    const id = itemId; retry;
    const controller = new AbortController();
    let cancelled = false;
    loading = true; error = ''; unavailable = false; unavailableMessage = ''; document = null; following = true; readingChapter = 0; lastScrolledChapter = -1; lastScrolledParagraph = -1;
    api.audioReadAlong(id, controller.signal).then(value => {
      if (cancelled) return;
      document = readAlongDocument(value, id);
      unavailable = !document;
      if (!document && typeof value?.message === 'string') unavailableMessage = value.message.slice(0, 400);
      if (document) readingChapter = Math.max(0, readAlongPosition(document, position).chapter);
    }).catch(failure => {
      if (!cancelled && failure.name !== 'AbortError') error = 'Could not load the reading text. Your audio can keep playing.';
    }).finally(() => { if (!cancelled) loading = false; });
    return () => { cancelled = true; controller.abort(); };
  });

  $effect(() => {
    activeKey;
    if (!autoScroll || !following || !visible || !document || activeChapter < 0) return;
    readingChapter = activeChapter;
  });

  $effect(() => {
    const key = activeKey, selected = readingChapter; fontSize;
    if (!autoScroll || !following || !visible || !scroller || activeChapter !== selected) return;
    let cancelled = false;
    tick().then(() => {
      if (cancelled || key !== activeKey || !autoScroll || !following || !visible) return;
      const chapterChanged = lastScrolledChapter !== selected;
      const nextParagraph = !chapterChanged && activeParagraph === lastScrolledParagraph + 1;
      lastScrolledChapter = selected;
      if (activeParagraph >= 0) lastScrolledParagraph = activeParagraph;
      // A newly rendered chapter must not inherit the previous chapter's scroll.
      if (chapterChanged) scroller.scrollTo({ top: 0, behavior: 'instant' });
      const paragraph = scroller?.querySelector('[aria-current="true"] p');
      if (!paragraph) return;
      const pane = scroller.getBoundingClientRect(), bounds = paragraph.getBoundingClientRect(), height = scroller.clientHeight;
      // Keep visible text still. For an oversized paragraph, reveal its beginning
      // once; paragraph timestamps cannot tell us which line is being narrated.
      const readableHeight = Math.min(bounds.height, height * .65);
      if (bounds.top >= pane.top + 12 && bounds.top + readableHeight <= pane.top + height - 24) return;
      const top = scroller.scrollTop + bounds.top - pane.top - 24;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Advance by a screenful only when needed, leaving room for upcoming text.
      // Move only this pane, never the page or playback controls.
      scroller.scrollTo({ top: Math.max(0, top), behavior: !nextParagraph || reducedMotion ? 'instant' : 'smooth' });
    });
    return () => { cancelled = true; };
  });

  function browse(index) {
    pauseFollowing();
    readingChapter = Math.max(0, Math.min(document.chapters.length - 1, Number(index)));
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'instant' });
  }
  function pauseFollowing() {
    following = false;
    // Cancel an in-flight animation immediately when the listener takes over.
    scroller?.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
  }
  function setAutoScroll(enabled) {
    autoScroll = enabled;
    try { localStorage.setItem('tvclone.readAlong.autoScroll', enabled ? 'on' : 'off'); } catch { /* Storage may be disabled. */ }
    if (enabled) resumeFollowing();
    else pauseFollowing();
  }
  function resumeFollowing() {
    if (activeChapter >= 0) readingChapter = activeChapter;
    following = true;
  }
  function readingKey(event) {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      pauseFollowing();
      // These keys scroll the reader, not the global audio player.
      event.stopPropagation();
    }
  }
</script>

<section class="reader" aria-label="Read along">
  <header class="reader-heading"><div><span class="eyebrow">READ & LISTEN</span><h2>Read along</h2></div><span class="reader-label">{wordParagraph?.words?.length ? 'Highlights the spoken word' : 'Highlights the current paragraph'}</span></header>
  {#if hasWordTimings && wordChapters < document.chapters.length}<div class="word-progress"><span>Word highlights ready in {wordChapters} of {document.chapters.length} chapters. Other passages still highlight by paragraph.</span><button onclick={() => retry++}>Check for updates</button></div>{/if}
  {#if loading}<div class="reader-message" role="status">Loading reading text…</div>
  {:else if error}<div class="reader-message" role="alert"><p>{error}</p><button onclick={() => retry++}>Retry reading text</button></div>
  {:else if unavailable}<div class="reader-message" role="status"><h3>Reading text isn’t ready for this book</h3><p>{unavailableMessage || 'A matching book needs to be added and synchronized before it can follow the narration.'}</p><button onclick={() => retry++}>Check again</button></div>
  {:else if document}
    <div class="reader-toolbar">
      <label class="reader-chapter">Reading chapter<select value={String(readingChapter)} onchange={event => browse(event.currentTarget.value)} aria-label="Reading chapter">
        {#each document.chapters as entry, index}<option value={String(index)}>{entry.title}</option>{/each}
      </select></label>
      <div class="text-size" role="group" aria-label="Reading text size"><button aria-label="Decrease text size" onclick={() => fontSize = Math.max(16, fontSize - 2)} disabled={fontSize <= 16}>A−</button><button aria-label="Increase text size" onclick={() => fontSize = Math.min(29, fontSize + 2)} disabled={fontSize >= 29}>A+</button></div>
    </div>
    <div class="follow-status">
      <span>{!autoScroll ? 'Highlight only · scroll at your own pace' : following ? 'Following narration' : 'Browsing text · audio continues'}</span>
      <div class="follow-actions">
        <label class="auto-scroll"><input type="checkbox" checked={autoScroll} onchange={event => setAutoScroll(event.currentTarget.checked)} /> Auto-scroll</label>
        {#if autoScroll && !following}<button onclick={resumeFollowing}>Resume following</button>{/if}
      </div>
    </div>
    <div class="reading-body">
    {#if activeParagraph < 0}<p class="timing-note" role="status">Text is not synchronized at this point in the audio. Highlighting will resume with the next matched passage.</p>{/if}
    <!-- This scrollable reading region is focusable so keyboard readers can browse without moving playback. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div class="reading-text" bind:this={scroller} tabindex="0" role="region" aria-label="Book text" style={`--reading-size:${fontSize}px`}
      onwheel={pauseFollowing} ontouchmove={pauseFollowing} onpointerdown={pauseFollowing} onkeydown={readingKey}>
      <h3>{chapter.title}</h3>
      {#each chapter.paragraphs as paragraph, index (paragraph.id)}
        <div class="passage" class:current={currentParagraph === index} aria-current={currentParagraph === index ? 'true' : undefined}>
          <p>{#if currentParagraph === index && wordParts.length}{#each wordParts as part}{#if part.word >= 0}<span class="spoken-word" class:spoken-current={currentWord === part.word}>{part.text}</span>{:else}{part.text}{/if}{/each}{:else}{paragraph.text}{/if}</p>
          <div class="passage-info">{#if paragraph.page}<span>Page {paragraph.page}</span>{/if}
            {#if paragraph.start !== null}<button disabled={!ready} onclick={() => { onseek?.(paragraph.start); following = true; }} aria-label={`Listen from this passage at ${audioTime(paragraph.start)}`}>Listen from here <span aria-hidden="true">↗</span></button>
            {:else}<span>Timing unavailable</span>{/if}
          </div>
        </div>
      {/each}
    </div>
    </div>
    <footer class="reader-footer"><button onclick={() => browse(readingChapter - 1)} disabled={readingChapter === 0}>← Previous chapter</button><span>{readingChapter + 1} / {document.chapters.length}</span><button onclick={() => browse(readingChapter + 1)} disabled={readingChapter === document.chapters.length - 1}>Next chapter →</button></footer>
  {/if}
</section>

<style>
  .reader {min-width:0;display:flex;flex-direction:column;background:#15121d;border:1px solid #ffffff20;border-radius:14px;color:#f5f0fc;overflow:hidden;}
  .reader-heading {display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px 12px;}
  .eyebrow {font-size:.6rem;letter-spacing:.15em;color:#c8b1ed;font-weight:700;}
  h2 {font-size:1.3rem;margin:5px 0 0;letter-spacing:-.02em;}
  .reader-label {font-size:.72rem;color:#c6b9d6;}
  .word-progress {display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;font-size:.72rem;line-height:1.5;color:#cfc1df;margin:0;padding:0 24px 8px;}
  .word-progress button {font-size:.72rem;border:1px solid #6b5b7d;}
  .reader-toolbar {display:flex;align-items:end;gap:16px;padding:10px 24px;}
  .reader-chapter {display:flex;flex-direction:column;gap:7px;flex:1;min-width:0;font-size:.74rem;color:#cfc1df;}
  select {width:100%;min-width:0;min-height:44px;padding:9px 12px;border:1px solid #6b5b7d;border-radius:8px;font:inherit;color:#f5f0fc;background:#282032;color-scheme:dark;}
  option {color:#f5f0fc;background:#282032;}
  button {min-height:40px;border-radius:7px;padding:8px 10px;font-size:.78rem;color:#e4d4fb;}
  button:hover:not(:disabled) {background:#bd9cff20;}
  .text-size {display:flex;gap:4px;padding-bottom:1px;}
  .text-size button {min-width:42px;font-size:.9rem;border:1px solid #6b5b7d;}
  .follow-status {display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:54px;padding:4px 24px;font-size:.72rem;color:#ccbae3;}
  .follow-actions {display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-shrink:0;}
  .auto-scroll {display:flex;align-items:center;gap:7px;min-height:40px;cursor:pointer;white-space:nowrap;}
  .auto-scroll input {width:17px;height:17px;accent-color:#cba6ff;cursor:pointer;}
  .follow-status button {color:#22172f;background:#d2b4ff;font-weight:650;}
  .follow-status button:hover {background:#e0cbff;}
  .reading-body {position:relative;}
  .timing-note {position:absolute;bottom:0;left:0;right:0;z-index:1;pointer-events:none;font-size:.75rem;line-height:1.5;padding:12px 24px;margin:0;background:#302639f5;color:#e1d2ee;border-top:1px solid #ffffff12;}
  .reading-text {height:clamp(320px,58vh,740px);overflow:auto;overflow-anchor:none;overscroll-behavior:contain;scrollbar-color:#6f5e84 #191420;scrollbar-gutter:stable;padding:20px 22px 36px;outline-offset:-4px;}
  .reading-text h3 {font-family:Georgia,serif;font-size:1.5rem;line-height:1.4;padding:0 14px;margin:0 0 22px;}
  .passage {padding:13px 14px 6px;margin:0 0 7px;border-left:3px solid transparent;border-radius:4px 9px 9px 4px;}
  .passage.current {background:#362547;border-left-color:#cba6ff;}
  .passage p {font-family:Georgia,'Times New Roman',serif;font-size:var(--reading-size);line-height:1.8;white-space:pre-line;overflow-wrap:anywhere;margin:0;color:#f4eef9;}
  .spoken-current {color:#251934;background:#f1dfa3;border-radius:3px;box-shadow:0.07em 0 #f1dfa3,-0.07em 0 #f1dfa3;box-decoration-break:clone;-webkit-box-decoration-break:clone;}
  .passage-info {display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:38px;font-size:.65rem;color:#bbaeC8;}
  .passage-info button {margin-left:auto;min-height:36px;font-size:.68rem;}
  .reader-footer {display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid #ffffff18;padding:10px 14px;font-size:.7rem;color:#c8b9d7;}
  .reader-message {min-height:240px;padding:32px 24px;color:#ded1ec;line-height:1.6;font-size:.9rem;}
  .reader-message h3 {font-size:1rem;margin-bottom:10px;}
  .reader-message button {margin-top:14px;border:1px solid #ad8bcf;}
  button:focus-visible,select:focus-visible,input:focus-visible,.reading-text:focus-visible {outline:3px solid #cba6ff;outline-offset:3px;}
  button:disabled {opacity:.4;cursor:default;}
  @media(max-width:640px) {
    .reader-heading {padding:18px 16px 10px;}.reader-label {display:none;}.word-progress {padding:0 16px 8px;}.reader-toolbar {padding:10px 16px;gap:8px;}
    .follow-status {padding:4px 16px;align-items:flex-start;flex-direction:column;min-height:80px;gap:0;}.follow-actions {width:100%;justify-content:space-between;}.timing-note {padding:10px 16px;}.reading-text {height:58dvh;min-height:300px;padding:16px 8px 28px;}
    .reader-footer {padding:8px 6px;gap:2px;}.reader-footer button {font-size:.7rem;padding:8px 6px;}.passage {padding:11px 10px 5px;}
  }
</style>
