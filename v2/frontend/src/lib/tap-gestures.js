// Touch on the video: double-tap the left or right half to seek, single tap to
// play/pause. A single tap waits out the double-tap window before acting.
// Desktop keeps click = play/pause and double-click = fullscreen; the synthetic
// click/dblclick a browser fires after a touch is recognised by touchedRecently().
export const DOUBLE_TAP_MS = 320;
const SYNTHETIC_CLICK_MS = 600;

export function createTapGestures({ onSingle, onDouble, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let lastTap = 0;
  let pending = null;
  let recent = false;
  let recentTimer = null;

  function pointerUp(e, width) {
    if (e.pointerType !== 'touch') return;
    recent = true;
    clearTimer(recentTimer);
    recentTimer = setTimer(() => { recent = false; }, SYNTHETIC_CLICK_MS);
    const t = now();
    clearTimer(pending);
    pending = null;
    if (t - lastTap < DOUBLE_TAP_MS) {
      lastTap = 0;
      onDouble(e.clientX > width / 2 ? 'right' : 'left');
    } else {
      lastTap = t;
      pending = setTimer(() => { pending = null; onSingle(); }, DOUBLE_TAP_MS);
    }
  }

  return {
    pointerUp,
    touchedRecently: () => recent,
    stop() { clearTimer(pending); clearTimer(recentTimer); pending = null; },
  };
}
