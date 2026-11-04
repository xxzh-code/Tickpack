// Tickpack static dev server — zero dependencies.
// Serves the workspace: / -> web/index.html, /src/**, /web/**, /docs/**, /shots/**
// Usage: node server.mjs [port]   (default 8123, or env TICKPACK_PORT; PORT kept as fallback)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mcfunction': 'text/plain; charset=utf-8',
  '.tp': 'text/plain; charset=utf-8',
  '.tpk': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

const MISSING_UI = `<!doctype html><meta charset="utf-8">
<body style="font:16px/1.6 ui-monospace,Consolas,monospace;background:#14161a;color:#c9d1d9;padding:48px">
<h1 style="color:#f6d33c">Tickpack</h1>
<p>web/index.html is not there yet — the UI is still being built.</p>
<p>Static server is fine; files appear as soon as they exist.</p>
</body>`;

function resolveUrlPath(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (p === '/' || p === '') p = '/web/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const abs = resolve(ROOT, '.' + p);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null; // traversal guard
  return abs;
}

/**
 * Start the static dev server.
 * @param {{port?: number, host?: string}} [opts]
 * @returns {import('node:http').Server}
 */
export function startServer({ port, host = '127.0.0.1' } = {}) {
  const listenPort = Number(port || process.env.TICKPACK_PORT || process.env.PORT || 8123);
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const file = resolveUrlPath(req.url || '/');
    const failed = (code, msg) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(msg);
      console.log(`${code} ${req.method} ${req.url} (${Date.now() - started}ms)`);
    };
    if (!file) return failed(403, 'forbidden');
    try {
      const st = await stat(file);
      if (!st.isFile()) return failed(404, 'not found');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      if (!/\.(png|jpg|svg|woff2|ico|webp|gif)$/i.test(file)) {
        console.log(`200 ${req.method} ${req.url} (${body.length}b, ${Date.now() - started}ms)`);
      }
    } catch {
      if (file.endsWith(`${sep}web${sep}index.html`)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(MISSING_UI);
      }
      failed(404, 'not found');
    }
  });

  server.listen(listenPort, host, () => {
    console.log(`Tickpack dev server: http://${host}:${listenPort}/  (root: ${ROOT})`);
  });
  return server;
}

// Auto-start only when executed directly (`node server.mjs`), not when imported
// by the CLI or tests.
const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startServer({ port: process.argv[2] });
}
