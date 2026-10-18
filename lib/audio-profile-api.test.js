const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');function fixture(){
 const routes=new Map(),profiles=new Map([['one',{progress:{book:{currentTime:20}}}],['two',{}]]);
 const auth=()=>{},library=()=>{};let failSave=false;
 const app=Object.fromEntries(['get','put','post','delete'].map(method=>[method,(route,...handlers)=>routes.set(method+' '+route,handlers)]));
 require('./routes/audio')(app,{audioProfile:require('./audio-profile'),requireAuth:auth,ensureLibrary:library,getRequestProfile:req=>req.profile,
 scanLibrary:()=>[{id:'book',mediaKind:'audio'},{id:'film',mediaKind:'movie'}],loadProfileData:id=>profiles.get(id),
 saveProfileDataStrict:async(id,data)=>{if(failSave)throw Error('disk unavailable');profiles.set(id,data);}});
 async function call(method,route,profile='one',body={},params={}){
  const response={statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
  const handlers=routes.get(method+' '+route);assert.equal(handlers[0],auth);
  await handlers.at(-1)({profile,body,params},response);return response;
 }
 return{call,profiles,fail:()=>{failSave=true;}};
}
test('audio endpoints store bookmarks and speed under the current profile only',async()=>{
 const f=fixture();let response=await f.call('post','/api/audio/bookmarks/:id','one',{time:12,label:'Note'},{id:'book'});
 assert.equal(response.body.bookmarks.length,1);assert.equal(f.profiles.get('two').audioBookmarks,undefined);
 assert.equal((await f.call('get','/api/audio/bookmarks/:id','two',{}, {id:'book'})).body.bookmarks.length,0);
 response=await f.call('put','/api/audio/preferences','one',{speed:1.75});assert.equal(response.body.speed,1.75);
 assert.equal((await f.call('get','/api/audio/preferences','two')).body.speed,1);
 assert.equal((await f.call('post','/api/audio/bookmarks/:id',null,{time:1},{id:'book'})).statusCode,403);
 assert.equal((await f.call('post','/api/audio/bookmarks/:id','one',{time:1},{id:'film'})).statusCode,404);
});
test('audio endpoints wait for persistence and expose save failures',async()=>{
 const f=fixture();f.fail();const response=await f.call('post','/api/audio/bookmarks/:id','one',{time:1},{id:'book'});
 assert.equal(response.statusCode,503);assert.equal(f.profiles.get('one').audioBookmarks,undefined);
 assert.equal((await f.call('put','/api/audio/preferences','one',{speed:9})).statusCode,400);
});
