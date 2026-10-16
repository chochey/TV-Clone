// Rules shared by everything that reads the organizer's log (the library-rescan
// trigger, the attention notifications, the Needs Review parser), so they cannot
// disagree about which lines count.

// Python's tempfile directories (/tmp/tmpab12cd34/...) only ever show up when a
// unit-test run wrote into the live log. Such lines are not real organizer
// activity: they must never trigger a rescan, a notification or a review entry.
const TEMP_ARTIFACT = /\/tmp\/tmp[a-z0-9_]{6,}/;

const isTestArtifact = line => TEMP_ARTIFACT.test(String(line));

const STAMP = /^\[?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]?\s*/;
const stripStamp = line => String(line).replace(STAMP, '');

// "EVENT: {"event": "moved", "release": ..., "source": ..., "destination": ...}" is what the
// organizer writes, one line per completed move. Anything else (another kind of event, a
// half-written line, missing fields) is simply not a move.
function parseMovedEvent(message) {
  if (!message.startsWith('EVENT: {')) return null;
  try {
    const event = JSON.parse(message.slice(7));
    if (!event || event.event !== 'moved' || typeof event.source !== 'string' || typeof event.destination !== 'string'
        || !event.source || !event.destination) return null;
    return { source: event.source, destination: event.destination, release: typeof event.release === 'string' ? event.release : null };
  } catch { return null; }
}

// Every completed move in the log, oldest first, from either form: the event above, or the older
// pair "Import source: A -> B" then "Moved -> B" that history written before events still has.
// A planned import alone is not a move. When both forms describe the same move it counts once,
// and the event (which names the release) is the one kept.
function parseMoves(lines) {
  const moves = [];
  let planned = null;      // the last "Import source:" until its "Moved ->" arrives
  let pending = null;      // an older-form move, held back in case its event follows
  const flush = () => { if (pending) moves.push(pending); pending = null; };
  for (const raw of lines) {
    const message = stripStamp(raw);
    if (isTestArtifact(message)) continue;
    const event = parseMovedEvent(message);
    if (event) {
      if (pending && pending.destination === event.destination) pending = null;
      flush();
      moves.push(event);
      continue;
    }
    flush();
    if (message.startsWith('Import source: ')) {
      const parts = message.slice(15).split(' -> ');
      planned = parts.length === 2 ? { source: parts[0], destination: parts[1] } : null;
    } else if (message.startsWith('Moved -> ')) {
      const destination = message.slice(9);
      if (planned && planned.destination === destination) pending = { source: planned.source, destination, release: null };
      planned = null;
    }
  }
  flush();
  return moves;
}

module.exports = { TEMP_ARTIFACT, isTestArtifact, stripStamp, parseMovedEvent, parseMoves };
