<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api.js';
  import { navigate } from '../lib/router.js';

  let report = $state(null);   // {shows, unmatched, staleSlots, refreshing, generatedAt}
  let error = $state('');
  let pollTimer = null;

  async function load() {
    error = '';
    try {
      report = await api.episodesReport();
      if (report.refreshing) schedulePoll();
    } catch (e) { error = e.body?.error || 'Failed to load report'; }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(load, 4000);
  }
  async function refresh() {
    try {
      await api.episodesRefresh();
      report = { ...(report || {}), refreshing: true };
      schedulePoll();
    } catch (e) { error = e.body?.error || 'Refresh failed'; }
  }
  onMount(load);
  onDestroy(() => clearTimeout(pollTimer));

  function epCode(season, episode) {
    return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  }
  function searchFor(show, season, episode) {
    // Strip the "(2011)" suffix — release names rarely carry it.
    const bare = show.replace(/\s*\(\d{4}\)\s*$/, '');
    const q = episode != null ? `${bare} ${epCode(season, episode)}` : `${bare} Season ${season}`;
    navigate(`/downloads?q=${encodeURIComponent(q)}`);
  }

  const gapShows = $derived((report?.shows || []).filter((s) => s.missingCount > 0 || s.wholeMissing.length > 0));
  const completeCount = $derived((report?.shows || []).length - gapShows.length);
  const newEpisodes = $derived.by(() => {
    // Ongoing shows' recently-aired gaps get top billing.
    const cutoff = Date.now() - 30 * 86400000;
    const out = [];
    for (const s of report?.shows || []) {
      if (!s.ongoing) continue;
      for (const season of s.seasons) {
        for (const m of season.missing) {
          const ts = m.released ? Date.parse(m.released) : NaN;
          if (Number.isFinite(ts) && ts >= cutoff) {
            out.push({ show: s.show, season: season.season, ...m, ts });
          }
        }
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  });
</script>

<div class="page">
  <header>
    <h1 class="display">Episodes</h1>
    {#if report}
      <span class="sub">
        {completeCount} show{completeCount === 1 ? '' : 's'} complete ·
        <strong>{gapShows.length}</strong> with gaps
        {#if report.staleSlots > 0} · {report.staleSlots} season{report.staleSlots === 1 ? '' : 's'} unchecked{/if}
      </span>
    {/if}
    <button class="cta refresh" onclick={refresh} disabled={report?.refreshing}>
      {report?.refreshing ? 'Checking OMDb…' : 'Refresh from OMDb'}
    </button>
  </header>

  {#if error}<p class="err">{error}</p>{/if}
  {#if !report}
    <div class="spinner"></div>
  {:else}
    {#if report.staleSlots > 0 && !report.refreshing}
      <p class="hint">Some seasons haven't been checked against OMDb yet — hit Refresh (uses ~1 API call per unchecked season, budgeted per run).</p>
    {/if}

    {#if newEpisodes.length}
      <section class="block">
        <h2>New episodes <span class="count">{newEpisodes.length}</span></h2>
        {#each newEpisodes as e (`${e.show}|${e.season}|${e.episode}`)}
          <div class="row">
            <div class="rinfo">
              <span class="rtitle">{e.show} <strong>{epCode(e.season, e.episode)}</strong>{e.title ? ` — ${e.title}` : ''}</span>
              <span class="rmeta">aired {e.released}</span>
            </div>
            <button class="act" onclick={() => searchFor(e.show, e.season, e.episode)}>Search</button>
          </div>
        {/each}
      </section>
    {/if}

    <section class="block">
      <h2>Gaps <span class="count">{gapShows.length}</span></h2>
      {#if !gapShows.length}
        <p class="allclear">No gaps — every checked season is complete.</p>
      {/if}
      {#each gapShows as s (s.show)}
        <div class="showcard">
          <h3>{s.show} {#if s.ongoing}<em class="ongoing">ongoing</em>{/if}</h3>
          {#each s.seasons.filter((x) => x.missing.length) as season (season.season)}
            <div class="seasonrow">
              <span class="slabel">Season {season.season}</span>
              <span class="shave">{season.held}/{season.total ?? '?'} held</span>
              <div class="chips">
                {#each season.missing as m, mi (mi)}
                  <button class="chip" title={`${m.title || 'Unknown title'}${m.released ? ` · aired ${m.released}` : ''} — click to search`}
                          onclick={() => searchFor(s.show, season.season, m.episode)}>
                    E{String(m.episode).padStart(2, '0')}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
          {#each s.wholeMissing as w (w.season)}
            <div class="seasonrow whole">
              <span class="slabel">Season {w.season}</span>
              <span class="shave">entirely missing{w.count ? ` (${w.count} episodes)` : ''}</span>
              <button class="act" onclick={() => searchFor(s.show, w.season, null)}>Search season</button>
            </div>
          {/each}
        </div>
      {/each}
    </section>

    {#if report.unmatched?.length}
      <section class="block dim-block">
        <h2>Not matched to OMDb <span class="count">{report.unmatched.length}</span></h2>
        <p class="hint">These shows have no cached OMDb identity, so they can't be checked. They usually fix themselves after their posters load once.</p>
        <p class="unmatched">{report.unmatched.join(' · ')}</p>
      </section>
    {/if}
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1000px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: var(--s3); margin-bottom: var(--s5); flex-wrap: wrap; }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  .sub { color: var(--ink-soft); font-size: 0.9rem; }
  .sub strong { color: var(--ink); }
  .refresh { margin-left: auto; }
  .err { color: #ff6b6b; margin-bottom: var(--s3); }
  .hint { color: var(--ink-faint); font-size: 0.85rem; margin-bottom: var(--s3); }
  .allclear { color: var(--ink-faint); }

  .block { margin-bottom: var(--s6); }
  .block h2 {
    font-size: 1.05rem; font-weight: 700; margin-bottom: var(--s3);
    display: flex; align-items: baseline; gap: var(--s2);
  }
  .count { font-size: 0.75rem; font-weight: 700; color: var(--ink-faint); }

  .row {
    display: flex; align-items: center; gap: var(--s3);
    padding: var(--s2) var(--s3); border-radius: var(--r-sm);
    background: var(--bg-raised); box-shadow: inset 0 0 0 1px var(--line);
    margin-bottom: 6px;
  }
  .rinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rtitle { font-size: 0.92rem; }
  .rmeta { font-size: 0.78rem; color: var(--ink-faint); }

  .showcard {
    background: var(--bg-raised); border-radius: var(--r-md);
    box-shadow: inset 0 0 0 1px var(--line);
    padding: var(--s3) var(--s4); margin-bottom: var(--s3);
  }
  .showcard h3 { font-size: 0.98rem; font-weight: 700; margin-bottom: var(--s2); }
  .ongoing {
    font-style: normal; font-size: 0.66rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: #7ed491; margin-left: 8px;
  }
  .seasonrow {
    display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap;
    padding: 6px 0; border-top: 1px solid var(--line);
  }
  .slabel { font-size: 0.85rem; font-weight: 600; flex: 0 0 90px; }
  .shave { font-size: 0.78rem; color: var(--ink-faint); flex: 0 0 auto; min-width: 90px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    font-size: 0.76rem; font-weight: 700; font-variant-numeric: tabular-nums;
    padding: 3px 10px; border-radius: 99px;
    color: #ffb46b; box-shadow: inset 0 0 0 1px rgba(255, 180, 107, 0.4);
    transition: background var(--t-fast), color var(--t-fast);
  }
  .chip:hover { background: #ffb46b; color: #141416; }
  .act {
    font-size: 0.8rem; font-weight: 600; color: var(--ink);
    padding: 6px 14px; border-radius: var(--r-sm);
    background: rgba(242, 242, 244, 0.1);
    transition: background var(--t-fast);
  }
  .act:hover { background: rgba(242, 242, 244, 0.2); }
  .whole .shave { color: #ffb46b; }

  .dim-block { opacity: 0.75; }
  .unmatched { font-size: 0.8rem; color: var(--ink-faint); line-height: 1.8; }

  .spinner {
    width: 30px; height: 30px; margin: var(--s6) auto;
    border: 2px solid var(--line-strong); border-top-color: var(--ink);
    border-radius: 99px; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
