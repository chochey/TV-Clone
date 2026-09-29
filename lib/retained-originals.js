const fs = require('fs');
const path = require('path');

// One asynchronous inventory shared by the page and the conversion budget.
// Mutations invalidate the inventory; an old in-flight scan cannot repopulate it.
module.exports = function createInventory({ newPathFor, io = fs.promises, now = Date.now, ttlMs = 30000 }) {
  let generation = 0;
  const cache = new Map(), pending = new Map();
  function invalidate() { generation++; cache.clear(); pending.clear(); }
  async function scan(roots) {
    const out = [], dirs = roots.map(dir => ({ dir, depth: 0 }));
    const exists = async file => { try { await io.access(file); return true; } catch { return false; } };
    // Process at most four directories concurrently, including retention files.
    while (dirs.length) {
      const batch = dirs.splice(0, 4);
      await Promise.all(batch.map(async ({ dir, depth }) => {
        let entries;
        try { entries = await io.readdir(dir, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const child = path.join(dir, entry.name);
          if (entry.name === '.converted-originals') {
            const files = await io.readdir(child, { withFileTypes: true });
            for (const file of files) {
              if (!file.isFile() || file.name.endsWith('.conversion.json')) continue;
              const retainedPath = path.join(child, file.name);
              let st;
              try { st = await io.stat(retainedPath); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
              let retainedAt = st.ctimeMs;
              try { const m = JSON.parse(await io.readFile(retainedPath + '.conversion.json', 'utf8')); if (Number.isFinite(m.retainedAt)) retainedAt = m.retainedAt; } catch {}
              const originalPath = path.join(dir, file.name);
              const currentPath = newPathFor(originalPath);
              const replacementExists = await exists(currentPath);
              const canRestore = originalPath === currentPath || !await exists(originalPath);
              out.push({ retainedPath, originalPath, currentPath, name: file.name, size: st.size, retainedAt,
                replacementExists, canRestore, restorable: replacementExists });
            }
          } else if (!entry.name.startsWith('.') && depth < 4) dirs.push({ dir: child, depth: depth + 1 });
        }
      }));
    }
    return out.sort((a, b) => a.retainedAt - b.retainedAt);
  }
  async function list(roots, keepDays, { fresh = false } = {}) {
    const normalized = [...new Set(roots.map(r => path.resolve(r)))].sort();
    const key = JSON.stringify(normalized);
    if (fresh) invalidate();
    let entry = cache.get(key);
    if (!entry || now() - entry.at >= ttlMs) {
      let job = pending.get(key);
      if (!job) {
        const version = generation;
        job = scan(normalized).then(items => {
          const value = { at: now(), items };
          if (generation === version) cache.set(key, value);
          return value;
        }).finally(() => { if (pending.get(key) === job) pending.delete(key); });
        pending.set(key, job);
      }
      entry = await job;
    }
    return entry.items.map(i => ({ ...i, ageDays: Math.floor((now() - i.retainedAt) / 86400000), expired: now() - i.retainedAt > keepDays * 86400000 }));
  }
  return { list, invalidate };
};
