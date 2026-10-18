<script>
  // One value over time as a filled line, scaled min..max (labelled when min is not zero).
  // `summary` is what a screen reader hears.
  let { points = [], min = 0, max = 1, summary = '', height = 100, firstLabel = '', lastLabel = '', topLabel = '', bottomLabel = '' } = $props();
  const width = 100;
  const path = $derived.by(() => {
    if (points.length < 2) return '';
    const xy = points.map((p, i) => [i / (points.length - 1) * width, height - ((p - min) / Math.max(1e-9, max - min)) * (height - 2)]);
    return `M${xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L')}`;
  });
</script>

<figure class="chart">
  <div class="plot">
    {#if topLabel}<span class="top">{topLabel}</span>{/if}
    {#if bottomLabel}<span class="bottom">{bottomLabel}</span>{/if}
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={summary}>
      <line x1="0" x2={width} y1="2" y2="2" class="grid" />
      {#if path}
        <path d={`${path} L${width},${height} L0,${height} Z`} class="fill" />
        <path d={path} class="line" />
      {/if}
    </svg>
  </div>
  <div class="ends" aria-hidden="true"><span>{firstLabel}</span><span>{lastLabel}</span></div>
</figure>

<style>
  .chart { margin: 0; }
  .plot { position: relative; }
  .top { position: absolute; top: -2px; right: 0; font-size: 0.68rem; color: var(--ink-faint); }
  .bottom { position: absolute; bottom: 2px; right: 0; font-size: 0.68rem; color: var(--ink-faint); }
  svg { display: block; width: 100%; height: 100px; }
  .grid { stroke: var(--line-strong); stroke-width: 0.5; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
  .fill { fill: rgba(109, 179, 255, 0.18); }
  .line { fill: none; stroke: #6db3ff; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .ends { display: flex; justify-content: space-between; font-size: 0.66rem; color: var(--ink-faint); margin-top: 4px; }
</style>
