<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api.js';
  import { navigate } from '../lib/router.js';
  import { epCode, recentEpisodes, filterShows, episodeDownload, downloadLabel } from '../lib/episode-report.js';
  let report=$state(null), error=$state(''), downloadError=$state(''), torrents=$state([]);
  let filter=$state('all'), query=$state(''), starting=$state(false);
  let pollTimer, destroyed=false, loading=false;
  const filters=[['all','All'],['new','New'],['missing','Missing'],['complete','Complete'],['check','Needs checking']];
  const shows=$derived(filterShows(report,filter,query));
  const complete=$derived((report?.shows || []).filter(s=>s.complete).length);
  const gaps=$derived((report?.shows || []).filter(s=>s.missingCount>0).length);
  const needsCheck=$derived((report?.shows || []).filter(s=>s.needsCheck).length+(report?.unmatched?.length || 0));
  function schedule() {clearTimeout(pollTimer);if(!destroyed) pollTimer=setTimeout(load,report?.refreshing?4000:30000);}
  async function load() {
    if(destroyed || loading) return;
    loading=true;
    await Promise.all([
      api.episodesReport().then(r=>{if(!destroyed){report=r;error='';}}).catch(()=>{if(!destroyed)error='Could not load episode information. Retrying shortly.';}),
      api.torrents().then(r=>{if(!Array.isArray(r))throw new Error();if(!destroyed){torrents=r;downloadError='';}}).catch(()=>{if(!destroyed){torrents=[];downloadError='Download status is unavailable. Check Downloads before adding another copy.';}}),
    ]);
    loading=false;schedule();
  }
  async function refresh() {
    if(starting || report?.refreshing) return;
    starting=true;error='';
    try {await api.episodesRefresh();if(!destroyed){report={...(report || {}),refreshing:true};schedule();}}
    catch {if(!destroyed)error='Could not start the check. Please try again.';}
    finally {if(!destroyed)starting=false;}
  }
  onMount(()=>{load();});
  onDestroy(()=>{destroyed=true;clearTimeout(pollTimer);});
  function searchFor(show,season,episode) {
    const bare=show.replace(/\s*\(\d{4}\)\s*$/,'');
    navigate(`/downloads?q=${encodeURIComponent(episode!=null?`${bare} ${epCode(season,episode)}`:`${bare} Season ${season}`)}`);
  }
  const date = t => t ? new Date(t).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : 'Never';
</script>

<div class="page">
  <header><div><h1 class="display">Episodes</h1><p class="muted">Find missing episodes and keep up with your shows.</p></div>
    <button class="cta" onclick={refresh} disabled={starting || report?.refreshing}>{starting || report?.refreshing?'Checking…':'Check for updates'}</button>
  </header>
  {#if error}<p class="error" role="alert">{error} <button onclick={load}>Retry</button></p>{/if}
  {#if report?.refreshError}<p class="error" role="alert">{report.refreshError}</p>{/if}
  {#if report?.refreshing}
    {@const p=report.refreshProgress}
    <div class="checking" role="status" aria-live="polite">
      <strong>Checking your shows{p?.currentShow?` · ${p.currentShow}`:''}</strong>
      {#if p}<progress max={p.showsTotal || 1} value={p.showsDone}></progress><span>{p.showsDone} of {p.showsTotal} shows · {p.seasonsChecked} seasons reviewed</span>{:else}<span>Starting the check…</span>{/if}
    </div>
  {/if}
  {#if report}
    <div class="stats"><span><strong>{complete}</strong> complete</span><span><strong>{gaps}</strong> with missing episodes</span><span><strong>{needsCheck}</strong> need checking</span></div>
    {#if needsCheck}<p class="muted">Unchecked, outdated, and failed checks are kept separate from complete shows. Checks run in batches; use Check for updates again if some remain.</p>{/if}
    {#if downloadError}<p class="muted" role="status">{downloadError}</p>{/if}
    <div class="toolbar"><input type="search" bind:value={query} placeholder="Find a show…" aria-label="Find a show" />
      <div class="filters" aria-label="Episode filters">{#each filters as [key,label]}<button class:chosen={filter===key} aria-pressed={filter===key} onclick={()=>filter=key}>{label}</button>{/each}</div>
    </div>
    <p class="muted">{shows.length} show{shows.length===1?'':'s'}{filter==='new'?' with missing episodes aired in the last 30 days':''}</p>
    {#if !shows.length}<div class="empty">{query?'No shows match your search.':filter==='new'?'No recently aired episodes are missing.':'No shows in this view.'}</div>{/if}
    {#each shows as s (s.show)}
      <details class="showcard" open={filter==='new'}>
        <summary><span class="showtitle">{s.show}</span><span class="badges">{#if s.ongoing}<span>Ongoing</span>{/if}<span class:good={s.complete}>{s.complete?'Complete':s.missingCount?`${s.missingCount} missing`:'Needs checking'}</span>{#if s.needsCheck && s.missingCount}<span>Needs checking</span>{/if}</span></summary>
        {#if s.unmatched}<p class="muted">This show hasn’t been identified yet. Open its title page to load its details, then check again.</p>{/if}
        {#each s.seasons.filter(x=>filter!=='new' || recentEpisodes({seasons:[x]}).length) as season (season.season)}
          <details class="season" open={filter==='new'}>
            <summary><strong>Season {season.season}</strong><span>{season.held} in library{season.total!=null?` · ${season.total} listed`:''}{season.needsCheck?' · Needs checking':''}</span></summary>
            <p class="muted">Last successful check: {date(season.checkedAt)}</p>
            {#if season.error}<p class="error">Couldn’t check this season: {season.error}. Earlier results are kept where available.</p>{/if}
            {#if !season.held && season.missing.length}<button class="action" onclick={()=>searchFor(s.show,season.season,null)}>Search season</button>{/if}
            {#each (filter==='new'?recentEpisodes({seasons:[season]}):season.missing) as e (e.episode)}
              {@const download=episodeDownload(torrents,s.show,season.season,e.episode)}
              <div class="episode"><div class="info"><strong>{epCode(season.season,e.episode)} · {e.title || 'Title unavailable'}</strong><span class="muted">Aired {e.released}</span>
                {#if download}<a href="/downloads" onclick={(event)=>{event.preventDefault();navigate('/downloads');}}>Possible matching download · {downloadLabel(download)}</a>{/if}
              </div><button class="action" onclick={()=>searchFor(s.show,season.season,e.episode)}>Search</button></div>
            {/each}
            {#if !season.missing.length}<p class="muted">{season.needsCheck?'Episode information needs checking.':'All known aired episodes are in your library.'}</p>{/if}
            {#if season.future}<p class="muted">{season.future} episode{season.future===1?'':'s'} awaiting release or a confirmed air date.</p>{/if}
          </details>
        {/each}
      </details>
    {/each}
  {:else if !error}<p role="status">Loading episodes…</p>{/if}
</div>
<style>
.page{padding:calc(64px + var(--s5)) var(--gutter) var(--s7);max-width:1100px;margin:0 auto}header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:24px}h1{font-size:clamp(1.8rem,3.4vw,2.6rem)}.muted{color:var(--ink-soft);font-size:.85rem;line-height:1.6}.error{color:#ff9b9b;line-height:1.6}.stats{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:12px}.stats strong{font-size:1.3rem}.toolbar{margin:24px 0 12px;display:flex;gap:12px;flex-wrap:wrap}input{flex:1;min-width:180px;background:var(--bg-raised);color:var(--ink);border:1px solid var(--line-strong);border-radius:10px;padding:12px}.filters{display:flex;flex-wrap:wrap;gap:6px}button,.action{min-height:44px;padding:10px 14px;border-radius:10px}.filters button,.action{background:var(--bg-raised);border:1px solid var(--line-strong)}.filters .chosen{background:#514186;color:#fff;border-color:#ac92ff}.showcard{border:1px solid var(--line);background:var(--bg-raised);border-radius:14px;margin-top:12px;padding:4px 16px}.showcard>summary{padding:16px 0}.showtitle{font-size:1rem;font-weight:700;margin-right:16px}.badges{display:inline-flex;flex-wrap:wrap;gap:8px;color:var(--ink-soft);font-size:.8rem}.good{color:#8dddab}summary{cursor:pointer;min-height:44px;line-height:1.8}summary:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #bba5ff;outline-offset:3px}.season{border-top:1px solid var(--line);padding:8px 0}.season summary span{margin-left:12px;color:var(--ink-soft);font-size:.85rem}.episode{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding:12px 0}.info{display:flex;flex-direction:column;gap:5px;min-width:0;overflow-wrap:anywhere}.info strong{font-size:.92rem}.info a{color:#c4b0ff;font-size:.82rem;padding:8px 0;min-height:44px}.checking{display:flex;flex-direction:column;gap:8px;padding:16px;border-radius:12px;background:var(--bg-raised);margin-bottom:16px}progress{width:100%;accent-color:#ac92ff}.empty{padding:32px 0;color:var(--ink-soft)}@media(max-width:600px){.toolbar input{width:100%;flex-basis:100%}.badges{display:flex;margin-top:6px}.episode{align-items:flex-start}.season summary span{display:block;margin-left:18px}.showcard{padding:4px 12px}}
</style>
