<script>
  // One film collection: the cover poster stacked over two hints of the films
  // behind it, the name and how many films the library has.
  import { posterUrl } from '../api.js';
  let { card, onopen } = $props();
  const src = $derived(posterUrl(card.cover));
</script>

<button class="ccard" onclick={() => onopen?.(card)} aria-label={`${card.name} collection, ${card.films.length} films`}>
  <span class="art" aria-hidden="true">
    <span class="behind b2"></span><span class="behind b1"></span>
    <span class="cover">
      {#if src}<img {src} alt="" loading="lazy" decoding="async" />{:else}<span class="initial">{card.name.slice(0, 1)}</span>{/if}
    </span>
  </span>
  <span class="name">{card.name}</span>
  <span class="count">{card.films.length} films</span>
</button>

<style>
  .ccard { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; color: var(--ink); }
  .art { position: relative; display: block; aspect-ratio: 2 / 3; margin: 8px 8px 4px 0; }
  .behind, .cover { position: absolute; inset: 0; border-radius: var(--r-sm); }
  .behind { background: var(--bg-raised); box-shadow: 0 0 0 1px var(--line-strong); }
  .b2 { transform: translate(8px, -8px); opacity: 0.45; }
  .b1 { transform: translate(4px, -4px); opacity: 0.75; }
  .cover { overflow: hidden; background: var(--bg-raised); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5); }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .initial { display: grid; place-items: center; height: 100%; font-size: 2.4rem; font-weight: 700; color: var(--ink-faint); }
  .ccard:hover .cover, .ccard:focus-visible .cover { box-shadow: 0 0 0 2px var(--ink), 0 6px 18px rgba(0, 0, 0, 0.5); }
  /* Two lines, so "Peter Jackson's Middle-earth film series" and "DC Extended Universe" read in full. */
  .name { font-weight: 600; font-size: 0.92rem; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; overflow-wrap: anywhere; }
  .count { font-size: 0.78rem; color: var(--ink-faint); }
</style>
