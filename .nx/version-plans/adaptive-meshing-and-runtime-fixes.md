---
picovoxel: minor
---

`voxels.toMesh({ adaptivity, relax })` meshes adaptively through OpenVDB: `adaptivity` in [0, 1) merges near-coplanar cells into fewer triangles, `relax` runs OpenVDB's relax pass on them, and both default off, so `toMesh()` writes the same bytes as before. An adaptive mesh is `fast`, and an exact-lane session refuses it.

The offset family (`offset`, `doubleOffset`, `smoothen`, `fillet`, `shell`) takes an opt-in `fastSweeping: true`, a fast-sweeping offset engine whose result is `fast`; a fillet through it keeps every beam of the lattice it closes. `raycastBatch({ subVoxel: true })` returns hits at their fractional position instead of truncated to whole voxels.

Faster with the same output: the tape fills hoist y-only and z-only work out of the voxel loop and square with `a*a`; `maskedByImplicit` evaluates only where the mask stores something; `properties()` measures once; contour stitching is linear; millimetre STL export skips the float32 transform chain; the adaptive merge in OpenVDB takes an exact fast path.

Fixes: the multi-threaded entry refreshes its heap views after a worker grows memory; `mesh.vertices` and `mesh.triangles` return copies, so editing them no longer changes later exports; an empty mesh exports as a valid GLB; out-of-range mesh indices throw instead of storing a dangling index; a scalar field built from voxels holds only the requested value; a zero-length flat-capped lattice beam renders nothing instead of NaN.
