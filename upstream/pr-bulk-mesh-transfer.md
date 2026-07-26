# [DRAFT PR] Add bulk mesh transfer to the C ABI: Mesh_GetVertices/GetTriangles/AddVertices/AddTriangles

**Repo**: leap71/PicoGKRuntime · **Adds to**: `Source/PicoGKLibrary.cpp` + `API/PicoGK.h`

**Patch**: `upstream/picogkruntime-bulk-mesh-abi.patch` — the C ABI half as an
applyable diff against a pristine PicoGKRuntime `0f26321c` tree (`patch -p1`,
dry-run clean). The C# binding half below targets **leap71/PicoGK**, a different
repo, and stays as description. Ledger row: `MIGRATING-FROM-CSHARP.md` U4.
The sibling entry points for lattice authoring are U17 /
`upstream/picogkruntime-bulk-lattice-abi.patch`.

## Why

The C ABI moves mesh data one element per call (`Mesh_GetVertex`,
`Mesh_nAddVertex`, …). Reading a 174k-vertex mesh costs ~522k ABI crossings; on
managed/wasm hosts the crossing dominates everything else. Measured in the
picovoxel WebAssembly port: bulk transfer turns 522k crossings into 2 and is
~150× faster on readback; the same pattern serves C#, Python, and any other
binding.

## What

Four exports mirroring the existing caller-supplied-buffer convention
(`Voxels_GetZSlice`):

```c
PICOGK_API int32_t Mesh_GetVertices (PKINSTANCE, PKMESH, PKVector3*  pvecBuffer, int32_t nBufferCount); // returns count written (clamped)
PICOGK_API int32_t Mesh_GetTriangles(PKINSTANCE, PKMESH, PKTriangle* psBuffer,   int32_t nBufferCount);
PICOGK_API int32_t Mesh_AddVertices (PKINSTANCE, PKMESH, const PKVector3*  pvecBuffer, int32_t nCount); // returns first index, -1 on bad input
PICOGK_API int32_t Mesh_AddTriangles(PKINSTANCE, PKMESH, const PKTriangle* psBuffer,   int32_t nCount);
```

Implementation notes (working code in the picovoxel repo, `src/pico-bulk.cpp`):

- Reads `std::copy` out of `Mesh::vVertices()/vTriangles()` — both are 12-byte
  `#pragma pack(1)` types layout-identical to `PKVector3`/`PKTriangle`.
  (`Vector3` has a user-provided copy constructor, so `std::copy`, not `memcpy` —
  clang lowers it to the same vectorised move at -O3.)
- Writes route through `Mesh::nAddVertex/nAddTriangle` per element so the
  bounding-box and memory bookkeeping stay correct — the win was never the loop,
  it was not crossing the ABI 100k times.
- Null/empty inputs return 0 (reads) / -1 (writes) without touching the mesh.

Differentially tested byte-identical against the per-element path (100k-vertex
FNV-1a comparison) in the picovoxel suite.

## The C# binding half (leap71/PicoGK — separate repo, described not diffed)

The runtime patch is useless to C# until the binding stops looping. Reviewed at
`leap71/PicoGK` @ `389d4d9`; the change is mechanical:

- `Internals/Interop.cs` — four new `[DllImport]` entries beside the existing
  `Mesh_nAddVertex` / `Mesh_GetVertex` / `Mesh_nAddTriangle` / `Mesh_GetTriangle`
  ones (`:146-175`), with `Vector3[]` / `Triangle[]` array parameters. Both
  structs are already blittable `#pragma pack(1)`-equivalent layouts, so the
  marshaller pins rather than copies.
- `Base/Mesh.cs` — `AddVertices(IEnumerable<Vector3>, out int[])` (`:158-170`)
  currently calls `nAddVertex` once per vertex; it becomes one
  `_AddVertices(…, array, count)` plus a `Range`-fill of the returned index
  array, since the appended indices are contiguous by construction.
- `Base/Mesh.cs` — add the bulk readers the class currently lacks
  (`Vector3[] avecVertices()` / `Triangle[] atTriangles()`), sized from
  `nVertexCount()` / `nTriangleCount()`. Everything that today walks
  `vecVertexAt` / `oTriangleAt` in a loop — `mshCreateTransformed`,
  `mshCreateMirrored`, the STL writer, `MeshUtility` — becomes one call plus a
  managed loop with no P/Invoke in it.
- The per-element entry points stay; nothing is removed and no existing
  signature changes, so this is additive for every downstream consumer.

The same split applies to the sibling lattice patch (ledger U17,
`upstream/picogkruntime-bulk-lattice-abi.patch`): `Lattice.AddBeam` /
`AddSphere` accumulate into a flat `float[]` and flush once, at the first call
that can observe the lattice.
