// Keep existing public IDs while recognizing one-to-one file moves. Content
// samples are read asynchronously once per changed file; subsequent scans only
// stat files. Ambiguous copies deliberately stay separate.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const legacyId = file => crypto.createHash('sha256').update(file).digest('hex').slice(0, 16);
const statFields = st => ({size:st.size,mtimeMs:st.mtimeMs,dev:st.dev,ino:st.ino,ctimeMs:st.ctimeMs});
const sameStat = (a,b) => ['size','mtimeMs','dev','ino','ctimeMs'].every(key => a[key] === b[key]);
async function fingerprint(file, st, io = fs.promises) {
  if (st.isFile && !st.isFile()) throw new Error('Media identity requires a regular file');
  const handle = await io.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameStat(st,opened)) throw new Error('Media changed before reading identity');
    const hash = crypto.createHash('sha256').update(String(st.size));
    const length = Math.min(16384, st.size);
    for (const position of new Set([0, Math.max(0, Math.floor(st.size / 2) - length / 2), Math.max(0, st.size - length)])) {
      const buffer = Buffer.alloc(length);
      const {bytesRead} = await handle.read(buffer, 0, length, Math.floor(position));
      if (bytesRead !== length) throw new Error('Media changed while reading identity');
      hash.update(buffer);
    }
    const after = await handle.stat();
    const pathname = await (io.lstat || io.stat).call(io,file);
    if (!sameStat(st,after) || !sameStat(after,pathname) || pathname.isSymbolicLink?.()) throw new Error('Media changed while reading identity');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

function createMediaIdentity({file, save, io = fs.promises}) {
  let entries = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error('Invalid identity registry');
    const ids = new Set();
    for (const [name, entry] of Object.entries(parsed.entries)) {
      if (!path.isAbsolute(name) || !/^[a-f0-9]{16}$/.test(entry?.id)) throw new Error('Invalid media identity');
      if (ids.has(entry.id)) throw new Error('Invalid duplicate media identity');
      ids.add(entry.id);
    }
    entries = parsed.entries;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let currentPaths = new Set(), allowMoves = true, roots = [];
  let unassignedPaths = new Set(), observations = new Map(), revision = 0;
  const index = new Map(), idOwners = new Map(), pending = new Set();
  function indexEntry(name, entry) {
    if (!idOwners.has(entry.id)) idOwners.set(entry.id,new Set());
    idOwners.get(entry.id).add(name);
    if (!entry.fingerprint) return;
    const key = `${entry.size}:${entry.fingerprint}`;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(name);
  }
  for (const [name, entry] of Object.entries(entries)) indexEntry(name, entry);
  function put(name, entry) {
    const old = entries[name];
    if (old) {
      const owners=idOwners.get(old.id);owners?.delete(name);
      if (owners?.size===0) idOwners.delete(old.id);
    }
    if (old?.fingerprint) index.get(`${old.size}:${old.fingerprint}`)?.delete(name);
    if (entry) { entries[name] = entry; indexEntry(name, entry); }
    else delete entries[name];
  }
  function seed(library) {
    for (const item of library || []) if (item._filePath && /^[a-f0-9]{16}$/.test(item.id)
        && !entries[item._filePath] && !idOwners.has(item.id)) {
      put(item._filePath, {id:item.id, size:item.fileSize, mtimeMs:item.addedAt});
    }
  }
  const persist = () => save(file, {version:1, entries});
  function observe(name,st) {
    const previous=observations.get(name);
    if (previous && sameStat(previous.st,st)) return previous.sample;
    const sample=fingerprint(name,st,io);observations.set(name,{st,sample});return sample;
  }
  async function uniqueNewDestination(name,st,sample) {
    const others=[...unassignedPaths].filter(other=>other!==name);
    for (let start=0;start<others.length;start+=16) {
      const matches=await Promise.all(others.slice(start,start+16).map(async other=>{
        try {
          const otherStat=await (io.lstat || io.stat).call(io,other);
          if (!otherStat.isFile() || otherStat.size!==st.size || Math.abs(otherStat.mtimeMs-st.mtimeMs)>1) return false;
          return await observe(other,otherStat)===sample;
        } catch { return true; } // Cannot prove uniqueness across an unreadable new path.
      }));
      if (matches.some(Boolean)) return false;
    }
    return true;
  }
  async function resolve(name, st) {
    const known = entries[name];
    if (pending.has(name)) throw new Error('Media identity relocation is in progress');
    if (known?.fingerprint && sameStat(known,st)) return known.id;
    const sample = await observe(name, st);
    // A conversion may publish its replacement while this asynchronous read
    // is in flight. Do not resurrect its old path over the committed binding.
    if (entries[name] !== known) throw new Error('Media identity changed during scan');
    let id = known?.id;
    if (!id && st.size > 0 && allowMoves) {
      const candidates = [];
      for (const oldPath of index.get(`${st.size}:${sample}`) || []) {
        const old = entries[oldPath];
        if (pending.has(oldPath)) continue;
        if (roots.length && !roots.some(root => oldPath.startsWith(root + path.sep))) continue;
        if (currentPaths.has(oldPath) || Math.abs(old.mtimeMs - st.mtimeMs) > 1) continue;
        if ([...(idOwners.get(old.id) || [])].some(p => currentPaths.has(p))) continue;
        try { await io.stat(oldPath); }
        catch(error) { if (error.code === 'ENOENT') candidates.push(oldPath); }
      }
      if (candidates.length === 1 && await uniqueNewDestination(name,st,sample)) {
        if (entries[name] !== known || pending.has(name)) throw new Error('Media identity changed during scan');
        const previous=entries[candidates[0]];
        if (!previous || pending.has(candidates[0]) || [...(idOwners.get(previous.id) || [])].some(p=>currentPaths.has(p))) throw new Error('Media identity changed during scan');
        id = previous.id;
        put(candidates[0], null);
      }
    }
    // Reusing a vacated pathname must not duplicate an existing permanent ID.
    if (!id) {
      const preferred = legacyId(name);
      id = idOwners.has(preferred) ? crypto.randomBytes(8).toString('hex') : preferred;
    }
    if (entries[name] !== known || pending.has(name)) throw new Error('Media identity changed during scan');
    put(name, {id, ...statFields(st), fingerprint:sample});
    return id;
  }
  // Called only after conversion verifies and places its replacement. Return
  // an undo action so a later durability failure can restore both file and ID.
  async function relocate(oldPath, newPath) {
    if (pending.has(oldPath) || pending.has(newPath)) throw new Error('Media identity relocation is already in progress');
    pending.add(oldPath);pending.add(newPath);revision++;
    try {
    const beforeOld = entries[oldPath], beforeNew = entries[newPath];
    const id = beforeOld?.id || legacyId(oldPath);
    const st = await io.stat(newPath);
    const sample = await fingerprint(newPath, st, io);
    put(oldPath, null);
    put(newPath, {id, ...statFields(st), fingerprint:sample});
    const rollback = async () => {
      put(newPath, beforeNew || null);
      put(oldPath, beforeOld || {id});
      await persist();
    };
    try { await persist(); } catch(error) { await rollback(); throw error; }
    return async () => {
      if (pending.has(oldPath) || pending.has(newPath)) throw new Error('Media identity relocation is already in progress');
      pending.add(oldPath);pending.add(newPath);revision++;
      try {await rollback();} finally {pending.delete(oldPath);pending.delete(newPath);revision++;}
    };
    } finally {pending.delete(oldPath);pending.delete(newPath);revision++;}
  }
  return {seed, begin: (paths, options={}) => {
    currentPaths = new Set(paths); allowMoves = options.allowMoves !== false; roots = options.roots || [];
    unassignedPaths = new Set(paths.filter(name=>!entries[name]));observations = new Map();
  }, resolve, persist, relocate,
    get revision(){return revision;},
    isCurrent: (name,id) => !pending.has(name) && entries[name]?.id===id,
    idForPath: name => entries[name]?.id || legacyId(name)};
}
module.exports = {createMediaIdentity, fingerprint, legacyId};
