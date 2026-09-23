import {test} from 'node:test';
import assert from 'node:assert/strict';
import {moodMatches, discoveryPool, nextPick} from './home-discovery.js';
test('moods match whole genres from either metadata source',()=>{
 const a={id:'a',genres:[' Comedy ']},b={id:'b',genre:'Action,Comedy'},c={id:'c',genre:'Actionable'};
 assert.deepEqual(moodMatches([a,b,c],'action'),[b]);assert.deepEqual(moodMatches([a,b,c],'Comedy'),[a,b]);
});
test('discovery favors unstarted unwatched movies and excludes featured item',()=>{
 const a={id:'a',type:'movie'},b={id:'b',type:'movie',watched:true},c={id:'c',type:'movie',progress:{percent:10}},d={id:'d',type:'show'};
 assert.deepEqual(discoveryPool([a,b,c,d]),[a]);assert.deepEqual(discoveryPool([a,b,c,d],'a'),[b,c]);
});
test('shuffle avoids current choice and handles empty and single-item libraries',()=>{
 const a={id:'a'},b={id:'b'};assert.equal(nextPick([],null),null);assert.equal(nextPick([a],'a'),a);assert.equal(nextPick([a,b],'a',()=>0),b);
});
