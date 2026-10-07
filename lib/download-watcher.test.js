const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('vm');const fs=require('fs');const path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const block=source.slice(source.indexOf('const downloadReviews = new Map();'),source.indexOf('// Notification history for the bell'));
function fixture(qbt){
 let tick; const snapshots=[];
 const context=vm.createContext({writeDownloadReadiness(){},downloadsWithStatus:async rows=>{snapshots.push(rows);return rows;},QBT_USERNAME:'test',QBT_PASSWORD:'test',qbt,qbtJson:r=>r,
 torrentHasVideoFile:require('./video-torrent').torrentHasVideoFile,
 notifyLogLib:require('./notify-log'),notifyLog:{push(){}},notifyClients(){},
 setInterval:fn=>{tick=fn;return {unref(){}};},setTimeout(){},rescanLibraryAsync:async()=>{}});
 vm.runInContext(block,context);return {tick:()=>tick(),context,snapshots};
}
test('non-video files are flagged but no torrents or files are changed',async()=>{
 const calls=[];const f=fixture(async(method,url)=>{calls.push({method,url});return url.endsWith('/info')?[{hash:'a',name:'Music',progress:0.1,state:'downloading'}]:[{name:'music.flac'}];});
 await f.tick();assert.ok(calls.every(c=>c.method==='GET'));
 assert.match(vm.runInContext("downloadReviews.get('a')",f.context),/Kept/);
});
test('a slow watcher cannot start overlapping polls',async()=>{
 let release,calls=0;const f=fixture(()=>{calls++;return new Promise(resolve=>release=resolve);});
 const first=f.tick();await f.tick();assert.equal(calls,1);release([]);await first;
});
test('successful watcher snapshots reconcile import visibility without a browser and failed polls do not prune',async()=>{
 const torrents=[{hash:'movie',name:'Imported movie',progress:1,state:'stoppedUP'}];
 let fail=false;
 const f=fixture(async(_method,url)=>{if(fail)throw new Error('unavailable');return url.endsWith('/info')?torrents:[{name:'movie.mp4'}];});
 await f.tick();assert.equal(f.snapshots.length,1);assert.equal(f.snapshots[0],torrents);
 fail=true;await f.tick();assert.equal(f.snapshots.length,1);
});
