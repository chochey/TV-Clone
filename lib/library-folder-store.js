// Folder changes are serialized and durable before the live catalog is changed.
module.exports = function createFolderStore({ getConfig, persist, onChange = () => {} }) {
  let pending = Promise.resolve();
  function update(build) {
    const job = pending.catch(() => {}).then(async () => {
      const folders = build(getConfig().folders);
      let before;
      do {
        const current = getConfig();
        before = JSON.stringify({ ...current, folders: null });
        await persist({ ...current, folders });
        // Another admin may edit profile/settings fields during this write.
        // Replay those current values without losing this folder transaction.
      } while (JSON.stringify({ ...getConfig(), folders: null }) !== before);
      getConfig().folders = folders;
      onChange();
      return folders;
    });
    pending = job;
    return job;
  }
  return { update };
};
