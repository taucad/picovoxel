// Static server for the demo with COOP/COEP headers — the multi (pthreads)
// variant needs crossOriginIsolated, which plain `python3 -m http.server`
// can't provide. Serves the repo root: http://localhost:8918/demo/
//
//   node demo/serve.mjs          # or PORT=xxxx node demo/serve.mjs
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 8918);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
};

createServer(async (request, response) => {
  try {
    let path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (path.endsWith(sep) || path.endsWith('/')) path = join(path, 'index.html');
    const file = join(root, path);
    if (!file.startsWith(root)) throw new Error('path escapes root');
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
}).listen(port, () => {
  console.log(`pico demo (cross-origin isolated): http://localhost:${port}/demo/`);
});
