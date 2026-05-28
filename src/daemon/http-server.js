/**
 * HTTP server on 127.0.0.1:7777 (configurable).
 *
 * Routes:
 *   GET  /                 → SPA shell (index.html)
 *   GET  /static/*         → static assets (css/js/svg)
 *   GET  /healthz          → no-auth health check
 *   GET  /api/v1/methods   → list registered RPC methods
 *   POST /api/v1/rpc       → JSON-RPC dispatch (auth required)
 *
 * Auth:
 *   Token in cookie  `sigil_gui=<hex>`  (set by ?t=<hex> on first load)
 *   OR Authorization header `Bearer <hex>`
 *
 * Bind: loopback only (127.0.0.1). Never exposed to LAN.
 */
import { createServer } from 'node:http';
import { existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';

import { GUI_WEB_DIR_BUILT, GUI_WEB_DIR_DEV } from '../lib/paths.js';
import { getGuiToken, isValidToken } from './gui-token.js';
import bus from './events.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

function resolveWebDir() {
  if (existsSync(GUI_WEB_DIR_BUILT)) return GUI_WEB_DIR_BUILT;  // future minified build
  if (existsSync(GUI_WEB_DIR_DEV)) return GUI_WEB_DIR_DEV;      // dev / npm-installed source
  return null;
}

export async function startHttpServer({ registry, log, config }) {
  const webDir = resolveWebDir();
  const token = await getGuiToken();

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, { registry, webDir, log });
    } catch (err) {
      log(`http route error: ${err.message}`);
      writeJson(res, 500, { ok: false, error: { code: 'internal', message: err.message } });
    }
  });

  // WebSocket upgrade for /api/v1/events
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname !== '/api/v1/events') {
      socket.destroy();
      return;
    }
    // Token via Authorization header, cookie, or ?t=<token>
    const wsAuth = (await checkAuth(req)) || (u.searchParams.get('t') && await isValidToken(u.searchParams.get('t')));
    if (!wsAuth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Replay recent buffer first so a freshly-opened tab sees history
      for (const evt of bus.recent(50)) {
        try { ws.send(JSON.stringify(evt)); } catch { /* socket dead */ }
      }
      // PR review #20: backpressure. If a slow tab lets bufferedAmount
      // grow past this watermark, drop further events for that socket
      // rather than letting the WebSocket library buffer indefinitely.
      // 256 KB ≈ 200+ activity events at typical payload size.
      const BP_HIGH_WATER = 256 * 1024;
      let droppedSinceLastSent = 0;
      const unsub = bus.subscribe((evt) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > BP_HIGH_WATER) {
          droppedSinceLastSent++;
          return;
        }
        try {
          if (droppedSinceLastSent > 0) {
            ws.send(JSON.stringify({ type: 'meta.dropped', ts: new Date().toISOString(), count: droppedSinceLastSent }));
            droppedSinceLastSent = 0;
          }
          ws.send(JSON.stringify(evt));
        } catch { /* ignore */ }
      });
      ws.on('close', unsub);
      ws.on('error', () => unsub());
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const url = `http://${config.http.host}:${config.http.port}/?t=${token}`;
  log(`http listening on ${config.http.host}:${config.http.port}`);
  log(`gui url (paste into browser): ${url}`);

  return {
    url,
    close: () => new Promise((resolve) => {
      wss.close();
      server.close(() => resolve());
    }),
  };
}

async function route(req, res, { registry, webDir, log }) {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  // Unauth: health
  if (req.method === 'GET' && path === '/healthz') {
    return writeJson(res, 200, { ok: true, ts: new Date().toISOString() });
  }

  // Unauth-ish: index can be served with ?t=<token> to bootstrap the cookie.
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    return serveIndex(req, res, u, webDir, log);
  }

  // Unauth: static — these are not sensitive (just JS/CSS/SVG).
  if (req.method === 'GET' && path.startsWith('/static/')) {
    return serveStatic(req, res, path.replace('/static/', ''), webDir);
  }

  // Auth required from here.
  const authed = await checkAuth(req);
  if (!authed) {
    return writeJson(res, 401, { ok: false, error: { code: 'auth', message: 'unauthorized' } });
  }

  if (req.method === 'GET' && path === '/api/v1/methods') {
    return writeJson(res, 200, { ok: true, data: { methods: registry.list() } });
  }

  if (req.method === 'POST' && path === '/api/v1/rpc') {
    const body = await readJsonBody(req);
    if (!body || typeof body.method !== 'string') {
      return writeJson(res, 400, { ok: false, error: { code: 'invalid_request', message: 'expected {method, params}' } });
    }
    const result = await registry.dispatch(body.method, body.params, { transport: 'http' });
    return writeJson(res, 200, result);
  }

  writeJson(res, 404, { ok: false, error: { code: 'not_found', message: `${req.method} ${path}` } });
}

async function serveIndex(req, res, url, webDir, log) {
  // Bootstrap: ?t=<token> sets a session cookie and redirects (so the
  // token doesn't stay in the URL bar / browser history).
  const tParam = url.searchParams.get('t');
  if (tParam) {
    if (await isValidToken(tParam)) {
      res.statusCode = 302;
      res.setHeader('Location', '/');
      res.setHeader('Set-Cookie', `sigil_gui=${tParam}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      return res.end();
    }
    return writeJson(res, 401, { ok: false, error: { code: 'auth', message: 'invalid token' } });
  }

  if (!webDir) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(FALLBACK_INDEX);
  }
  const indexPath = join(webDir, 'index.html');
  if (!existsSync(indexPath)) {
    log(`http: index.html missing under ${webDir}`);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(FALLBACK_INDEX);
  }
  return streamFile(res, indexPath);
}

async function serveStatic(req, res, sub, webDir) {
  if (!webDir) return writeJson(res, 404, { ok: false, error: { code: 'not_found', message: 'no web dir' } });
  // Prevent path-traversal: normalize the resolved path, then check it
  // starts with the normalized webDir + a separator. Using path.sep
  // explicitly avoids the prior bug where '/foo/' → normalize → '/foo',
  // so a candidate of '/foobar/secret' passed startsWith('/foo'). PR review #6.
  const candidate = normalize(join(webDir, sub));
  const root = normalize(webDir) + sep;
  if (!candidate.startsWith(root)) {
    return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'path traversal blocked' } });
  }
  if (!existsSync(candidate)) {
    return writeJson(res, 404, { ok: false, error: { code: 'not_found', message: sub } });
  }
  return streamFile(res, candidate);
}

async function streamFile(res, file) {
  const st = await stat(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(file).pipe(res);
}

async function checkAuth(req) {
  // Authorization: Bearer <token>
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) {
    if (await isValidToken(auth.replace(/^Bearer\s+/i, '').trim())) return true;
  }
  // Cookie: sigil_gui=<token>
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/(?:^|;\s*)sigil_gui=([0-9a-f]+)/i);
  if (m && (await isValidToken(m[1]))) return true;
  return false;
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0; // PR review #9: incremental size check instead of O(n²) reduce
  for await (const c of req) {
    chunks.push(c);
    total += c.length;
    if (total > 1_000_000) {
      throw new Error('request body too large (>1MB)');
    }
  }
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
}

function writeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

// Tiny fallback page served when the SPA isn't built — keeps the daemon
// useful (status + token are visible) even before any web build.
const FALLBACK_INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sigil</title>
<style>body{font:14px/1.6 system-ui, sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#1a1a1a}h1{font-size:18px;margin-bottom:8px}code{background:#f3f3f3;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Sigil daemon is running</h1>
<p>The GUI has not been built yet. The daemon is reachable on this port and
authentication works — paste the URL printed in <code>sigil daemon logs</code>
into your browser to set the auth cookie.</p>
<p>You can also drive it from your terminal:</p>
<pre>curl -H "Authorization: Bearer $(cat ~/.sigil/gui.token)" \\
     -X POST http://localhost:7777/api/v1/rpc \\
     -d '{"method":"ping"}' \\
     -H "Content-Type: application/json"</pre>
</body></html>`;
