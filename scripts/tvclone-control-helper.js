#!/usr/bin/env node
// Install a root-owned copy, never execute privileged code from the writable repo.
const fs=require('fs'),net=require('net'),{execFile}=require('child_process');
const CONTAINERS=new Set(['gluetun','qbittorrent']);
const ACTIONS=new Set(['start','stop','restart']);
function validate(req,config) {
 if(!req || typeof req!=='object')throw Error('Invalid request');
 if(req.action==='organizer' && ACTIONS.has(req.operation))return {cmd:'/usr/bin/systemctl',args:[req.operation,'tvclone-organizer.service']};
 if(req.action==='docker' && CONTAINERS.has(req.container) && ACTIONS.has(req.operation))return {cmd:config.docker,args:[req.operation,req.container]};
 if(req.action==='inspect' && CONTAINERS.has(req.container))return {cmd:config.docker,args:['inspect',req.container],filtered:true};
 if(req.action==='smart' && Array.isArray(config.devices) && config.devices.includes(req.device))return {cmd:'/usr/sbin/smartctl',args:['-H','-A',req.device,'--json']};
 if(req.action==='repair')return {repair:true};
 throw Error('Operation is not permitted');
}
function execute(cmd,args,{timeout=60000}={}) {return new Promise(resolve=>execFile(cmd,args,{timeout,maxBuffer:1024*1024,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/root',DOCKER_HOST:'unix:///var/run/docker.sock'}},(error,stdout,stderr)=>resolve({ok:!error,code:error?.code??0,stdout:stdout||'',stderr:stderr||error?.message||''})));}
async function handle(req,config,run=execute) {
 let rule;try{rule=validate(req,config);}catch(e){return {ok:false,code:403,stderr:e.message};}
 if(rule.repair){
  const args=['compose','--project-name','docker-media','-f',config.compose,'up','-d','gluetun','qbittorrent'];
  const first=await run(config.docker,args);
  if(first.ok)return {...first,repaired:false,step:'compose-up'};
  const remove=await run(config.docker,['compose','--project-name','docker-media','-f',config.compose,'rm','-sf','gluetun','qbittorrent']);
  const last=await run(config.docker,args);
  return {...last,repaired:last.ok,step:'recreate',details:[first.stderr,remove.stderr,last.stderr].filter(Boolean).join('\n')};
 }
 const result=await run(rule.cmd,rule.args);
 if(rule.filtered && result.ok){
  try{result.stdout=JSON.stringify(JSON.parse(result.stdout).map(info=>({State:info.State,HostConfig:{RestartPolicy:info.HostConfig?.RestartPolicy}})));}catch{return {ok:false,code:-1,stderr:'Invalid container status'};}
 }
 return result;
}
function serve(config) {
 const socketPath='/run/tvclone-control/control.sock';
 try{fs.unlinkSync(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}
 let active=0;
 const server=net.createServer(socket=>{
  let body='',answered=false;
  const finish=result=>{if(answered)return;answered=true;socket.end(JSON.stringify(result)+'\n');};
  socket.setTimeout(10000,()=>socket.destroy());
  socket.on('error',()=>{});
  socket.on('data',async chunk=>{
   if(answered)return;body+=chunk.toString();if(body.length>4096){answered=true;socket.destroy();return;}
   const n=body.indexOf('\n');if(n<0)return;answered=true;socket.setTimeout(90000);
   if(active>=4){socket.end(JSON.stringify({ok:false,code:429,stderr:'System control is busy'})+'\n');return;}
   active++;
   try{const result=await handle(JSON.parse(body.slice(0,n)),config);socket.end(JSON.stringify(result)+'\n');}
   catch(e){socket.end(JSON.stringify({ok:false,code:-1,stderr:e.message})+'\n');}
   finally{active--;}
  });
 });
 server.listen(socketPath,()=>{fs.chmodSync(socketPath,0o660);});
 return server;
}
if(require.main===module)serve(JSON.parse(fs.readFileSync('/etc/tvclone/control.json','utf8')));
module.exports={validate,handle,serve};
