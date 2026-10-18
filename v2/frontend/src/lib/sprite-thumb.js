// CSS for one seek-preview tile. Sprite sheets are cols×rows tiles, one frame
// every `interval` seconds, baked at 160×90 and shown scaled up — the mild
// upscale reads fine for a soft preview and beats rebaking every sheet.
export const THUMB_SCALE = 1.5;

export function spriteThumbStyle(sprite, t, id, scale = THUMB_SCALE) {
  const per = sprite.cols * sprite.rows;
  const fi = Math.min(Math.floor(t / sprite.interval), sprite.totalSheets * per - 1);
  const sheet = Math.floor(fi / per);
  const pos = fi % per;
  const col = pos % sprite.cols;
  const row = Math.floor(pos / sprite.cols);
  const w = sprite.width * scale;
  const h = sprite.height * scale;
  return `background-image:url(/api/sprites/${encodeURIComponent(id)}/${sheet});` +
    `background-size:${sprite.cols * w}px ${sprite.rows * h}px;` +
    `background-position:-${col * w}px -${row * h}px;` +
    `width:${w}px;height:${h}px`;
}
