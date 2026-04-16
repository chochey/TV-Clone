// Fixed-size ring buffer for admin event logs. Newest entry first.
module.exports = function createLogRing(maxEntries) {
  const entries = [];
  return {
    entries,
    push(entry) {
      entries.unshift({ timestamp: Date.now(), ...entry });
      if (entries.length > maxEntries) entries.pop();
    },
    get() { return entries; },
  };
};
