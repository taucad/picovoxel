/**
 * Serve a prepared browser app and accept the captures it wrote.
 *
 * The fixture writes its geometry to the browser's sandboxed file system, which the gate cannot
 * read, so the app hands each file back over the origin it was served from: `PUT capture/<name>`
 * with the file's bytes. Nothing is transformed on either side, so a capture that reaches disk is
 * what the engine produced.
 *
 * The app is served with cross-origin isolation, which `SharedArrayBuffer` and so the threaded host
 * require, and a name that is not a bare file name is refused rather than resolved.
 */
import { createServer } from 'node:http';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.dat': 'application/octet-stream',
  '.blat': 'application/octet-stream',
  '.pdb': 'application/octet-stream',
  '.dll': 'application/octet-stream',
};

/**
 * A bare file name, or nothing.
 *
 * @param {string} pathname - The request path under `/capture/`.
 * @returns {string | undefined} The file name to write, if the request named one.
 */
export function captureName(pathname) {
  let name;
  try {
    name = decodeURIComponent(pathname.replace(/^\/capture\//u, ''));
  } catch {
    return undefined;
  }
  return name && name === normalize(name) && !name.includes('/') && !name.startsWith('.') ? name : undefined;
}

/**
 * Start the server the run is driven through.
 *
 * @param {{ app: string, captures: string }} directories - The prepared app, and where captures land.
 * @returns {Promise<{ port: number, uploaded: string[], close: () => Promise<void> }>} The running server.
 */
export async function startCaptureServer({ app, captures }) {
  const root = resolve(app);
  const uploaded = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://parity.invalid');
    if (request.method === 'PUT' && url.pathname.startsWith('/capture/')) {
      const name = captureName(url.pathname);
      if (!name) {
        response.writeHead(400);
        response.end();
        return;
      }
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        // Exclusive: a second upload of one capture would overwrite the bytes being gated.
        writeFileSync(join(captures, name), Buffer.concat(chunks), { flag: 'wx' });
        uploaded.push(name);
        response.writeHead(204);
        response.end();
      });
      return;
    }
    try {
      const requested = join(root, decodeURIComponent(url.pathname));
      const path = resolve(
        requested.endsWith('/') || statSync(requested).isDirectory()
          ? join(requested, 'index.html')
          : requested,
      );
      if (path !== root && !path.startsWith(`${root}/`)) throw new Error('A request reached outside the app');
      response.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end(readFileSync(path));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    port: server.address().port,
    uploaded,
    close: () => new Promise((closed) => server.close(closed)),
  };
}
