# [DRAFT PR] Add bulk mesh transfer to the C ABI: Mesh_GetVertices/GetTriangles/AddVertices/AddTriangles

**Repo**: leap71/PicoGKRuntime · **Adds to**: `Source/PicoGKLibrary.cpp` (or a new TU) + `API/PicoGK.h`

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
