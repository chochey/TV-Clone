<script>
  // Stacked bars, one per row of `data` ({ label, values: { [seriesKey]: n } }).
  // Plain SVG that scales to its box; `summary` is what a screen reader hears.
  import { niceMax } from '../../dashboard-format.js';
  let { data = [], series = [], summary = '', height = 120, labelEvery = 4, format = n => String(n) } = $props();

  const W = 10, GAP = 2;
  const totals = $derived(data.map(d => series.reduce((n, s) => n + (d.values[s.key] || 0), 0)));
  const max = $derived(niceMax(Math.max(0, ...totals)));
  const width = $derived(Math.max(1, data.length) * W);
  const bars = $derived(data.map((d, i) => {
    let y = height;
    return { label: d.label, total: totals[i], parts: series.map(s => {
      const h = ((d.values[s.key] || 0) / max) * (height - 4);
      y -= h;
      return { color: s.color, y, h, key: s.key };
    }).filter(p => p.h > 0) };
  }));
</script>

<figure class="chart">
  <div class="plot">
    <span class="top">{format(max)}</span>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={summary}>
      <line x1="0" x2={width} y1="4" y2="4" class="grid" />
      {#each bars as b, i (i)}
        {#each b.parts as p (p.key)}
          <rect x={i * W + GAP / 2} y={p.y} width={W - GAP} height={p.h} fill={p.color}><title>{b.label}: {format(b.total)}</title></rect>
        {/each}
      {/each}
    </svg>
  </div>
  <div class="xlabels" aria-hidden="true">
    {#each data as d, i (i)}<span>{i % labelEvery === 0 ? d.label : ''}</span>{/each}
  </div>
  {#if series.length > 1}
    <figcaption class="legend">
      {#each series as s (s.key)}<span><i style={`background:${s.color}`}></i>{s.label}</span>{/each}
    </figcaption>
  {/if}
</figure>

<style>
  .chart { margin: 0; }
  .plot { position: relative; }
  .top { position: absolute; top: -2px; right: 0; font-size: 0.68rem; color: var(--ink-faint); }
  svg { display: block; width: 100%; height: 120px; overflow: visible; }
  .grid { stroke: var(--line-strong); stroke-width: 0.5; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
  .xlabels { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; font-size: 0.66rem; color: var(--ink-faint); margin-top: 4px; }
  .xlabels span { white-space: nowrap; overflow: visible; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 0.76rem; color: var(--ink-soft); margin-top: 8px; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
</style>
