/**
 * Serve a prepared browser app and accept the captures it wrote.
 *
 * The fixture writes to the browser's sandboxed file system, which the gate cannot read, so the app
 * hands each file back over the origin that served it, untransformed on both sides.
 *
 * A capture may arrive in pieces, because a whole one does not fit beside itself in a wasm heap.
 * Each piece carries the byte it starts at, and every piece but the last says more follows. Offsets
 * must be contiguous from zero, and a finished capture cannot be written again.
 *
 * The app is served cross-origin isolated, and a name that is not a bare file name is refused.
 */
import { createServer } from 'node:http';
import { createWriteStream, readFileSync, statSync } from 'node:fs';
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
 * @returns {Promise<{ port: number, uploaded: string[], served: { requests: number, bytes: number },
 *   close: () => Promise<void> }>} The running server.
 */
export async function startCaptureServer({ app, captures }) {
  const root = resolve(app);
  const uploaded = [];
  /** How far each capture has been written, and whether its last piece has arrived. */
  const writing = new Map();
  // What a run actually had to fetch, counted where it crossed: a performance report reads this
  // rather than an engine's own estimate, which is not comparable between engines.
  const served = { requests: 0, bytes: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://parity.invalid');
    if (request.method === 'PUT' && url.pathname.startsWith('/capture/')) {
      const name = captureName(url.pathname);
      const offset = Number(request.headers['x-capture-offset'] ?? 0);
      const state = writing.get(name ?? '');
      const expected = state?.written ?? 0;
      // A capture is written once, from its start, in order: anything else is refused rather than
      // repaired, because the bytes on disk are what the gate compares.
      if (!name || !Number.isInteger(offset) || offset !== expected || state?.complete) {
        response.writeHead(400);
        response.end();
        return;
      }
      const complete = request.headers['x-capture-more'] === undefined;
      // Streamed to disk: the server never holds a whole capture either.
      const file = createWriteStream(join(captures, name), offset === 0 ? { flags: 'wx' } : { flags: 'a' });
      let length = 0;
      request.on('data', (chunk) => {
        length += chunk.byteLength;
      });
      request.pipe(file);
      file.on('error', () => {
        response.writeHead(409);
        response.end();
      });
      file.on('close', () => {
        if (response.writableEnded) return;
        writing.set(name, { written: offset + length, complete });
        if (complete) uploaded.push(name);
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
      const contents = readFileSync(path);
      served.requests += 1;
      served.bytes += contents.byteLength;
      response.end(contents);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    port: server.address().port,
    uploaded,
    served,
    close: () => new Promise((closed) => server.close(closed)),
  };
}
