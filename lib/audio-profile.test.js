const {test}=require('node:test');const assert=require('node:assert/strict');const audio=require('./audio-profile');
test('audio preferences validate input and retain unrelated profile state',()=>{
 const data={progress:{book:{currentTime:500}}};assert.equal(audio.preferences(data).speed,1);
 const updated=audio.updatePreferences(data,{speed:1.5});assert.equal(audio.preferences(updated).speed,1.5);assert.deepEqual(updated.progress,data.progress);assert.equal(data.audioPreferences,undefined);
 for(const speed of [null,'2',Infinity,NaN,0,4])assert.throws(()=>audio.updatePreferences(data,{speed}));
});
test('bookmarks are isolated per book and profile, ordered and removable',()=>{
 const original={progress:{a:{currentTime:5}}};const first=audio.addBookmark(original,'a',{time:120,label:'  A scene  '},1);
 const second=audio.addBookmark(first,'a',{time:60,label:'Earlier'},2);
 assert.deepEqual(audio.bookmarks(second,'a').map(b=>b.time),[60,120]);assert.equal(audio.bookmarks(second,'a')[1].label,'A scene');
 assert.deepEqual(audio.bookmarks(second,'b'),[]);assert.deepEqual(audio.bookmarks(original,'a'),[]);assert.deepEqual(audio.bookmarks({},'a'),[]);
 const updated=audio.removeBookmark(second,'a',audio.bookmarks(second,'a')[0].id);assert.equal(audio.bookmarks(updated,'a').length,1);assert.equal(audio.bookmarks(second,'a').length,2);
});
test('invalid and excessive bookmarks cannot grow profile data unchecked',()=>{
 for(const time of [-1,Infinity,NaN,'50',null,31536001])assert.throws(()=>audio.addBookmark({},'a',{time}));
 const data={audioBookmarks:{a:Array.from({length:200},()=>({time:1}))}};assert.throws(()=>audio.addBookmark(data,'a',{time:2}),/200/);
 assert.equal(audio.bookmarks(audio.addBookmark({},'a',{time:0,label:'x'.repeat(1000)}),'a')[0].label.length,120);
});
