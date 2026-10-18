// When to offer Skip Intro, and when the up-next card shows and rolls on.
//
// Skip Intro: only while inside the intro, and only when the range lands
// somewhere useful — a bogus range (end <= start, or at the credits) would
// strand the viewer.
//
// Up next: nobody sits through the credits, so waiting for `ended` means
// autoplay effectively never fires. Advance early instead, but only as early as
// is provably safe: shortly into the credits when the server knows where they
// start, otherwise at the true end so a file that stops abruptly never loses content.
export const UPNEXT_LEAD = 30;   // seconds the card is on screen before advancing
export const OUTRO_GRACE = 10;   // once credits start, how long before advancing

export function introOffer({ intro, total, cur, scrubbing = false }) {
  const valid = !!intro && intro.end > intro.start && (!total || intro.end < total - 2);
  const show = valid && !scrubbing && cur >= intro.start && cur < intro.end - 0.5;
  return { valid, show };
}

export function upNext({ total, cur, outro, dismissed = false, scrubbing = false, error = '' }) {
  const advanceAt = !total ? 0
    : (outro && outro.start > 0 && outro.start < total ? Math.min(outro.start + OUTRO_GRACE, total) : total);
  const secondsLeft = Math.max(0, Math.ceil(advanceAt - cur));
  const nearEnd = !!total && !dismissed && !scrubbing && !error && cur >= advanceAt - UPNEXT_LEAD && cur < total;
  return { advanceAt, secondsLeft, nearEnd };
}
