// Synthetic API interception only; no real conversion, file access or service actions.
import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dist=fileURLToPath(new URL('../dist/',import.meta.url)),origin='http://conversion.test';
const tier={count:2,bytes:10e9,breakdown:{both:{count:0}},imageSubsCount:0};
const plan={plan:{tiers:{container:tier,audio:tier,legacy:tier,video:tier}},eligibleSelected:2,
  config:{enabled:true,tiers:{container:true,audio:false,legacy:false,video:false},cpuCores:2,videoCrf:20,minFreeSpaceGB:10,maxFilesPerRun:1,
    retainOriginals:false,keepOriginalsDays:14,retainedBudgetGB:100,schedule:{start:'',end:''},pauseWhilePlaying:true},disk:{availBytes:1e12,drives:[]}};
const initial=()=>({status:'interrupted',scope:'all',runId:'saved-run',total:3,done:1,remaining:2,converted:1,failed:0,skipped:0,
  current:null,waitingReason:'',history:[{name:'Verified movie.mkv',filePath:'/synthetic/Verified movie.mkv',runId:'saved-run',at:1,ok:true,originalDeleted:true}],runs:[],results:[]});
async function fixture(page,state=initial(),options={}) {
  const writes=[];
  const entries=options.entries || [];
  options.repair ||= {status:'idle',entries:[]};
  options.requests ||= [];
  options.previewRequests ||= [];
  await page.route('**/*',route=>route.abort());
  await page.route(`${origin}/**`,async route=>{
    const requested=new URL(route.request().url()).pathname;
    if(requested.startsWith('/repair-preview/')){options.previewRequests.push(requested);return route.fulfill({status:204});}
    const file=requested.startsWith('/assets/')?path.join(dist,requested):path.join(dist,'index.html');
    let body=await fs.readFile(file);if(file.endsWith('index.html'))body=body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g,'');
    return route.fulfill({body,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.route('**/api/**',route=>{
    const requested=new URL(route.request().url()).pathname;
    if(!['GET','HEAD'].includes(route.request().method())){writes.push(requested);options.requests.push({path:requested,body:route.request().postDataJSON()});}
    if(requested==='/api/conversion/review/retry') {state={...state,status:'running',current:entries[0]?.name};return route.fulfill({json:state});}
    if(requested==='/api/conversion/repair/start') {
      if(options.failRepairStart)return route.fulfill({status:409,json:{error:options.failRepairStart}});
      options.repair={status:'running',reviewId:entries[0]?.id,name:entries[0]?.name,stage:'Checking source',progress:12,entries:[]};
      return route.fulfill({json:options.repair});
    }
    if(requested==='/api/conversion/repair/stop') {options.repair={...options.repair,status:'cancelled'};return route.fulfill({json:options.repair});}
    if(requested==='/api/conversion/repair/apply') {
      if(options.failApply)return route.fulfill({status:409,json:{error:options.failApply}});
      const installed={...options.repair,status:'installed',busy:false,candidate:null,warnings:options.cleanupWarning?[options.cleanupWarning]:[]};
      options.repair={...installed,entries:[installed]};entries.splice(0,entries.length);return route.fulfill({json:{ok:true,status:'installed',...(options.cleanupWarning?{cleanupWarning:options.cleanupWarning}:{})}});
    }
    if(requested==='/api/conversion/resume'){state={...state,status:'running'};return route.fulfill({json:state});}
    if(requested==='/api/conversion/stop'){state={...state,status:'idle'};return route.fulfill({json:state});}
    if(requested==='/api/events')return route.fulfill({status:204});
    let body={};
    if(requested==='/api/me')body={loggedIn:true,role:'admin',profileId:'synthetic',name:'Synthetic Admin'};
    else if(requested==='/api/health')body={ready:true};
    else if(requested==='/api/library')body=[];
    else if(requested==='/api/library/sections')body={ok:true,sections:[]};
    else if(requested==='/api/dismissed')body={continueWatching:{},recentlyAdded:{}};
    else if(requested==='/api/notifications')body={notifications:[]};
    else if(requested==='/api/requests')body={requests:[]};
    else if(requested==='/api/conversion/plan')body=plan;
    else if(requested==='/api/conversion/status')body=state;
    else if(requested==='/api/conversion/review'){const offset=Number(new URL(route.request().url()).searchParams.get('offset')) || 0;body={ok:true,total:entries.length,entries:options.paginate ? entries.slice(offset,offset+100) : entries};}
    else if(requested==='/api/conversion/repair/status')body=options.repair;
    else if(requested==='/api/conversion/originals')body={items:[],totalBytes:0,expiredCount:0,keepOriginalsDays:14};
    return route.fulfill({json:body});
  });
  return writes;
}

test('interrupted run and saved history remain visible without automatic POST; Resume is explicit',async({page})=>{
  await page.setViewportSize({width:390,height:844});const writes=await fixture(page);
  await page.goto(`${origin}/conversion`);
  await expect(page.getByRole('button',{name:'Resume interrupted run',exact:true})).toBeVisible();
  await expect(page.getByText(/Nothing starts automatically/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Recent conversion history'})).toBeVisible();
  await expect(page.getByText('converted · original deleted after verification',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/^Convert all \(/})).toHaveCount(0);expect(writes).toEqual([]);
  await page.getByRole('button',{name:'Resume interrupted run',exact:true}).click();
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  expect(writes).toEqual(['/api/conversion/resume']);
  await page.reload();await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  expect(writes).toEqual(['/api/conversion/resume']);
});

test('Stop ends an interrupted run and reload never offers to resume it',async({page})=>{
  const writes=await fixture(page);await page.goto(`${origin}/conversion`);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.getByRole('button',{name:'Convert all (2 files)',exact:true})).toBeEnabled();
  await page.reload();await expect(page.getByRole('button',{name:'Resume interrupted run',exact:true})).toHaveCount(0);
  expect(writes).toEqual(['/api/conversion/stop']);
});

test('deferred same-name files show independent blockers without inflating review counts',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const writes=await fixture(page,{...initial(),status:'running',deferredCount:2,deferred:[
    {id:'drive-a-episode',name:'episode.mkv',code:'storage',reason:'Drive A needs free space'},
    {id:'drive-b-episode',name:'episode.mkv',code:'playback',reason:'Currently being streamed'},
  ]});
  await page.goto(`${origin}/conversion`);await expect(page.getByText('1 converted · 0 need review',{exact:true})).toBeVisible();
  await page.getByText('2 files waiting for playback or storage',{exact:true}).click();
  await expect(page.getByText('episode.mkv — Drive A needs free space',{exact:true})).toBeVisible();
  await expect(page.getByText('episode.mkv — Currently being streamed',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  expect(writes).toEqual([]);
});


const idle=()=>({...initial(),status:'idle',total:0,remaining:0,history:[]});
const problem=()=>({id:'review-1',name:'The Sopranos - S01E02.avi',summary:'An audio frame could not be decoded.',details:'[mp3float] Header missing',category:'decode',firstFailedAt:'2026-10-10T08:00:00Z',lastFailedAt:'2026-10-10T08:00:00Z',attempts:1});
const candidate=()=>({status:'ready',reviewId:'review-1',name:'The Sopranos - S01E02.avi',candidate:{verified:true,previewUrl:'/repair-preview/review-1'},entries:[]});

test('review is readable on a phone, never starts itself, and retries exactly one selected file',async({page})=>{
  await page.setViewportSize({width:390,height:844});const options={entries:[problem()]};const writes=await fixture(page,idle(),options);
  await page.goto(`${origin}/conversion`);
  await expect(page.getByRole('heading',{name:'Needs review',exact:true})).toBeVisible();
  await expect(page.getByText('An audio frame could not be decoded.',{exact:true})).toBeVisible();
  await expect(page.getByText('[mp3float] Header missing',{exact:true})).not.toBeVisible();
  await page.getByText('Show error details',{exact:true}).click();
  await expect(page.getByText('[mp3float] Header missing',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  expect(writes).toEqual([]);
  if(process.env.CONVERSION_REVIEW_PROOF_DIR){await fs.mkdir(process.env.CONVERSION_REVIEW_PROOF_DIR,{recursive:true});await page.locator('.review-section').evaluate(el=>window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-90,behavior:'instant'}));await page.locator('.review-section').screenshot({path:path.join(process.env.CONVERSION_REVIEW_PROOF_DIR,'conversion-review-phone.png')});}
  await page.getByRole('button',{name:'Retry only The Sopranos - S01E02.avi',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry only The Sopranos - S01E02.avi',exact:true})).toBeDisabled();
  expect(options.requests).toEqual([{path:'/api/conversion/review/retry',body:{id:'review-1'}}]);
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
});

test('repair copy progress locks conversion, can be cancelled, and keeps the source',async({page})=>{
  const options={entries:[problem()]};const writes=await fixture(page,idle(),options);await page.goto(`${origin}/conversion`);
  await page.getByRole('button',{name:'Create repair copy for The Sopranos - S01E02.avi',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Creating repair copy',exact:true})).toBeVisible();
  await expect(page.getByRole('progressbar',{name:'Repair progress'})).toHaveAttribute('aria-valuenow','12');
  await expect(page.getByRole('button',{name:'Convert all (2 files)',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Retry only The Sopranos - S01E02.avi',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Cancel repair',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Repair cancelled',exact:true})).toBeVisible();
  await expect(page.getByText('Your original is unchanged. No replacement was added to your library.',{exact:true})).toBeVisible();
  expect(writes).toEqual(['/api/conversion/repair/start','/api/conversion/repair/stop']);
});

test('verified candidate is previewed on demand and replacement requires an explicit confirmation',async({page})=>{
  const options={entries:[problem()],repair:candidate()};const writes=await fixture(page,idle(),options);await page.goto(`${origin}/conversion`);
  await expect(page.getByRole('button',{name:'Use verified copy…',exact:true})).toBeEnabled();
  expect(options.previewRequests).toEqual([]);expect(writes).toEqual([]);
  await page.getByRole('button',{name:'Preview repair copy',exact:true}).click();
  await expect(page.locator('video.repair-preview')).toHaveAttribute('src','/repair-preview/review-1');
  await page.getByRole('button',{name:'Use verified copy…',exact:true}).click();
  await expect(page.getByRole('region',{name:'Confirm repair replacement'})).toContainText('It will not be deleted by this action.');
  await page.getByRole('button',{name:'Cancel replacement',exact:true}).click();
  await expect(page.getByRole('region',{name:'Confirm repair replacement'})).toHaveCount(0);expect(writes).toEqual([]);
  await page.getByRole('button',{name:'Use verified copy…',exact:true}).click();
  await page.getByRole('button',{name:'Confirm use of verified copy',exact:true}).click();
  await expect(page.getByText('Verified copy added to your library. The original is saved below for recovery.',{exact:true})).toBeVisible();
  expect(options.requests).toEqual([{path:'/api/conversion/repair/apply',body:{id:'review-1'}}]);
});

test('failed replacement remains reviewable with a clear error and does not retry itself',async({page})=>{
  const options={entries:[problem()],repair:candidate(),failApply:'The source changed. Create a new repair copy.'};const writes=await fixture(page,idle(),options);await page.goto(`${origin}/conversion`);
  await page.getByRole('button',{name:'Use verified copy…',exact:true}).click();await page.getByRole('button',{name:'Confirm use of verified copy',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:options.failApply})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Needs review',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Confirm repair replacement'})).toHaveCount(0);
  await page.reload();await expect(page.getByRole('button',{name:'Use verified copy…',exact:true})).toBeEnabled();
  expect(writes).toEqual(['/api/conversion/repair/apply']);
});

test('saved candidates remain accessible after a different repair finishes',async({page})=>{
  const options={entries:[problem()],repair:{status:'failed',name:'Another movie.mkv',reviewId:'review-2',error:'Not recoverable',entries:[candidate()]}};
  const writes=await fixture(page,idle(),options);await page.goto(`${origin}/conversion`);
  await page.getByRole('button',{name:'Review saved repair copy for The Sopranos - S01E02.avi',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Repair copy ready to check',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Use verified copy…',exact:true})).toBeEnabled();expect(writes).toEqual([]);
});


test('review pagination exposes older files beyond the first page without starting work',async({page})=>{
  const entries=Array.from({length:101},(_,i)=>({...problem(),id:`review-${i}`,name:`Movie ${String(i).padStart(3,'0')}.avi`}));
  const options={entries,paginate:true};const writes=await fixture(page,idle(),options);await page.goto(`${origin}/conversion`);
  await page.getByRole('button',{name:'Load more review files (1 remaining)',exact:true}).click();
  await page.getByPlaceholder('Search loaded names or issues').fill('Movie 100');
  await expect(page.getByRole('heading',{name:'Movie 100.avi',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry only Movie 100.avi',exact:true})).toBeEnabled();expect(writes).toEqual([]);
});


for (const status of ['installed','interrupted']) test(`completed backend status ${status} is readable and never locks idle conversion`,async({page})=>{
  const record={reviewId:'review-1',sourceName:problem().name,name:problem().name,status,stage:status==='installed'?'Verified replacement installed':'Interrupted',progress:{percent:100},error:status==='interrupted'?'Repair was interrupted. The original was kept; create a new repair copy.':'',warnings:[],previewReady:false};
  const options={entries:status==='installed'?[]:[problem()],repair:{...record,busy:false,candidate:null,entries:[record]}};
  const writes=await fixture(page,idle(),options);await page.goto(`${origin}/conversion`);
  await expect(page.getByRole('heading',{name:status==='installed'?'Verified copy added':'Repair interrupted',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Convert all (2 files)',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Cancel repair',exact:true})).toHaveCount(0);
  if(status==='interrupted')await expect(page.getByRole('button',{name:'Create repair copy for The Sopranos - S01E02.avi',exact:true})).toBeEnabled();
  await page.reload();await expect(page.getByRole('button',{name:'Convert all (2 files)',exact:true})).toBeEnabled();expect(writes).toEqual([]);
});

test('successful installation with pending cleanup shows the warning instead of an unconditional success',async({page})=>{
  const options={entries:[problem()],repair:candidate(),cleanupWarning:'Replacement saved with original retained; installation record needs recovery before further conversions.'};
  const writes=await fixture(page,idle(),options);await page.goto(`${origin}/conversion`);
  await page.getByRole('button',{name:'Use verified copy…',exact:true}).click();await page.getByRole('button',{name:'Confirm use of verified copy',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:options.cleanupWarning})).toBeVisible();
  await expect(page.getByText('Verified copy added to your library. The original is saved below for recovery.',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Cancel repair',exact:true})).toHaveCount(0);expect(writes).toEqual(['/api/conversion/repair/apply']);
});
