// Shared Express middleware: gzip JSON, security headers, HLS request log.
const zlib = require('zlib');

// Auto-gzip res.json() bodies over 1 KiB when the client sent Accept-Encoding: gzip.
function gzipJson(_req, res, next) {
  const ae = _req.headers['accept-encoding'] || '';
  if (!ae.includes('gzip')) return next();
  const origJson = res.json.bind(res);
  res.json = function (data) {
    const body = JSON.stringify(data);
    if (body.length < 1024) return origJson(data);
    zlib.gzip(Buffer.from(body), { level: 1 }, (err, compressed) => {
      if (err) return origJson(data);
      res.set('Content-Encoding', 'gzip');
      res.set('Content-Type', 'application/json');
      res.end(compressed);
    });
  };
  next();
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'");
  next();
}

function hlsRequestLog(req, _res, next) {
  if (req.path.startsWith('/hls')) console.log(`[HLS-REQ] ${req.method} ${req.originalUrl}`);
  next();
}

module.exports = { gzipJson, securityHeaders, hlsRequestLog };
