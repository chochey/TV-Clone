const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path'),{EventEmitter}=require('events');
test('organizer status remains readable through unprivileged is-active with isolated controls enabled',async()=>{
 const calls=[],module={exports:{}};let privileged=0;
 const spawn=(command,args)=>{calls.push({command,args});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>{child.stdout.emit('data','active\n');child.emit('close',0);});return child;};
 const requireMock=name=>name==='child_process'?{spawn}:name==='./control-client'?{controlRequest:()=>{privileged++;return Promise.resolve({ok:true});}}:require(name);
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'system-control.js'),'utf8'),{module,require:requireMock,process:{env:{TVCLONE_CONTROL_SOCKET:'/restricted.sock'}}});
 const sys=module.exports({ORGANIZER_SERVICE:'tvclone-organizer.service',ALLOWED_CONTAINERS:['gluetun'],ALLOWED_DOCKER_ACTIONS:['restart']});
 const result=await sys.organizerServiceCmd('status');assert.equal(result.ok,true);assert.equal(privileged,0);assert.equal(calls[0].command,'systemctl');assert.deepEqual(Array.from(calls[0].args),['is-active','tvclone-organizer.service']);
 const invalid=await sys.organizerServiceCmd('enable');assert.equal(invalid.ok,false);assert.equal(calls.length,1);
});
