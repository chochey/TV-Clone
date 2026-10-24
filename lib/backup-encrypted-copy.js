// An encrypted copy of a verified snapshot, for a disk that cannot keep files private.
//
// The media pool is NTFS: every file there is readable by every program on the box, and a
// snapshot holds password hashes and live sign-in sessions. So the pool gets one encrypted file
// per snapshot: AES-256-GCM over a gzip of the snapshot's files, the key derived from a
// passphrase (scrypt) kept in a root-only file and, crucially, in the owner's password manager:
// a copy is only worth something when the system disk is gone, and the passphrase with it.
//
// File layout: "TVCB1\n" | salt (16) | iv (12) | ciphertext | GCM tag (16). The plaintext is a
// bundle of `{"path","size"}\n` + bytes per file, then `{"end":true}\n`. Every copy is decrypted
// and checked against the snapshot's own SHA-256 manifest before it replaces its temporary name.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable, Transform, Writable } = require('stream');
const { verifySnapshot } = require('./verified-backup');
const { privateDirectory } = require('./private-backup');

const MAGIC = Buffer.from('TVCB1\n');
const SALT_BYTES = 16, IV_BYTES = 12, TAG_BYTES = 16, HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSPHRASE = 16;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024, MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024, MAX_ENTRIES = 5000;
const ARCHIVE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{12}\.tvbackup$/;
const fail = code => Object.assign(new Error(code), { code });

// The only names a snapshot can contain (lib/verified-backup.js), so a restore can never write
// anywhere else, whatever an archive claims.
function safeRestorePath(name) {
  return typeof name === 'string' && (name === 'manifest.json' || name === 'config.json' || name === 'media-organizer.log'
    || name === 'media-organizer/organizer_aliases.json' || /^data\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.json$/.test(name)
    || /^data\/read-along\/[a-f0-9]{16}\.json$/.test(name));
}

const deriveKey = (passphrase, salt) => crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);

async function* bundle(snapshotDir, names) {
  for (const name of names) {
    const file = path.join(snapshotDir, name);
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw fail('BACKUP_SOURCE');
    yield Buffer.from(`${JSON.stringify({ path: name, size: st.size })}\n`);
    let sent = 0;
    for await (const chunk of fs.createReadStream(file)) { sent += chunk.length; yield chunk; }
    if (sent !== st.size) throw fail('BACKUP_SOURCE');   // snapshots never change; this one did
  }
  yield Buffer.from(`${JSON.stringify({ end: true })}\n`);
}

// Parses the decrypted, decompressed bundle and hands each file to `sink`.
function bundleParser(sink) {
  let buf = Buffer.alloc(0), current = null, remaining = 0, ended = false, entries = 0, total = 0;
  const seen = new Set();
  return new Writable({
    write(chunk, _enc, done) {
      try {
        if (ended) throw fail('BACKUP_DECRYPT');
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          if (current) {
            const take = Math.min(remaining, buf.length);
            if (take) { sink.data(current, buf.subarray(0, take)); buf = buf.subarray(take); remaining -= take; }
            if (remaining > 0) break;
            sink.end(current); current = null;
            continue;
          }
          const nl = buf.indexOf(10);
          if (nl < 0) { if (buf.length > 4096) throw fail('BACKUP_DECRYPT'); break; }
          let head;
          try { head = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch { throw fail('BACKUP_DECRYPT'); }
          buf = buf.subarray(nl + 1);
          if (head?.end === true) { if (buf.length) throw fail('BACKUP_DECRYPT'); ended = true; break; }
          if (!safeRestorePath(head?.path) || seen.has(head.path) || !Number.isInteger(head.size) || head.size < 0
              || head.size > MAX_ENTRY_BYTES || ++entries > MAX_ENTRIES || (total += head.size) > MAX_TOTAL_BYTES) throw fail('BACKUP_DECRYPT');
          seen.add(head.path);
          current = head.path; remaining = head.size;
          sink.begin(current, head.size);
          if (remaining === 0) { sink.end(current); current = null; }
        }
        done();
      } catch (error) { done(error); }
    },
    final(done) { done(ended && !current ? null : fail('BACKUP_DECRYPT')); },
  });
}

async function readArchive(file, passphrase, sink) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size < HEADER_BYTES + TAG_BYTES) throw fail('BACKUP_DECRYPT');
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(HEADER_BYTES), tag = Buffer.alloc(TAG_BYTES);
  try { fs.readSync(fd, header, 0, HEADER_BYTES, 0); fs.readSync(fd, tag, 0, TAG_BYTES, st.size - TAG_BYTES); }
  finally { fs.closeSync(fd); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw fail('BACKUP_DECRYPT');
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES), iv = header.subarray(MAGIC.length + SALT_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  // Plaintext comes out before the tag is checked at the very end, so callers stage what they
  // receive and only accept it once this resolves.
  try {
    await pipeline(fs.createReadStream(file, { start: HEADER_BYTES, end: st.size - TAG_BYTES - 1 }), decipher, zlib.createGunzip(), bundleParser(sink));
  } catch { throw fail('BACKUP_DECRYPT'); }
}

async function writeEncryptedCopy(snapshotDir, copyDir, passphrase, { keep = 14 } = {}) {
  if (!passphrase || String(passphrase).length < MIN_PASSPHRASE) return { ok: false, error: 'NO_KEY' };
  const source = verifySnapshot(snapshotDir);
  if (!source.ok) return { ok: false, error: 'BACKUP_SOURCE' };
  const name = `${path.basename(snapshotDir)}.tvbackup`;
  if (!ARCHIVE.test(name)) return { ok: false, error: 'BACKUP_SOURCE' };
  const expected = new Map(source.manifest.files.map(entry => [entry.path, entry]));
  const manifestBytes = fs.readFileSync(path.join(snapshotDir, 'manifest.json'));
  expected.set('manifest.json', { size: manifestBytes.length, sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex') });
  const names = [...expected.keys()];
  let tmp = null;
  try {
    fs.mkdirSync(copyDir, { recursive: true });
    const final = path.join(copyDir, name);
    if (fs.existsSync(final)) throw fail('BACKUP_EXISTS');
    tmp = path.join(copyDir, `.incomplete-${crypto.randomBytes(6).toString('hex')}`);
    const salt = crypto.randomBytes(SALT_BYTES), iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    let headerSent = false;
    const frame = new Transform({
      transform(chunk, _enc, done) { if (!headerSent) { this.push(Buffer.concat([MAGIC, salt, iv])); headerSent = true; } done(null, chunk); },
      flush(done) { if (!headerSent) this.push(Buffer.concat([MAGIC, salt, iv])); this.push(cipher.getAuthTag()); done(); },
    });
    await pipeline(Readable.from(bundle(snapshotDir, names)), zlib.createGzip({ level: 6 }), cipher, frame,
      fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    const fd = fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Decrypt what was written and match every file against the snapshot's manifest.
    const hashes = new Map(); const sizes = new Map();
    await readArchive(tmp, passphrase, {
      begin(p) { hashes.set(p, crypto.createHash('sha256')); sizes.set(p, 0); },
      data(p, bytes) { hashes.get(p).update(bytes); sizes.set(p, sizes.get(p) + bytes.length); },
      end() {},
    });
    if (hashes.size !== expected.size) throw fail('BACKUP_VERIFY');
    for (const [p, entry] of expected) {
      if (!hashes.has(p) || sizes.get(p) !== entry.size || hashes.get(p).digest('hex') !== entry.sha256) throw fail('BACKUP_VERIFY');
    }
    fs.renameSync(tmp, final); tmp = null;
    const kept = Math.max(1, Number.isInteger(keep) ? keep : 14);
    const copies = fs.readdirSync(copyDir, { withFileTypes: true }).filter(e => e.isFile() && ARCHIVE.test(e.name)).map(e => e.name).sort().reverse();
    const pruned = [];
    for (const old of copies.slice(kept)) { try { fs.rmSync(path.join(copyDir, old)); pruned.push(old); } catch {} }
    return { ok: true, file: final, bytes: fs.statSync(final).size, fileCount: expected.size, kept: Math.min(copies.length, kept), pruned };
  } catch (error) {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
    return { ok: false, error: error?.code && /^[A-Z_]+$/.test(error.code) ? error.code : 'BACKUP_COPY_FAILED' };
  }
}

async function restoreEncryptedCopy(file, passphrase, outDir) {
  const target = path.resolve(outDir);
  if (fs.existsSync(target)) return { ok: false, error: 'BACKUP_DESTINATION' };
  const staging = `${target}.incomplete-${crypto.randomBytes(6).toString('hex')}`;
  const open = new Map();
  try {
    privateDirectory(staging);
    await readArchive(file, passphrase, {
      begin(p) {
        const dest = path.resolve(staging, p);
        if (!dest.startsWith(staging + path.sep)) throw fail('BACKUP_DECRYPT');
        privateDirectory(path.dirname(dest));
        open.set(p, fs.openSync(dest, 'wx', 0o600));
      },
      data(p, bytes) { fs.writeSync(open.get(p), bytes); },
      end(p) { const fd = open.get(p); fs.fsyncSync(fd); fs.closeSync(fd); open.delete(p); },
    });
    fs.renameSync(staging, target);
    const check = verifySnapshot(target);
    if (!check.ok) { fs.rmSync(target, { recursive: true, force: true }); return { ok: false, error: check.error }; }
    return { ok: true, fileCount: check.fileCount, bytes: check.bytes };
  } catch (error) {
    for (const fd of open.values()) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    return { ok: false, error: error?.code === 'BACKUP_DECRYPT' ? 'BACKUP_DECRYPT' : 'BACKUP_RESTORE_FAILED' };
  }
}

module.exports = { writeEncryptedCopy, restoreEncryptedCopy, safeRestorePath };
