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
async function fixture(page,state=initial()) {
  const writes=[];
  await page.route('**/*',route=>route.abort());
  await page.route(`${origin}/**`,async route=>{
    const requested=new URL(route.request().url()).pathname;
    const file=requested.startsWith('/assets/')?path.join(dist,requested):path.join(dist,'index.html');
    let body=await fs.readFile(file);if(file.endsWith('index.html'))body=body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g,'');
    return route.fulfill({body,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.route('**/api/**',route=>{
    const requested=new URL(route.request().url()).pathname;
    if(!['GET','HEAD'].includes(route.request().method()))writes.push(requested);
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
