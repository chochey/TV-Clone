// Formatting and chart helpers for the dashboard.
export function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1e9) return `${(b / 1e6).toFixed(0)} MB`;
  if (b < 1e12) return `${(b / 1e9).toFixed(1)} GB`;
  return `${(b / 1e12).toFixed(2)} TB`;
}

export function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = (now - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// The top of a chart's scale: the value rounded up to 1, 2, 2.5, 5 or 10 times a power of ten.
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(n => n >= v);
}

export const percent = (part, whole) => (whole ? Math.round(part / whole * 100) : 0);

const DELIVERY_LABELS = {
  direct: 'Direct', passthrough: 'Passthrough', remux: 'Repackaged',
  'transcode-gpu': 'Encoded (GPU)', 'transcode-cpu': 'Encoded (CPU)', unknown: 'Unknown',
};
export function deliveryMix(byDelivery = {}) {
  const total = Object.values(byDelivery).reduce((a, b) => a + b, 0);
  return Object.entries(byDelivery).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: DELIVERY_LABELS[key] || key, count, pct: percent(count, total) }));
}
