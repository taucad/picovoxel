// Far store — the internal module (D4): byte images outside the wasm heap for a
// kernel's scratch working memory. No picovoxel types cross this boundary, so a
// later split into a shared kernel-host utility is a move, not a rewrite.

import {
  createFileBackend,
  nodeProcess,
  openNodeScratchFile,
  openOpfsScratchFile,
  probeOpfs,
} from './disk.ts';
import { createRamBackend } from './ram.ts';
import { createExtentStore, FarStoreError, type FarStore } from './store.ts';

export { FarStoreError, createExtentStore } from './store.ts';
export type { FarStore } from './store.ts';
export { createRamBackend, resizableArrayBuffersAvailable } from './ram.ts';
export { createFileBackend, probeOpfs } from './disk.ts';
export type { SyncFile } from './disk.ts';

export interface OpenFarStoreOptions {
  /** `'ram'`: JS memory segments. `'disk'`: a scratch file (Node `fs`, or OPFS in a dedicated worker). */
  kind: 'ram' | 'disk';
  /** Size bound in bytes (default unbounded for RAM, 16 GiB for disk). */
  maxBytes?: number;
  /** Disk only: the scratch directory (a path in Node, a directory name in OPFS). */
  directory?: string;
}

/**
 * Opens a far store. A disk store in a browser needs OPFS sync handles that
 * the probe finds disk-backed; anything else rejects with kind `'io'` rather
 * than falling back silently.
 */
export async function openFarStore(options: OpenFarStoreOptions): Promise<FarStore> {
  if (options.kind === 'ram') return createExtentStore(createRamBackend(), { maxBytes: options.maxBytes });
  const maxBytes = options.maxBytes ?? 16 * 2 ** 30;
  if (nodeProcess())
    return createExtentStore(createFileBackend(openNodeScratchFile(options.directory)), { maxBytes });
  if (!(await probeOpfs(options.directory))) {
    throw new FarStoreError(
      'io',
      'far store: no disk-backed scratch here — OPFS needs a dedicated worker in a persistent (non-incognito) context',
    );
  }
  return createExtentStore(createFileBackend(await openOpfsScratchFile(options.directory)), { maxBytes });
}
