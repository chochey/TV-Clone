// A file replaced under the same name keeps its path, so it keeps its id (lib/media-identity.js), but
// the probe caches are keyed by path and a scan only probed paths it had no results for. Interstellar
// (2014), a 4K AV1 file replaced by a 1080p H.264 copy under its old name (2026-11-08), would have kept
// being treated as AV1 and converted on the CPU. The scan forgets the old results when a file's size or
// modification time changed, and the post-scan probe reads the new file.

function replacedInPlace(previous, size, mtimeMs) {
  return !!previous && (previous.fileSize !== size || previous.addedAt !== mtimeMs);
}

function forgetProbeResults(caches, filePath) {
  let forgot = false;
  for (const cache of caches) {
    if (Object.hasOwn(cache, filePath)) { delete cache[filePath]; forgot = true; }
  }
  return forgot;
}

module.exports = { replacedInPlace, forgetProbeResults };
