// Mullvad paid time. Downloads ride the Mullvad tunnel, and Mullvad is prepaid:
// when the account runs dry the VPN (and every torrent behind it) silently dies.
// status() feeds the Downloads page; alertTick() puts a notice in the bell once
// when paid time crosses 7 and again at 3 days left, re-arming after a top-up.
// Expiry moves slowly, so readings are cached for 6 hours and the last good one
// is served through API hiccups. The account number lives only in the service env.
module.exports = function createMullvad({ account, alertFile, loadJSON, saveJSON, notifyLog, notifyClients,
  fetch = globalThis.fetch, now = Date.now }) {
  const number = String(account || '').replace(/\s+/g, '');
  let cache = { at: 0, data: null };
  let alertState = loadJSON(alertFile, { alertedAt: null });

  async function status() {
    if (!number) return { configured: false };
    if (now() - cache.at < 6 * 3600_000 && cache.data) return cache.data;
    try {
      // App API two-step: account number -> short-lived bearer -> account info.
      // (The old www/accounts/<number>/ endpoint returns ACCOUNT_NOT_FOUND now.)
      const tr = await fetch('https://api.mullvad.net/auth/v1/token', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_number: number }), signal: AbortSignal.timeout(10_000),
      });
      const tok = await tr.json();
      if (!tr.ok || !tok.access_token) throw new Error(tok.code || `auth HTTP ${tr.status}`);
      const ar = await fetch('https://api.mullvad.net/accounts/v1/accounts/me', {
        headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000),
      });
      const acct = await ar.json();
      if (!ar.ok || !acct.expiry) throw new Error(acct.code || `account HTTP ${ar.status}`);
      const daysLeft = Math.max(0, Math.floor((new Date(acct.expiry) - now()) / 86400_000));
      cache = { at: now(), data: { configured: true, expires: acct.expiry, daysLeft, active: daysLeft > 0 } };
      return cache.data;
    } catch (e) {
      // Serve the last good reading rather than flapping the UI.
      if (cache.data) return cache.data;
      return { configured: true, error: String(e.message || e) };
    }
  }

  async function alertTick() {
    const s = await status();
    if (!s.configured || s.daysLeft == null) return;
    if (s.daysLeft > 7) {
      // Topped up: re-arm both thresholds.
      if (alertState.alertedAt != null) { alertState = { alertedAt: null }; saveJSON(alertFile, alertState); }
      return;
    }
    const crossed = s.daysLeft <= 3 ? 3 : 7;
    if (alertState.alertedAt != null && alertState.alertedAt <= crossed) return; // already alerted this tier
    alertState = { alertedAt: crossed };
    saveJSON(alertFile, alertState);
    const when = s.expires ? new Date(s.expires).toLocaleDateString() : 'soon';
    notifyLog.push({
      type: 'vpn',
      title: crossed === 3 ? 'Mullvad about to expire' : 'Mullvad running low',
      body: `${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} of VPN time left (${when}) — top up or downloads stop.`,
      audience: 'download',
    });
    notifyClients('notifications-updated');
  }
  return { status, alertTick };
};
