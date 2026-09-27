---
picovoxel: minor
---

`Mesh.measure()` returns a mesh's enclosed volume and surface area, integrated over its triangles with no voxels involved. Use `voxels.toMesh().measure()` to cross-check `Voxels.properties()`, which fills a sealed cavity, or one whose openings are about two voxels wide or narrower, as PicoGK's `CalculateProperties` does; `docs/memory-and-limits.md` describes the limitation.
