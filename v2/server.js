// TV-Clone v2 server.
// Serves the built Svelte editorial UI and proxies every backend call to the
// existing v1 server. This keeps v2's frontend on the SAME ORIGIN as the API
// it talks to, so v1's httpOnly / sameSite=strict session cookies just work,
// and not one line of the proven v1 backend (transcoding, organizer, library)
// has to change.
const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = parseInt(process.env.V2_PORT, 10) || 4802;
// Default to v1 dev (4801). Point at prod (4800) by setting V2_BACKEND.
const BACKEND = process.env.V2_BACKEND || 'http://127.0.0.1:4801';
const DIST = path.join(__dirname, 'frontend', 'dist');

const app = express();

// Everything the backend owns is proxied through untouched. Mounting with
// app.use('/api', ...) would strip the mount path, so match on a single
// middleware that inspects the full URL and only proxies backend routes —
// preserving the complete path (/api/health stays /api/health).
const BACKEND_RE = /^\/(api|stream|hls|hls\.min\.js|omdb-poster|poster|backdrop|sprite|subtitle)(\/|$|\?)/;
const proxy = createProxyMiddleware({
  target: BACKEND,
  changeOrigin: true,
  ws: false,
  xfwd: true,
  // SSE: don't let the proxy buffer the event stream.
  on: {
    proxyReq: (proxyReq, req) => {
      if (process.env.V2_DEBUG) console.log('[proxy] %s -> %s', req.url, proxyReq.path);
      if (req.url.startsWith('/api/events')) proxyReq.setHeader('Accept', 'text/event-stream');
    },
  },
});
app.use((req, res, next) => {
  if (BACKEND_RE.test(req.url)) return proxy(req, res, next);
  next();
});

// Static built UI.
app.use(express.static(DIST, { index: false, maxAge: '1h' }));

// SPA fallback: any non-asset route returns index.html so client routing works.
app.get('*', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(DIST, 'index.html'), (err) => {
    if (err) res.status(503).send('v2 UI not built yet — run: npm run build');
  });
});

app.listen(PORT, () => {
  console.log(`\n  TV-Clone v2 — editorial UI`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Backend: ${BACKEND} (proxied)\n`);
});
