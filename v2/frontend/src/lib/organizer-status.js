// Plain-English lines for the Organizer page, from the status the organizer keeps current.

// OMDb's free key allows this many lookups a day.
export const OMDB_DAILY_LIMIT = 1000;
const NEAR_LIMIT = 0.9;

const plural = (count, one, many) => (count === 1 ? one : many);

export function spanText(milliseconds) {
  const seconds = Math.round(Math.max(0, milliseconds) / 1000);
  if (seconds < 10) return 'a few seconds';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function activityText(status, now) {
  const activity = status.activity || {};
  switch (activity.state) {
    case 'importing':
      return `Importing ${activity.detail || 'a download'}${activity.since ? ` for ${spanText(now - activity.since)}` : ''}.`;
    case 'scanning': return 'Checking the download folder.';
    case 'starting': return 'Starting up.';
    case 'stopped': return 'Stopped.';
    case undefined:
    case 'idle':
      return status.lastScan?.at ? `Idle. Last checked ${spanText(now - status.lastScan.at)} ago.` : 'Idle.';
    default:
      return `Organizer state: ${activity.state}.`;   // a state this page does not know yet: say it, do not guess
  }
}

function omdbText(omdb, now) {
  if (!omdb?.failing) return null;
  const how = omdb.since ? ` for ${spanText(now - omdb.since)}` : '';
  const why = omdb.reason ? ` (${omdb.reason})` : '';
  const waiting = omdb.waiting > 0
    ? `${omdb.waiting} ${plural(omdb.waiting, 'download is', 'downloads are')} waiting for it and will be filed on ${plural(omdb.waiting, 'its', 'their')} own when it is back.`
    : 'Nothing is waiting for it right now.';
  return `OMDb (the movie and episode name lookup) has not been responding${how}${why}. ${waiting}`;
}

export function describeStatus(status, now = Date.now()) {
  if (!status) return null;
  const used = status.omdb?.requestsToday || 0;
  return {
    activity: activityText(status, now),
    omdb: omdbText(status.omdb, now),
    requests: used > 0 ? `${used.toLocaleString('en-US')} of ${OMDB_DAILY_LIMIT.toLocaleString('en-US')} OMDb lookups used today` : null,
    nearLimit: used >= OMDB_DAILY_LIMIT * NEAR_LIMIT,
  };
}
