// A pause bookmark survives media-source resets and delayed browser events.
export function createPauseBookmark() {
  let bookmark = null;
  return {
    capture(position, now = Date.now()) {
      if (Number.isFinite(position) && position >= 0) bookmark = { position, at: now };
    },
    seek(position) { if (bookmark && Number.isFinite(position) && position >= 0) bookmark.position = position; },
    take(fallback, now = Date.now()) {
      const result = bookmark ? { position: bookmark.position, expired: now - bookmark.at >= 60000 } : { position: fallback, expired: false };
      bookmark = null;
      return result;
    },
  };
}
