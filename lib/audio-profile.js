const crypto = require('crypto');
function preferences(data) {
  const speed = data.audioPreferences?.speed;
  return {speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 3 ? speed : 1};
}
function updatePreferences(data, body) {
  if (typeof body?.speed !== 'number' || !Number.isFinite(body.speed) || body.speed < 0.5 || body.speed > 3) throw new Error('Choose a speed between 0.5 and 3.');
  return {...data, audioPreferences:{speed:body.speed}};
}
const bookmarks = (data, id) => Array.isArray(data.audioBookmarks?.[id]) ? data.audioBookmarks[id] : [];
function addBookmark(data, id, body, now=Date.now()) {
  if (typeof body?.time !== 'number' || !Number.isFinite(body.time) || body.time < 0 || body.time > 31536000) throw new Error('Invalid bookmark position.');
  if (body.label !== undefined && typeof body.label !== 'string') throw new Error('Invalid bookmark label.');
  const list=bookmarks(data,id);
  if (list.length >= 200) throw new Error('This book already has 200 bookmarks. Remove one before adding another.');
  const item={id:crypto.randomUUID(),time:Math.round(body.time*1000)/1000,label:(body.label||'').trim().slice(0,120),createdAt:now};
  return {...data,audioBookmarks:{...data.audioBookmarks,[id]:[...list,item].sort((a,b)=>a.time-b.time)}};
}
function removeBookmark(data,id,bookmarkId) {
  return {...data,audioBookmarks:{...data.audioBookmarks,[id]:bookmarks(data,id).filter(b=>b.id!==bookmarkId)}};
}
module.exports={preferences,updatePreferences,bookmarks,addBookmark,removeBookmark};
