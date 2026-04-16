// Server-Sent Events fan-out. Factory module.
module.exports = function createSse({ maxClients, heartbeatMs }) {
  let clients = [];

  function handler(_req, res) {
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
    clients.push(res);
    _req.on('close', () => { clearInterval(heartbeat); clients = clients.filter(c => c !== res); });
  }

  function notify(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
    clients.forEach(c => { try { c.write(msg); } catch {} });
  }

  return { handler, notify, count: () => clients.length };
};
