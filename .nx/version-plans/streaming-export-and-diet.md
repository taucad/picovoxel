---
picovoxel: minor
---

Streamed export: `voxels.streamStl(write)` meshes a grid in batches of 128³-voxel nodes and hands each batch's binary STL records to `write`, so neither the mesh nor the file is ever held whole; the chunks are the bytes `toMesh().toStl()` returns. `voxels.streamMesh(onChunk)` streams the same mesh as indexed batches, and `mesh.streamStl(write)` streams an existing mesh. `{ includeHeader: true }` makes the chunks a complete file in order, for append-only sinks.

Intermediates can be freed as a build goes: the boolean and offset families take `{ consume: true }`, which disposes the receiver as part of the call (an offset then reuses its grid instead of copying it), and `pico.scope(build)` disposes everything `build` created except what it returns. Disposing is now documented as required for large work inside one task, and the HelixHeatX example frees every intermediate at its last use.

`toStl()`, `mesh.vertices` and `mesh.triangles` no longer stage a copy of the mesh in the heap, and `voxels.gridHash()` no longer copies the grid. Output bytes are unchanged.

New raw exports: `Mesh_pVertexData`, `Mesh_pTriangleData`, `Mesh_GetStlRecords`, the `MeshStream_*` slab mesher, and `Voxels_GetGridHashCopy`, the copy-based grid hash kept as the streamed hash's oracle.
