<script>
  import { library, session } from '../lib/stores.js';
  import { api, posterUrl } from '../lib/api.js';
  import { navigate } from '../lib/router.js';
  import { onMount } from 'svelte';

  let history = $state(null);
  onMount(async () => {
    try { history = await api.history($session?.profileId); } catch { history = []; }
  });

  // "Engaged" = any item the user has interacted with (progress > 0 or watched)
  const engaged = $derived($library.filter((i) => i.watched || (i.progress?.percent || 0) > 0));
  const watched = $derived($library.filter((i) => i.watched));
  const inProgress = $derived($library.filter((i) => (i.progress?.percent || 0) > 0 && !i.watched));

  const moviesEngaged = $derived(engaged.filter((i) => i.type === 'movie'));
  const showsEngaged = $derived.by(() => {
    const names = new Set();
    for (const i of engaged) if (i.showName) names.add(i.showName);
    return names;
  });
  const episodesEngaged = $derived(engaged.filter((i) => i.type === 'show'));

  // Hours watched: sum actual time watched across all items
  const hoursWatched = $derived.by(() => {
    let secs = 0;
    for (const i of $library) {
      if (!i.progress?.duration) continue;
      if (i.watched) secs += i.progress.duration;
      else if (i.progress.percent > 0) secs += i.progress.currentTime || 0;
    }
    return secs / 3600;
  });

  // Top genres from engaged items
  const topGenres = $derived.by(() => {
    const counts = new Map();
    for (const i of engaged) {
      const genres = [];
      if (i.genre) genres.push(...i.genre.split(',').map((g) => g.trim()));
      else if (Array.isArray(i.genres)) genres.push(...i.genres);
      for (const g of genres.filter(Boolean)) counts.set(g, (counts.get(g) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({ name, count }));
  });

  // Most watched: engaged items sorted by time spent
  const mostWatched = $derived.by(() => {
    const items = engaged
      .filter((i) => i.progress?.currentTime > 60)
      .map((i) => ({ ...i, timeSec: i.watched ? (i.progress?.duration || 0) : (i.progress?.currentTime || 0) }))
      .sort((a, b) => b.timeSec - a.timeSec)
      .slice(0, 10);
    // Collapse shows to one entry (most-watched episode)
    const seen = new Set();
    const out = [];
    for (const i of items) {
      const key = i.showName || i.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(i);
    }
    return out;
  });

  // Watch activity by month (from history timestamps)
  const monthlyActivity = $derived.by(() => {
    if (!history) return [];
    const counts = new Map();
    for (const h of history) {
      const d = new Date(h.timestamp);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, count]) => ({
        label: new Date(month + '-01').toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
        count,
      }));
  });
  const maxMonthly = $derived(Math.max(1, ...monthlyActivity.map((m) => m.count)));

  // Decade distribution from engaged items
  const decades = $derived.by(() => {
    const counts = new Map();
    for (const i of engaged) {
      const y = parseInt(i.omdbYear || i.year);
      if (!y || isNaN(y)) continue;
      const dec = Math.floor(y / 10) * 10;
      counts.set(dec, (counts.get(dec) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([dec, count]) => ({ label: `${dec}s`, count }));
  });
  const maxDecade = $derived(Math.max(1, ...decades.map((d) => d.count)));

  const maxGenreCount = $derived(topGenres.length ? topGenres[0].count : 1);

  function fmtHours(h) {
    if (h < 1) return `${Math.round(h * 60)}m`;
    if (h < 100) return `${h.toFixed(1)}h`;
    return `${Math.round(h)}h`;
  }

  function fmtDuration(secs) {
    if (secs < 60) return `${Math.round(secs)}s`;
    const m = Math.floor(secs / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
</script>

<div class="page">
  <header><h1 class="display">Watch Stats</h1></header>

  <!-- Key stats -->
  <div class="stats-grid">
    <div class="stat-card">
      <span class="stat-value">{fmtHours(hoursWatched)}</span>
      <span class="stat-label">Watch Time</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{moviesEngaged.length}</span>
      <span class="stat-label">Movies</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{showsEngaged.size}</span>
      <span class="stat-label">Shows</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{episodesEngaged.length}</span>
      <span class="stat-label">Episodes</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{watched.length}</span>
      <span class="stat-label">Completed</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{inProgress.length}</span>
      <span class="stat-label">In Progress</span>
    </div>
  </div>

  <!-- Two-column layout for charts -->
  <div class="charts">
    <!-- Top Genres -->
    <section class="chart-section">
      <h2>Top Genres</h2>
      {#if topGenres.length}
        <div class="bar-chart">
          {#each topGenres as g}
            <div class="bar-row">
              <span class="bar-label">{g.name}</span>
              <div class="bar-track">
                <div class="bar-fill" style={`width:${(g.count / maxGenreCount) * 100}%`}></div>
              </div>
              <span class="bar-count">{g.count}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty">No genre data yet.</p>
      {/if}
    </section>

    <!-- By Decade -->
    <section class="chart-section">
      <h2>By Decade</h2>
      {#if decades.length}
        <div class="bar-chart">
          {#each decades as d}
            <div class="bar-row">
              <span class="bar-label">{d.label}</span>
              <div class="bar-track">
                <div class="bar-fill" style={`width:${(d.count / maxDecade) * 100}%`}></div>
              </div>
              <span class="bar-count">{d.count}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty">No year data yet.</p>
      {/if}
    </section>
  </div>

  <!-- Watch Activity -->
  {#if monthlyActivity.length > 1}
    <section class="chart-section full">
      <h2>Watch Activity</h2>
      <div class="activity-chart">
        {#each monthlyActivity as m}
          <div class="act-col">
            <div class="act-bar-wrap">
              <div class="act-bar" style={`height:${(m.count / maxMonthly) * 100}%`}>
                <span class="act-tip">{m.count}</span>
              </div>
            </div>
            <span class="act-label">{m.label}</span>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Most Watched -->
  {#if mostWatched.length}
    <section class="chart-section full">
      <h2>Most Watched</h2>
      <div class="rated-list">
        {#each mostWatched as item, i}
          <div class="rated-row" role="button" tabindex="0"
               onclick={() => navigate(`/title/${encodeURIComponent(item.id)}`)}>
            <span class="rank">#{i + 1}</span>
            <div class="rated-thumb">
              {#if posterUrl(item)}
                <img src={posterUrl(item)} alt="" loading="lazy" />
              {:else}
                <div class="ph"></div>
              {/if}
            </div>
            <div class="rated-info">
              <span class="rated-title">{item.showName || item.omdbTitle || item.title}</span>
              <span class="rated-meta meta">
                {item.omdbYear || item.year || ''}{item.genre ? ` · ${item.genre.split(',')[0]}` : ''}
                {#if item.imdbRating && item.imdbRating !== 'N/A'} · <span class="star">★ {item.imdbRating}</span>{/if}
              </span>
            </div>
            <span class="time-spent">{fmtDuration(item.timeSec)}</span>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .page { padding: calc(64px + var(--s5)) var(--gutter) var(--s7); max-width: 1100px; margin: 0 auto; }
  header { margin-bottom: var(--s5); }
  h1 { font-size: clamp(1.8rem, 3.4vw, 2.6rem); }
  h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: var(--s4); color: var(--ink); }
  .empty { color: var(--ink-faint); }

  /* ── Key stats grid ─────────────────────────────────────────── */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--s4);
    margin-bottom: var(--s6);
  }
  .stat-card {
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    padding: var(--s4);
    display: flex; flex-direction: column; gap: 4px;
    text-align: center;
  }
  .stat-value {
    font-size: 2rem; font-weight: 700; line-height: 1;
    color: var(--ink);
  }
  .stat-label {
    font-size: 0.78rem; color: var(--ink-soft); text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* ── Charts layout ──────────────────────────────────────────── */
  .charts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s5);
    margin-bottom: var(--s5);
  }
  @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }

  .chart-section {
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    padding: var(--s4);
  }
  .chart-section.full { margin-bottom: var(--s5); }

  /* ── Horizontal bar chart ───────────────────────────────────── */
  .bar-chart { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: flex; align-items: center; gap: var(--s3); }
  .bar-label {
    flex: 0 0 80px; font-size: 0.82rem; color: var(--ink-soft);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    text-align: right;
  }
  .bar-track { flex: 1; height: 18px; background: rgba(242, 242, 244, 0.06); border-radius: 4px; overflow: hidden; }
  .bar-fill {
    height: 100%; background: var(--ink); border-radius: 4px;
    min-width: 3px;
    transition: width 0.5s var(--ease);
  }
  .bar-count { flex: 0 0 32px; font-size: 0.78rem; color: var(--ink-faint); text-align: right; }

  /* ── Vertical activity chart ────────────────────────────────── */
  .activity-chart {
    display: flex; gap: 2px; align-items: flex-end;
    height: 160px; padding-top: 20px; overflow-x: auto;
  }
  .act-col { display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 36px; height: 100%; }
  .act-bar-wrap { flex: 1; width: 100%; display: flex; align-items: flex-end; }
  .act-bar {
    width: 100%; background: var(--ink); border-radius: 3px 3px 0 0;
    min-height: 3px; transition: height 0.5s var(--ease);
    position: relative;
  }
  .act-tip {
    position: absolute; top: -18px; left: 50%; transform: translateX(-50%);
    font-size: 0.68rem; color: var(--ink-faint); white-space: nowrap;
  }
  .act-label { font-size: 0.65rem; color: var(--ink-faint); margin-top: 4px; white-space: nowrap; }

  /* ── Most watched list ──────────────────────────────────────── */
  .rated-list { display: flex; flex-direction: column; }
  .rated-row {
    display: flex; gap: var(--s3); align-items: center;
    padding: var(--s2) var(--s3); margin: 0 calc(-1 * var(--s3));
    border-top: 1px solid var(--line); border-radius: var(--r-sm);
    cursor: pointer; transition: background var(--t-fast);
  }
  .rated-row:first-child { border-top: none; }
  .rated-row:hover { background: rgba(242, 242, 244, 0.06); }
  .rank { flex: 0 0 28px; font-size: 0.85rem; font-weight: 700; color: var(--ink-faint); }
  .rated-thumb { flex: 0 0 36px; }
  .rated-thumb img, .rated-thumb .ph {
    width: 36px; aspect-ratio: 2/3; object-fit: cover;
    border-radius: 3px; background: var(--bg-sunken);
  }
  .rated-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rated-title { font-weight: 600; font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rated-meta { font-size: 0.72rem; color: var(--ink-soft); }
  .star { color: var(--star, #f5c518); }
  .time-spent { flex: 0 0 auto; font-size: 0.85rem; font-weight: 600; color: var(--ink-soft); }
</style>
