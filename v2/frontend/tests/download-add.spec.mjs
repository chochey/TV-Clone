import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dist=fileURLToPath(new URL('../dist/',import.meta.url)),origin='http://download-add.test';
const magnet='magnet:?xt=urn:btih:'+'a'.repeat(40);
async function fixture(page,outcome,{failFirst=false}={}) {
  const adds=[];
  await page.route('**/*',route=>route.abort());
  await page.route(`${origin}/**`,async route=>{
    const p=new URL(route.request().url()).pathname,file=p.startsWith('/assets/')?path.join(dist,p):path.join(dist,'index.html');
    let body=await fs.readFile(file);if(file.endsWith('.html'))body=body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g,'');
    return route.fulfill({body,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.route('**/api/**',route=>{
    const p=new URL(route.request().url()).pathname;let body={};
    if(p==='/api/me')body={loggedIn:true,role:'admin',profileId:'test',name:'Test'};
    else if(p==='/api/library'||p==='/api/qbt/torrents')body=[];
    else if(p==='/api/library/sections')body={ok:true,sections:[]};
    else if(p==='/api/dismissed')body={continueWatching:{},recentlyAdded:{}};
    else if(p==='/api/notifications')body={notifications:[]};
    else if(p==='/api/events')return route.fulfill({status:204});
    else if(p==='/api/health')body={ready:true};
    else if(p==='/api/qbt/search/plugins')body=[{name:'fixture',enabled:true}];
    else if(p==='/api/vpn/status')body={configured:false};
    else if(p==='/api/qbt/search/start')body={id:1};
    else if(p==='/api/qbt/search/results')body={total:1,status:'Stopped',results:[{fileUrl:magnet,fileName:'Example show 1080p',nbSeeders:5,fileSize:1234}]};
    else if(p==='/api/qbt/torrents/add'){
      adds.push(route.request().postDataJSON());
      if(failFirst&&adds.length===1)return route.fulfill({status:500,json:{error:'Downloader unavailable.'}});
      body=outcome;
    }
    return route.fulfill({json:body});
  });
  await page.goto(origin+'/downloads');return adds;
}
test('search duplicate displays existing library status and clears a previous error',async({page})=>{
  const adds=await fixture(page,{ok:true,alreadyExists:true,imported:true,message:'This download is already in your library.'},{failFirst:true});
  await page.getByPlaceholder('Search torrents…',{exact:true}).fill('Example show');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByRole('button',{name:'Download',exact:true}).click();
  await expect(page.getByText('Downloader unavailable.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Download',exact:true}).click();
  await expect(page.getByText('✓ Already in your library',{exact:true})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('already in your library');
  await expect(page.getByText('Downloader unavailable.',{exact:true})).toHaveCount(0);
  expect(adds).toEqual([{urls:magnet},{urls:magnet}]);
});
test('pasting an existing download explains it and leaves no false failure',async({page})=>{
  await fixture(page,{ok:true,alreadyExists:true,imported:false,message:'This download is already in Downloads.'});
  await page.locator('.add input').fill(magnet);
  await page.getByRole('button',{name:'Add',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('already in Downloads');
  await expect(page.locator('.add input')).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
