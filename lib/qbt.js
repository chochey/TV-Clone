// qBittorrent Web API client. Factory module.
const http = require('http');
const https = require('https');

module.exports = function createQbt({ QBT_BASE, QBT_USERNAME, QBT_PASSWORD, timeoutMs = 15000 }) {
  // Session cookie as qBittorrent named it: SID up to 5.1, QBT_SID_<port> from 5.2.
  let qbtCookie = '';

  function qbtRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(QBT_BASE + apiPath);
      const opts = {
        hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        method, headers: qbtCookie ? { Cookie: qbtCookie } : {},
      };
      if (body) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.headers['Content-Length'] = Buffer.byteLength(body);
      }
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('aborted', () => reject(new Error('Downloader disconnected during the request.')));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      });
      const deadline = setTimeout(() => req.destroy(new Error('Downloader timed out. Please try again.')), timeoutMs);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function qbtAuth() {
    const body = `username=${encodeURIComponent(QBT_USERNAME)}&password=${encodeURIComponent(QBT_PASSWORD)}`;
    const r = await qbtRequest('POST', '/api/v2/auth/login', body);
    const cookies = [].concat(r.headers['set-cookie'] || []).map(c => c.split(';')[0].trim());
    const session = cookies.find(c => /^(?:QBT_)?SID(?:_\w+)?=./.test(c));
    if (session) qbtCookie = session;
    // 'Ok.' up to 5.1; 5.2+ answers 204 with no body. qBittorrent sets a session cookie only on success.
    return r.data === 'Ok.' || (!!session && r.status >= 200 && r.status < 300 && r.data !== 'Fails.');
  }

  async function qbt(method, apiPath, body) {
    let r = await qbtRequest(method, apiPath, body);
    if (r.status === 403) {
      if (!await qbtAuth()) throw new Error('Downloader authentication failed.');
      r = await qbtRequest(method, apiPath, body);
    }
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Downloader request failed (HTTP ${r.status}). Please try again.`);
    }
    return r;
  }

  function qbtJson(r) { try { return JSON.parse(r.data); } catch { throw new Error('Downloader returned an invalid response.'); } }

  function requireQbt(_req, res, next) {
    if (!QBT_USERNAME || !QBT_PASSWORD) return res.status(503).json({ error: 'qBittorrent not configured. Set QBT_USER and QBT_PASS env vars.' });
    next();
  }

  return { qbt, qbtAuth, qbtJson, requireQbt };
};
