import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dist=fileURLToPath(new URL('../dist/',import.meta.url)),origin='http://audio-language.test';
async function fixture(page,{tracks,selected=3,mode='remux'}={}) {
  const requests=[];
  const item={id:'film',title:'Language test',type:'movie',streamMode:'direct',codec:'h264',progress:{currentTime:120,percent:5},subtitles:[]};
  const audioTracks=tracks||[{index:0,label:'Ukrainian · Stereo',isDefault:false},{index:2,label:'Ukrainian · 5.1',isDefault:false},{index:3,label:'English · 5.1',isDefault:true}];
  await page.addInitScript(()=>{window.Hls=class {
    static Events={MANIFEST_PARSED:'manifest',ERROR:'error'};
    static ErrorTypes={MEDIA_ERROR:'media',NETWORK_ERROR:'network'};
    loadSource(){} attachMedia(){} destroy(){} on(){} startLoad(){}
  };});
  await page.route('**/*',route=>route.abort());
  await page.route(`${origin}/**`,async route=>{
    const p=new URL(route.request().url()).pathname;
    const file=p.startsWith('/assets/')?path.join(dist,p):path.join(dist,'index.html');
    let body=await fs.readFile(file);if(file.endsWith('.html'))body=body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g,'');
    return route.fulfill({body,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.route('**/api/**',route=>{
    const p=new URL(route.request().url()).pathname;
    let body={};
    if(p==='/api/me')body={loggedIn:true,role:'admin',profileId:'test',name:'Test'};
    else if(p==='/api/library')body=[item];
    else if(p==='/api/library/sections')body={ok:true,sections:[]};
    else if(p==='/api/item/film')body={...item,streamMode:mode,audioTracks,defaultAudioTrack:selected};
    else if(p==='/api/dismissed')body={continueWatching:{},recentlyAdded:{}};
    else if(p==='/api/notifications')body={notifications:[]};
    else if(p==='/api/requests')body={requests:[]};
    else if(p==='/api/events')return route.fulfill({status:204});
    else if(p==='/api/health')body={ready:true};
    return route.fulfill({json:body});
  });
  await page.route('**/hls/**',route=>{
    if(new URL(route.request().url()).pathname.startsWith('/api/'))return route.fulfill({json:{ok:true,alive:true}});
    requests.push(new URL(route.request().url()));
    return route.fulfill({body:'#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n',headers:{'X-Total-Duration':'2400','X-Seek-Offset':'120'},contentType:'application/vnd.apple.mpegurl'});
  });
  await page.route('**/stream/**',route=>{requests.push(new URL(route.request().url()));return route.fulfill({status:404});});
  await page.goto(origin+'/title/film');
  await page.locator('.actions').getByRole('button',{name:/^(Play|Resume)$/,exact:true}).click();
  return requests;
}

test('fresh item overrides stale direct mode and selects English before requesting audio',async({page})=>{
  const requests=await fixture(page);
  await expect.poll(()=>requests.length).toBe(1);
  expect(requests[0].pathname).toMatch(/^\/hls\//);
  expect(requests[0].searchParams.get('audio')).toBe('3');
  expect(requests[0].searchParams.get('start')).toBe('120');
  await page.getByRole('button',{name:'Audio track',exact:true}).click();
  await expect(page.getByRole('button',{name:'English · 5.1',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Ukrainian · Stereo',exact:true}).click();
  await expect.poll(()=>requests.length).toBe(2);
  expect(requests[1].searchParams.get('audio')).toBe('0');
  expect(requests[1].searchParams.get('start')).toBe('120');
  await page.getByRole('button',{name:'Audio track',exact:true}).click();
  await expect(page.getByRole('button',{name:'Ukrainian · Stereo',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Audio track',exact:true}).click();
  await page.getByRole('button',{name:'Quality',exact:true}).click();
  await page.getByRole('button',{name:'Data Saver (720p)',exact:true}).click();
  await expect.poll(()=>requests.length).toBe(3);
  expect(requests[2].searchParams.get('audio')).toBe('0');
});

test('a file without English keeps the server fallback and does not invent English',async({page})=>{
  const requests=await fixture(page,{selected:2,tracks:[{index:0,label:'Japanese',isDefault:false},{index:2,label:'French',isDefault:true}]});
  await expect.poll(()=>requests.length).toBe(1);expect(requests[0].searchParams.get('audio')).toBe('2');
  await page.getByRole('button',{name:'Audio track',exact:true}).click();
  await expect(page.getByRole('button',{name:'French',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:/English/})).toHaveCount(0);
});
