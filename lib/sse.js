// Server-Sent Events fan-out. Factory module. Each stream remembers the profile
// that opened it (requireAuth runs first), so present() can say who has a page open.
module.exports = function createSse({ maxClients, heartbeatMs }) {
  let clients = [];

  function handler(req, res) {
    if (clients.length >= maxClients) return res.status(503).send('Too many connections');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: connected\n\n');
    const heartbeat = setInterval(() => {
      try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, heartbeatMs);
    const client = { res, profileId: req.session?.profileId || null };
    clients.push(client);
    req.on('close', () => { clearInterval(heartbeat); clients = clients.filter(c => c !== client); });
  }

  function notify(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
    clients.forEach(c => { try { c.res.write(msg); } catch {} });
  }

  // profileId -> open streams (one per tab or device).
  function present() {
    const counts = {};
    for (const c of clients) if (c.profileId) counts[c.profileId] = (counts[c.profileId] || 0) + 1;
    return counts;
  }

  return { handler, notify, present, count: () => clients.length };
};
