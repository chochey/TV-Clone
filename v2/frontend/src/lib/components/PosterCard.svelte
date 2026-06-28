<script>
  import { posterUrl } from '../api.js';
  let { item, onopen } = $props();

  const poster = $derived(posterUrl(item));
  const title = $derived(item.showName || item.title || item.omdbTitle || 'Untitled');
  const year = $derived(item.year || item.omdbYear || '');
  const pct = $derived(item.progress?.percent || 0);
</script>

<button class="card" onclick={() => onopen?.(item)} aria-label={`Open ${title}`}>
  <div class="art">
    {#if poster}
      <img src={poster} alt="" loading="lazy" />
    {:else}
      <div class="placeholder serif">{title.slice(0, 1)}</div>
    {/if}
    {#if item.watched}<span class="watched">✓</span>{/if}
    {#if pct > 0 && pct < 95}
      <div class="progress"><span style={`width:${pct}%`}></span></div>
    {/if}
  </div>
  <div class="label">
    <span class="title serif">{title}</span>
    <span class="meta">{year}{item.type === 'show' ? ' · Series' : ''}</span>
  </div>
</button>

<style>
  .card {
    display: block;
    text-align: left;
    width: 100%;
  }
  .art {
    position: relative;
    aspect-ratio: 2 / 3;
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--paper-raised);
    box-shadow: 0 0 0 1px var(--line);
    transition: transform var(--t-med) var(--ease), box-shadow var(--t-med) var(--ease);
  }
  .card:hover .art {
    transform: translateY(-6px);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--line-strong);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform var(--t-slow) var(--ease);
  }
  .card:hover .art img { transform: scale(1.05); }
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: 3rem;
    color: var(--ink-faint);
  }
  .watched {
    position: absolute;
    top: var(--s2);
    right: var(--s2);
    width: 24px;
    height: 24px;
    border-radius: 99px;
    background: var(--accent);
    color: var(--accent-ink);
    font-size: 0.8rem;
    display: grid;
    place-items: center;
    font-weight: 700;
  }
  .progress {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.5);
  }
  .progress span { display: block; height: 100%; background: var(--accent); }
  .label { padding: var(--s2) var(--s1) 0; }
  .title {
    display: block;
    font-size: 0.96rem;
    font-weight: 600;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta { display: block; margin-top: 2px; font-size: 0.66rem; }
</style>
