// Download completion is separate from confirmed library import. Only the
// server's verified import receipt allows a row to leave the default list.
export function splitDownloads(torrents) {
  const active = [], completed = [], imported = [];
  for (const torrent of torrents || []) {
    const needsAttention = torrent.reviewReason || torrent.importStatus?.label === 'Needs review'
      || ['error', 'missingFiles', 'checkingDL', 'checkingUP', 'checkingResumeData', 'moving'].includes(torrent.state);
    if (torrent.progress >= 1 && !needsAttention && torrent.importStatus?.readyToHide === true) imported.push(torrent);
    else (torrent.progress >= 1 && !needsAttention ? completed : active).push(torrent);
  }
  return { active, completed, imported };
}
