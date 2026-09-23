<script>
  import Hero from '../lib/components/Hero.svelte';
  import Row from '../lib/components/Row.svelte';
  import { continueWatching, recentlyAdded, genreClusters, libraryStats, library, collapseShows } from '../lib/stores.js';
  import { posterUrl } from '../lib/api.js';
  import { navigate } from '../lib/router.js';
  import { moods, moodMatches, discoveryPool, nextPick } from '../lib/home-discovery.js';
  let { onopen, onplay } = $props();
  const featured = $derived($continueWatching[0] || $recentlyAdded[0] || null);
  const pool = $derived(discoveryPool($library, featured?.id));
  let pickId = $state('');
  let pickFailed = $state(false);
  const pick = $derived(pool.find(i => i.id === pickId) || pool[0] || null);
  $effect(() => { pick?.id; pickFailed = false; });
  let mood = $state('');
  const moodItems = $derived(mood ? collapseShows(moodMatches($library, mood)).slice(0,40) : []);
  function shuffle() { pickId = nextPick(pool, pick?.id)?.id || ''; }
  function surprise() {
    const choice = nextPick(pool, pick?.id);
    if (choice) { pickId = choice.id; onopen?.(choice); }
  }
</script>

<div class="home" class:empty={!featured}>
  {#if featured}
    <div class="herowrap">
      <Hero item={featured} {onopen} {onplay} home />
      {#if pick}
        <aside class="tonight" aria-label="Tonight's pick">
          <div class="pick-heading"><h2>Tonight’s pick</h2><span>DISCOVER</span></div>
          <button class="pick-art" onclick={() => onopen?.(pick)} aria-label={`More about ${pick.title}`}>
            {#if posterUrl(pick) && !pickFailed}
              <img src={posterUrl(pick)} alt="" onerror={() => { pickFailed = true; }} />
            {:else}<span class="fallback">{pick.title}</span>{/if}
          </button>
          <h3>{pick.title}</h3>
          <p>{pick.watched ? 'Worth another movie night.' : 'Your next movie night starts here.'}</p>
          <div class="pick-actions">
            <button class="accent" onclick={() => onopen?.(pick)}>Take a look</button>
            <button class="shuffle" onclick={shuffle} disabled={pool.length < 2} aria-label="Choose another tonight's pick" title="Choose another">⤨</button>
          </div>
        </aside>
      {/if}
    </div>
  {/if}

  <section class="moods" aria-label="Choose a movie mood">
    <h2>What are you in the mood for?</h2>
    <div class="mood-buttons">
      {#each moods as m}
        <button style={`--mood:${m.color}`} class:selected={mood === m.id} aria-pressed={mood === m.id}
                onclick={() => { mood = mood === m.id ? '' : m.id; }}><span aria-hidden="true">{m.icon}</span>{m.label}</button>
      {/each}
      <button class="surprise" onclick={surprise} disabled={!pool.length}><span aria-hidden="true">⚄</span>Surprise me</button>
    </div>
  </section>
  {#if mood}
    <div class="mood-result" aria-live="polite">
      {#if moodItems.length}<Row title={`${moods.find(m => m.id === mood)?.label} · your library`} items={moodItems} {onopen} {onplay} />
      {:else}<p>No titles tagged {mood.toLowerCase()} yet. Try another mood.</p>{/if}
      <button class="clear" onclick={() => { mood = ''; }}>Clear mood filter ×</button>
    </div>
  {/if}
  <div class="rows">
    <Row title="Continue watching" items={$continueWatching} {onopen} {onplay} resume wide />
    <Row title="Fresh on your shelf" items={$recentlyAdded} {onopen} {onplay} size="lg" />
    {#each $genreClusters as cluster (cluster.name)}
      <Row title={cluster.name} items={cluster.items} {onopen} {onplay} />
    {/each}
  </div>
  <footer>
    <span>Your own little cinema.</span>
    <button onclick={() => navigate('/movies')}>{$libraryStats.movies.toLocaleString()} movies</button>
    <button onclick={() => navigate('/shows')}>{$libraryStats.shows.toLocaleString()} shows</button>
  </footer>
</div>

<style>
  .home { --cta:#7939f8; --cta-ink:#fff; padding-bottom:var(--s6); }
  .empty .moods {margin-top:0;padding-top:110px;}
  .herowrap {position:relative;}
  .tonight {position:absolute;right:var(--gutter);top:96px;width:250px;padding:18px;background:rgba(15,15,23,.94);border:1px solid var(--line-strong);border-radius:16px;box-shadow:0 18px 50px #0006;}
  .pick-heading {display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;}
  h2 {font-size:1.15rem;letter-spacing:-.02em;}
  .pick-heading span {font-size:.55rem;letter-spacing:.15em;color:#bd9cff;}
  .pick-art {width:100%;height:150px;overflow:hidden;border-radius:9px;background:#22202f;display:grid;place-items:center;}
  .pick-art img {height:100%;width:100%;object-fit:cover;object-position:center 25%;transition:transform 180ms;}
  .pick-art:hover img {transform:scale(1.025);}
  .fallback {font-size:1.3rem;padding:16px;}
  .tonight h3 {margin-top:12px;font-size:1rem;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  .tonight p {font-size:.76rem;color:var(--ink-soft);margin:7px 0 14px;}
  .pick-actions {display:flex;gap:8px;}
  .accent {background:var(--cta);color:white;font-weight:700;border-radius:9px;padding:11px 14px;flex:1;}
  .shuffle {background:#ffffff0d;border:1px solid var(--line-strong);border-radius:9px;width:42px;font-size:1.5rem;}
  .moods {position:relative;padding:0 var(--gutter);margin-top:-28px;z-index:3;}
  .moods h2 {margin-bottom:14px;}
  .mood-buttons {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;}
  .mood-buttons button {display:flex;align-items:center;justify-content:center;gap:12px;min-height:54px;border-radius:11px;font-size:.95rem;font-weight:700;border:1px solid var(--mood,#985eff);color:var(--mood,white);background:color-mix(in srgb,var(--mood,#7939f8) 9%,#0b0b0e);transition:background 160ms,transform 160ms;}
  .mood-buttons span {font-size:1.65rem;line-height:1;}
  .mood-buttons button:hover,.mood-buttons .selected {background:color-mix(in srgb,var(--mood,#7939f8) 22%,#0b0b0e);transform:translateY(-2px);}
  .mood-buttons .surprise {background:#7939f8;color:white;}
  .mood-result {padding-bottom:12px;}
  .mood-result p,.clear {margin:16px var(--gutter) 0;}
  .clear {color:#c6a7ff;text-decoration:underline;text-underline-offset:4px;}
  footer {display:flex;gap:20px;flex-wrap:wrap;margin:48px var(--gutter) 0;padding-top:24px;border-top:1px solid var(--line);color:var(--ink-soft);font-size:.82rem;}
  footer span {margin-right:auto;}
  button:focus-visible {outline:3px solid #c5a6ff;outline-offset:4px;}
  button:disabled {opacity:.45;cursor:default;}
  @media(max-width:1100px) {.tonight {position:relative;top:auto;right:auto;width:auto;margin:-25px var(--gutter) 45px;display:grid;grid-template-columns:100px 1fr auto;column-gap:18px;align-items:center;} .pick-heading{grid-column:2;grid-row:1;margin:0;} .pick-heading span{display:none;} .pick-art{grid-column:1;grid-row:1 / 4;height:110px;} .tonight h3{grid-column:2;grid-row:2;margin:4px 0;} .tonight p{grid-column:2;grid-row:3;margin:0;} .pick-actions{grid-column:3;grid-row:1 / 4;} .mood-buttons{grid-template-columns:repeat(2,minmax(0,1fr));}}
  @media(max-width:600px) {.tonight{grid-template-columns:76px 1fr;padding:14px;gap:6px 14px;} .pick-art{height:98px;} .pick-actions{grid-column:1 / -1;grid-row:4;margin-top:8px;} .mood-buttons{gap:10px;} .mood-buttons button{font-size:.8rem;gap:7px;} .mood-buttons span{font-size:1.35rem;}}
  @media(prefers-reduced-motion:reduce){.pick-art img,.mood-buttons button{transition:none;transform:none;}}
</style>
