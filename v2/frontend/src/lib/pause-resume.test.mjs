import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPauseBookmark} from './pause-resume.js';
test('long pause resumes the bookmarked position even if media time resets',()=>{
 const b=createPauseBookmark(); b.capture(1842.5,1000);
 assert.deepEqual(b.take(0,121001),{position:1842.5,expired:true});
 assert.deepEqual(b.take(1843,121002),{position:1843,expired:false});
});
test('short pauses reuse playback and an intentional paused seek updates the bookmark',()=>{
 const b=createPauseBookmark();b.capture(400,1000);b.seek(900);
 assert.deepEqual(b.take(0,2000),{position:900,expired:false});
 b.capture(900,2000);b.seek(1200);assert.deepEqual(b.take(0,63000),{position:1200,expired:true});
});
test('invalid positions cannot replace a valid pause bookmark',()=>{
 const b=createPauseBookmark();b.capture(25,1);b.capture(NaN,2);b.seek(-1);
 assert.deepEqual(b.take(0,60001),{position:25,expired:true});
});
