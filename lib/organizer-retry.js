const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_PACKET_BYTES = 32768;
const MAX_PENDING = 64;
const issue = (status, message) => Object.assign(new Error(message), { status });
const sourceKey = source => crypto.createHash('sha256').update(source).digest('hex').slice(0, 24);
const safeSource = source => typeof source === 'string' && source.length > 0 && Buffer.byteLength(source) <= 255
  && !/[\\/\x00-\x1f\x7f]/.test(source) && !source.startsWith('.') && !source.startsWith('_') && source.toLowerCase() !== 'incomplete';

module.exports = function createOrganizerRetry({ sourceDir, spoolDir, getReviewQueue, now = Date.now,
  shared = process.env.ORGANIZER_RETRY_SHARED === '1', gid = process.env.ORGANIZER_RETRY_GID,
  identity = () => ({uid:process.geteuid(), groups:[process.getegid(), ...process.getgroups()]}) }) {
  const inflight = new Map();
  const group = /^(?:[1-9]\d*)$/.test(String(gid)) && Number.isSafeInteger(Number(gid)) && Number(gid) < 0xffffffff
    ? Number(gid) : null;
  const fileMode = shared ? 0o660 : 0o600;
  const unavailable = () => issue(503, 'The retry queue is unavailable.');

  async function ensureSpool() {
    if (shared) {
      // A deployment administrator provisions the dedicated group and setgid
      // directory. Neither service may broaden a pre-existing directory.
      const who = identity();
      if (group === null || !who.groups.includes(group)) throw unavailable();
      let st;
      try { st = await fs.promises.lstat(spoolDir); } catch { throw unavailable(); }
      if (group === null || !who.groups.includes(group) || !st.isDirectory()
          || st.gid !== group || (st.uid !== 0 && st.uid !== who.uid)
          || (st.mode & 0o7777) !== 0o2770) throw unavailable();
      return;
    }
    await fs.promises.mkdir(spoolDir, { recursive:true, mode:0o700 });
    if (!(await fs.promises.lstat(spoolDir)).isDirectory()) throw unavailable();
  }
  async function readPacket(file) {
    let handle;
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = await handle.stat();
      if (!st.isFile() || st.size > MAX_PACKET_BYTES
          || (shared && (st.gid !== group || (st.mode & 0o7777) !== fileMode))) throw unavailable();
      const text = await handle.readFile({ encoding:'utf8' });
      if (Buffer.byteLength(text) > MAX_PACKET_BYTES) throw issue(503, 'The retry queue is unavailable.');
      return JSON.parse(text);
    } finally { await handle?.close(); }
  }
  async function syncSpool() {
    const dir = await fs.promises.open(spoolDir, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async function enqueue(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw issue(400, 'Choose an unresolved review entry to retry.');
    const entry = (await getReviewQueue()).find(item => item.id === id);
    if (!entry || entry.resolved || entry.stillPresent === false || !['movie','show'].includes(entry.type) || !safeSource(entry.source)) {
      throw issue(404, 'This release is no longer available for retry. Refresh the review queue.');
    }
    const key = sourceKey(entry.source);
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        if (!(await fs.promises.lstat(sourceDir)).isDirectory()) throw issue(503, 'The download folder is unavailable.');
        const st = await fs.promises.lstat(path.join(sourceDir, entry.source), { bigint:true });
        if (!st.isFile() && !st.isDirectory()) throw issue(409, 'The source is not a regular release.');
        await ensureSpool();
        const fingerprint = { device:String(st.dev), inode:String(st.ino), kind:st.isDirectory() ? 'directory' : 'file' };
        for (const suffix of ['.json','.claimed.json']) {
          try {
            const existing = await readPacket(path.join(spoolDir, key + suffix));
            if (existing.source !== entry.source || JSON.stringify(existing.fingerprint) !== JSON.stringify(fingerprint)
                || !/^[a-f0-9]{32}$/.test(existing.requestId || '')) throw issue(409, 'A retry for an earlier release is still pending.');
            return { ok:true, queued:true, requestId:existing.requestId, source:entry.source };
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const names = await fs.promises.readdir(spoolDir);
        if (names.filter(name => /^[a-f0-9]{24}(?:\.claimed)?\.json$/.test(name)).length >= MAX_PENDING) {
          throw issue(503, 'The retry queue is full. Wait for the current imports to finish.');
        }
        const packet = { version:1, requestId:crypto.randomBytes(16).toString('hex'), source:entry.source,
          title:String(entry.title || '').slice(0, 1000), type:entry.type, createdAt:now(), fingerprint };
        const temp = path.join(spoolDir, `.${key}.${crypto.randomBytes(6).toString('hex')}.tmp`);
        let handle;
        try {
          handle = await fs.promises.open(temp, 'wx', fileMode);
          if (shared) {
            // Creation is affected by umask. Set the mode on the owned open
            // file, and confirm setgid inheritance before publishing it.
            await handle.chmod(fileMode);
            const created = await handle.stat();
            if (created.gid !== group) throw unavailable();
          }
          await handle.writeFile(JSON.stringify(packet)); await handle.sync(); await handle.close(); handle = null;
          // Exclusive publication also coalesces callers in other processes.
          try { await fs.promises.link(temp, path.join(spoolDir, key + '.json')); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const existing = await readPacket(path.join(spoolDir, key + '.json'));
            if (existing.source !== packet.source || JSON.stringify(existing.fingerprint) !== JSON.stringify(fingerprint)
                || !/^[a-f0-9]{32}$/.test(existing.requestId || '')) throw issue(409, 'A retry for an earlier release is still pending.');
            packet.requestId = existing.requestId;
          }
          await syncSpool();
        } finally { await handle?.close(); try { await fs.promises.unlink(temp); } catch {} }
        return { ok:true, queued:true, requestId:packet.requestId, source:entry.source };
      } catch (error) {
        if (error.status) throw error;
        if (error.code === 'ENOENT') throw issue(404, 'This release is no longer available for retry.');
        throw issue(503, 'Could not safely queue the retry. Please try again.');
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, job); return job;
  }

  async function snapshot() {
    try {
      await ensureSpool();
      const names = (await fs.promises.readdir(spoolDir)).filter(name => /^[a-f0-9]{24}(?:\.(?:claimed|done))?\.json$/.test(name))
        .sort((a,b) => Number(a.endsWith('.done.json')) - Number(b.endsWith('.done.json'))).slice(0, 256);
      const statuses = new Map();
      for (const name of names) {
        try {
          const packet = await readPacket(path.join(spoolDir, name));
          if (!/^[a-f0-9]{32}$/.test(packet.requestId || '') || !safeSource(packet.source) || !Number.isFinite(packet.createdAt)) continue;
          const status = name.endsWith('.done.json') ? packet.status : name.endsWith('.claimed.json') ? 'claimed' : 'queued';
          if (!['queued','claimed','attempted','rejected'].includes(status)) continue;
          const publicPacket = { requestId:packet.requestId, source:packet.source, status, createdAt:packet.createdAt,
            ...(Number.isFinite(packet.completedAt) ? { completedAt:packet.completedAt } : {}) };
          // If a completed receipt and its claim coexist briefly, receipt wins.
          const previous = statuses.get(packet.requestId);
          if (!previous || status === 'attempted' || status === 'rejected') statuses.set(packet.requestId, publicPacket);
        } catch { /* One unavailable receipt must not break the review queue. */ }
      }
      return [...statuses.values()].sort((a,b) => b.createdAt - a.createdAt);
    } catch { return []; }
  }
  return { enqueue, snapshot };
};
