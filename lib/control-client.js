// The web process has no sudo or Docker socket access. Privileged operations
// travel through a root-owned helper with a fixed allow list.
const net=require('net');
function controlRequest(action,args={}, {socketPath=process.env.TVCLONE_CONTROL_SOCKET,timeoutMs=90000}={}) {
 return new Promise(resolve=>{
  if(!socketPath)return resolve({ok:false,code:-1,stderr:'Restricted system control is not configured'});
  let body='',done=false;const socket=net.createConnection(socketPath);
  const finish=result=>{if(done)return;done=true;socket.destroy();resolve(result);};
  socket.setTimeout(timeoutMs,()=>finish({ok:false,code:-1,stderr:'System control timed out'}));
  socket.on('connect',()=>socket.write(JSON.stringify({action,...args})+'\n'));
  socket.on('data',chunk=>{body+=chunk.toString();if(body.length>2*1024*1024)return finish({ok:false,code:-1,stderr:'System control response too large'});const end=body.indexOf('\n');if(end>=0){try{finish(JSON.parse(body.slice(0,end)));}catch{finish({ok:false,code:-1,stderr:'Invalid system control response'});}}});
  socket.on('error',error=>finish({ok:false,code:-1,stderr:error.message}));
  socket.on('end',()=>{if(!done)finish({ok:false,code:-1,stderr:'System control disconnected'});});
 });
}
module.exports={controlRequest};
