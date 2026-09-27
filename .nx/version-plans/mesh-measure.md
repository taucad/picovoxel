---
picovoxel: minor
---

`Mesh.measure()` returns a mesh's enclosed volume and surface area, integrated over its triangles with no voxels involved. The area is the sum ShapeKernel's `Measure.fGetSurfaceArea(Mesh)` computes; the volume is new. Use `voxels.toMesh().measure()` to cross-check `Voxels.properties()`, which fills a sealed cavity, or one whose openings are about two voxels wide or narrower, as PicoGK's `CalculateProperties` does; [memory and limits](https://github.com/taucad/picovoxel/blob/main/docs/memory-and-limits.md#known-limits) describes the limitation.
