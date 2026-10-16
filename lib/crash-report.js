// Formats whatever a crash handler is handed into one bounded log line.
// Rejections carry arbitrary values, not just Errors -- a string, null, or an
// object with a throwing getter all reach these handlers, and the reporter
// must never itself throw while reporting a crash.
const MAX = 2000;

function describeCrash(reason) {
  let text;
  try {
    if (reason instanceof Error) text = reason.stack || `${reason.name}: ${reason.message}`;
    else if (typeof reason === 'string') text = reason;
    else if (reason === undefined) text = 'undefined';
    else text = JSON.stringify(reason) ?? String(reason);
  } catch { text = '[unprintable rejection value]'; }
  if (typeof text !== 'string') text = String(text);
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  return text.length > MAX ? `${text.slice(0, MAX)}… (truncated)` : text;
}

module.exports = { describeCrash, MAX };
