# Lanes and provenance

picovoxel, an unofficial community TypeScript/WebAssembly binding of PicoGK, can run the offset family on two numeric paths: the upstream PicoGK default, and a faster first-order renormalization that changes the output. A **lane** is a session-level claim about which of those paths may run. Every geometry handle records which paths fed it (its **provenance**), and the export functions use that record to stamp or refuse the bytes they write.

## Choosing a lane

Pass `lane` to `createPico`. The session reports the resolved value on `session.lane`, never `'auto'`.

| `createPico({ lane })` | `session.lane` | `fastRenorm` default | Per-op `fastRenorm: true`   | Export consent for `fast` provenance |
| ---------------------- | -------------- | -------------------- | --------------------------- | ------------------------------------ |
| omitted                | `'open'`       | `false`              | allowed, taints the result  | none: each export must acknowledge   |
| `'exact'`              | `'exact'`      | `false`              | throws `PICO_LANE_LOOSENED` | not applicable (see below)           |
| `'fast'`               | `'fast'`       | `true`               | allowed                     | STL and `.vdb` export without asking |
| `'auto'`               | `'fast'`       | `true`               | allowed                     | same as `'fast'`                     |

```js
import { createPico } from 'picovoxel';

const pico = await createPico({ voxelSize: 0.5, lane: 'exact' });
pico.lane; // 'exact'
```

Precedence for `fastRenorm` is: an explicit per-op value, then the session's `fastRenorm` option, then the lane default. Tightening is always allowed: `fastRenorm: false` on an op, or `createPico({ lane: 'fast', fastRenorm: false })`, runs the upstream default path, and the session still reports `'fast'`. Loosening an exact session is not: `createPico({ lane: 'exact', fastRenorm: true })` throws `PICO_LANE_LOOSENED` at construction, and so does `fastRenorm: true` on `offset`, `doubleOffset`, `smoothen`, `fillet` or `shell` inside an exact session.

## What `'exact'` guarantees

The exact claim is path-defined: nothing in the session ran a value-changing acceleration, and nothing was imported that carries non-exact provenance. Every op takes the library default path, which is PicoGK's own computation. It is a statement about which code ran, not a tolerance.

To reproduce a reference result byte for byte, rebuild the model with the same `voxelSize` and `serialLattice` values in an exact session on the serial entry (`picovoxel`). The repository's pinned fixtures lock the default path on that entry. The `serialLattice` option chooses between two deterministic lattice renderers; both produce exact provenance, but their bytes differ, so a reproduction has to match it. The pthreads entry matched the serial one on every model the test suite compares; see [Threads and isolation](threads-and-isolation.md).

No function of a fast result recovers the exact one. To get exact bytes from fast geometry, replay the model in an exact session.

## What `'fast'` changes

`'fast'` turns `fastRenorm` on by default. It affects the offset family: `offset`, `doubleOffset`, `smoothen`, `fillet` and `shell`. After each offset step, the level set is renormalized with a first-order upwind gradient (OpenVDB `FIRST_BIAS`) instead of the fifth-order HJ-WENO scheme upstream uses, with the same number of renormalization sweeps.

The result is deterministic but different from the upstream path. Measured on 2026-07-26 on an Apple M2 Pro, over four offset fixtures at 0.5 mm voxels:

- the offsets ran 3.49 to 3.95 times faster;
- corrected volume moved by at most 2.14%, and signed distance by at most 0.36 mm;
- OpenVDB's `checkLevelSet` reported a clean level set on all four.

These are measured bounds for those fixtures, not a guarantee for every model. The test suite checks that a `fastRenorm` session gives the same grid hash on the serial and pthreads entries, with a healthy level set, for each op of the offset family (`test/multi.test.ts`).

## Provenance on handles

`Voxels`, `Mesh`, `ScalarField` and `VectorField` expose `.lane`, which is `'exact'` or `'fast'`:

- Fresh geometry is exact: every `createVoxels` shape, `createMesh`, lattice rendering, and empty fields.
- A `fastRenorm` op marks its result `fast`.
- A derived handle carries the union of its inputs' provenance. This covers `clone`, booleans with the fast operand in either position, further offsets, `toMesh`, mesh `transform` and `merged`, `toVoxels`, `shellVoxels`, `withMesh`, `toScalarField`, and `createScalarField`/`createVectorField` with `from`.
- Loaded geometry takes the provenance recorded in its bytes (see the next section).

`Lattice`, `PolyLine` and `VdbFile` carry no provenance. Passing one where geometry is expected throws `PICO_INVALID_ARGUMENT` before any native call.

### The persisted form

On voxel and field grids, provenance is stored as a string metadata entry named `PicoVoxel.Lane`, so it survives copies, containers and `.vdb` files. The value is a set of members in a fixed grammar:

- members are comma-separated, sorted, deduplicated, with no spaces, and each matches `[a-z0-9][a-z0-9-]*`;
- `fast` is the only member picovoxel writes, and `exact` is dropped as the empty set;
- an exact grid carries no entry at all, so exact bytes never change;
- a token outside the grammar, or an entry that is not a string, reads as the reserved member `unknown`.

The public `.lane` collapses the set: empty means `'exact'`, and any member, known or not, means `'fast'`. Unknown members are kept and carried through derivations, never rewritten to `fast`, and a load never rewrites the entry. User code cannot set or remove `PicoVoxel.*` names; `metadata.set('PicoVoxel.Lane', …)` throws `PICO_RESERVED_METADATA`. Meshes have no native metadata slot, so mesh provenance lives in the wrapper and in the STL header.

## The export boundary

| Export                                               | Exact provenance                               | `fast` in a `'fast'` or `'auto'` session | `fast` in an `'open'` session                       | Any other member, any session          |
| ---------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| `mesh.toStl()`                                       | historical header                              | exports, header stamped `LANE=fast`      | `PICO_LANE_EXPORT` unless `acceptLane: 'fast'`      | `PICO_LANE_EXPORT` unless `acceptLane` |
| `vdb.toBytes()`                                      | untagged fields                                | exports; field entries carry the set     | `PICO_LANE_EXPORT` unless `acceptLane: 'fast'`      | `PICO_LANE_EXPORT` unless `acceptLane` |
| `mesh.toGlb()`                                       | exports                                        | `PICO_LANE_EXPORT` unless `acceptLane`   | `PICO_LANE_EXPORT` unless `acceptLane`              | `PICO_LANE_EXPORT` unless `acceptLane` |
| `meshToStlBytes(vertices, triangles, options, lane)` | `lane` omitted or `'exact'`: historical header | no session                               | `lane: 'fast'`: refuses unless `acceptLane: 'fast'` | not applicable                         |

An acknowledged STL or `.vdb` export still records the full set. An exact session cannot hold non-exact handles, so only the first column applies there.

- **STL.** A stamped 80-byte header reads, for example, `PicoGK UNITS=mm LANE=fast`, padded with spaces. A set too long to fit stamps `LANE=unknown`. On read, the token must be delimited by whitespace or NUL and start with a case-exact `LANE=`; the first one wins, and a header without one is exact. So `PLANE=FASTENED` and `lane=fast` read as exact, and `LANE=FAST` reads as `unknown`.
- **`.vdb`.** The boundary checks only fields added with `vdb.add()` in this container. Fields that arrived with `openVdb(bytes)` pass through byte for byte, tagged or untagged, in every session.
- **GLB.** picovoxel's GLB writer has no slot for provenance, so fast geometry refuses in every session, including `'fast'`. An acknowledged GLB records nothing. Export STL when the record matters.
- **`meshToStlBytes`.** This free function has no session, so it behaves like an `'open'` session.

The stamp is an audit record, not a security boundary: other tools rewrite STL headers. Some paths are not export boundaries at all. The mesh `vertices` and `triangles` getters and the `picovoxel/three` bridge neither refuse nor stamp, and `meshFromBufferGeometry` creates exact meshes.

## Slicing stamps

`sliceVoxels` copies `voxels.lane` onto the stack and every slice. Manufacturing output is stamped and never refused:

- `slicesToCli` writes `// PicoVoxel LANE=fast //` as the last line before `$$HEADEREND` when the stack or any slice is fast. That line is a remark in the Common Layer Interface v2.0 syntax, and upstream PicoGK's reader skips it.
- `slicesFromCli` restores `lane` from remark lines inside the header only, with the same token rule as STL. A member other than `fast` reads as `'fast'`.
- `sliceToSvg` writes `<metadata>PicoVoxel LANE=fast</metadata>` before the `<g>` element of a fast slice.

Exact stacks and slices produce the same bytes as they would without a `lane` field. The CLI and SVG stamps always read `LANE=fast`; they carry the collapsed lane, not the member set.

## Importing into an exact session

An exact session refuses assets that carry non-exact provenance. `voxelsFromVdb`, `VdbFile.getVoxels`, `getScalarField`, `getVectorField` and `meshFromStl` throw `PICO_LANE_LOOSENED`, free the refused handle, and offer no override. Load the asset in an `'open'` or `'fast'` session instead.

Untagged assets and headers without a `LANE=` token load as exact: importing is not an acceleration. `openVdb` itself does not check, so re-serializing opened bytes works in any session. `slicesFromCli` has no session and applies no lock.

## Errors

| Code                     | Raised when                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `PICO_LANE_LOOSENED`     | an exact session is asked for `fastRenorm: true` (at construction or on an op), or imports an asset with non-exact provenance |
| `PICO_LANE_EXPORT`       | an STL, `.vdb` or GLB export meets provenance that nothing consented to; the message names the remedies that apply            |
| `PICO_RESERVED_METADATA` | user code writes or removes a `PicoVoxel.*` metadata name                                                                     |

```js
import { createPico, PicoError } from 'picovoxel';

const pico = await createPico({ voxelSize: 0.5 }); // 'open'
const part = pico.createVoxels({ shape: 'sphere', radius: 10 }).offset({ distance: 1, fastRenorm: true });
let stl;
try {
  stl = part.toMesh().toStl();
} catch (error) {
  if (!(error instanceof PicoError && error.code === 'PICO_LANE_EXPORT')) throw error;
  stl = part.toMesh().toStl({ acceptLane: 'fast' }); // the header records LANE=fast
}
```

## See also

- [Threads and isolation](threads-and-isolation.md)
- [Memory and limits](memory-and-limits.md)
- [README](../README.md)
