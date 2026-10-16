// Rules shared by everything that reads the organizer's log (the library-rescan
// trigger, the attention notifications, the Needs Review parser), so they cannot
// disagree about which lines count.

// Python's tempfile directories (/tmp/tmpab12cd34/...) only ever show up when a
// unit-test run wrote into the live log. Such lines are not real organizer
// activity: they must never trigger a rescan, a notification or a review entry.
const TEMP_ARTIFACT = /\/tmp\/tmp[a-z0-9_]{6,}/;

const isTestArtifact = line => TEMP_ARTIFACT.test(String(line));

module.exports = { TEMP_ARTIFACT, isTestArtifact };
