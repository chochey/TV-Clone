// When a watchdog pass is worth a journal line. As a timer it logged four "all fine" lines a minute
// (~7,000 a day); as a loop it prints the first pass, every problem, the recovery, and any pass that
// actually did something (cleaned stale transcodes).
function worthPrinting(previous, result) {
  if (!previous) return true;
  if (!result.ok) return true;
  if (previous.ok !== result.ok) return true;
  return (result.results || []).some(step => step.ok === false || (step.count || 0) > 0);
}

module.exports = { worthPrinting };
