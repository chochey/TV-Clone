// Completion is about downloaded bytes, not whether the torrent is still seeding.
// Keep failures and organizer reviews visible so they cannot disappear unnoticed.
export function splitDownloads(torrents) {
  const active = [], completed = [];
  for (const torrent of torrents || []) {
    const needsAttention = torrent.reviewReason || torrent.importStatus?.label === 'Needs review'
      || ['error', 'missingFiles', 'checkingDL', 'checkingUP', 'checkingResumeData', 'moving'].includes(torrent.state);
    (torrent.progress >= 1 && !needsAttention ? completed : active).push(torrent);
  }
  return { active, completed };
}
