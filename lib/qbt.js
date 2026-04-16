// qBittorrent Web API client. Factory module.
const http = require('http');
const https = require('https');

module.exports = function createQbt({ QBT_BASE, QBT_USERNAME, QBT_PASSWORD }) {
  let qbtCookie = '';

  function qbtRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(QBT_BASE + apiPath);
      const opts = {
        hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        method, headers: { Cookie: `SID=${qbtCookie}` },
      };
      if (body) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.headers['Content-Length'] = Buffer.byteLength(body);
      }
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function qbtAuth() {
    const body = `username=${encodeURIComponent(QBT_USERNAME)}&password=${encodeURIComponent(QBT_PASSWORD)}`;
    const r = await qbtRequest('POST', '/api/v2/auth/login', body);
    if (r.headers['set-cookie']) {
      const m = r.headers['set-cookie'].toString().match(/SID=([^;]+)/);
      if (m) qbtCookie = m[1];
    }
    return r.data === 'Ok.';
  }

  async function qbt(method, apiPath, body) {
    let r = await qbtRequest(method, apiPath, body);
    if (r.status === 403) {
      await qbtAuth();
      r = await qbtRequest(method, apiPath, body);
    }
    return r;
  }

  function qbtJson(r) { try { return JSON.parse(r.data); } catch { return r.data; } }

  function requireQbt(_req, res, next) {
    if (!QBT_USERNAME || !QBT_PASSWORD) return res.status(503).json({ error: 'qBittorrent not configured. Set QBT_USER and QBT_PASS env vars.' });
    next();
  }

  return { qbt, qbtAuth, qbtJson, requireQbt };
};
