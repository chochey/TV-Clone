// Keyboard shortcuts for the video player. Returns what a key means, or null
// when the player should leave it alone: typing in a field, or a browser/OS
// chord — without that, Ctrl+F (find) toggled fullscreen and Cmd+ArrowLeft
// (back) seeked instead.
const KEYS = {
  ' ': ['toggle', true], k: ['toggle', true],
  ArrowLeft: ['back', true], ArrowRight: ['forward', true],
  ArrowUp: ['louder', true], ArrowDown: ['quieter', true],
  m: ['mute', false], f: ['fullscreen', false], Escape: ['escape', false],
};

export function playerKeyAction(e) {
  if (e.target?.closest?.('input')) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const hit = KEYS[e.key];
  return hit ? { action: hit[0], prevent: hit[1] } : null;
}
