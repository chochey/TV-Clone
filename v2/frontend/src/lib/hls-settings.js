// hls.js settings for encoded streams.
//
// Buffering: the server encodes the whole episode ahead on disk at 2-10x real
// time, so the limit is what the browser will hold. It keeps two minutes ahead
// (and up to ten when there is room) within 150 MB; hls.js backs off on its own
// if a browser's media memory runs out. Video more than 30 s behind the playhead
// is released (hls.js keeps everything by default), which is what leaves room
// ahead on a long episode. A whole episode can't be held: at 6.6 Mbps an hour is
// about 3 GB, far past what browsers allow a page.
export function hlsSettings({ startupFragments, worker }) {
  return {
    maxBufferLength: 120, maxMaxBufferLength: 600, maxBufferSize: 150 * 1000 * 1000, backBufferLength: 30,
    // Start at segment zero with a reserve suited to the actual segment length.
    // Completed short streams bypass the live-playlist minimum in hls.js.
    startFragPrefetch: true, startPosition: 0, initialLiveManifestSize: startupFragments,
    highBufferWatchdogPeriod: 2, nudgeOffset: 0.2, nudgeMaxRetry: 5,
    // Firefox/Linux MSE has flashed garbage on worker transmux appends; the
    // player passes worker: false there (main-thread mux + fMP4 from the server).
    enableWorker: worker,
    fragLoadingTimeOut: 30000, fragLoadingMaxRetry: 4, fragLoadingRetryDelay: 1000,
    autoStartLoad: false,
  };
}
