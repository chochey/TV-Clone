export function physicalDriveWarnings(disks = []) {
  return disks.filter(d => (!d.source || d.source.startsWith('/dev/')) && Number(d.percent ?? d.pct) >= 90)
    .map(d => ({ mount: d.mount, label: d.label || d.mount, percent: Number(d.percent ?? d.pct), available: d.available ?? d.avail }))
    .sort((a, b) => b.percent - a.percent);
}
