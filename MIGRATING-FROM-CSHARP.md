# Migrating from C# PicoGK

The picogk-js surface is a **semantic port** of PicoGK's C# library (reviewed at `leap71/PicoGK` @ `389d4d9`, runtime 26.2): every behaviour that matters is preserved, while the surface grammar is translated to TypeScript idiom. This is the member-by-member map.

## Idiom rules (apply everywhere)

| C# construct | picogk-js rule |
| --- | --- |
| Constructor overloads | Named factories with options objects (`new Voxels(...)` ×10 → `createVoxels({ shape })`, `clone()`, `mesh.toVoxels()`) |
| Operator overloads (`+`, `-`, `&`) | Methods: `a.union(b)`, `a.subtract(b)`, `a.intersect(b)` |
| Mutate/copy pairs (`BoolAdd`/`voxBoolAdd`) | **Pure copy-first methods only**; variadic forms (`union(...many)`) recover the aggregation performance of `voxBoolAddAll` |
| Hungarian prefixes (`fVoxelSize`, `voxSphere`) | Dropped — TypeScript is the type annotation |
| `out`/`ref` params | Return objects: `CalculateProperties(out v, out b)` → `properties(): { volume, bounds }` |
| `bool Try…(out T)` duals | `T \| null` returns: `bClosestPointOnSurface` → `closestPointOnSurface(p): Vec3 \| null` |
| `IDisposable` + finalizer | Hidden: the GC frees wrappers via `FinalizationRegistry`; `dispose()` is optional; `using` still works |
| Global `Library.oLibrary()` | Not ported — sessions are explicit (`createPicoGK()`), never ambient |
| File paths | Bytes in, bytes out (`Uint8Array`); MEMFS is internal |
| `System.Numerics.Vector3` | `Vec3 = readonly [number, number, number]` |
| Exceptions | `PicoGkError` with a typed `code` |

## Library → `createPicoGK()` session

| C# | picogk-js |
| --- | --- |
| `new Library(fVoxelSizeMM)` | `await createPicoGK({ voxelSize })` |
| `Library.strName/strVersion/strBuildInfo` | `pk.name` / `pk.version` / `pk.buildInfo` |
| `lib.fVoxelSize` | `pk.voxelSize` |
| `n*MemUsage()` ×9 | `pk.memory` (camelCase map incl. `total`) |
| `n*Allocated()` ×8 | `pk.allocated` — the leak oracle |
| `vecVoxelsToMm` | `pk.voxelToMm([i, j, k])` |
| `MmToVoxels` | `pk.mmToVoxel([x, y, z])` — **fixed here**: the C# method calls the inverse conversion (Library.cs:276) |
| `Library.Dispose()` | `pk.dispose()` — frees everything the session owns |

## Voxels

| C# | picogk-js |
| --- | --- |
| `voxSphere` / `voxLatticeBeam` / ctors | `pk.createVoxels({ shape: 'empty' \| 'sphere' \| 'beam' \| 'implicit' })` |
| `voxDuplicate` / copy ctor | `voxels.clone()` |
| `voxBoolAdd(All)` / `voxBoolSubtract(All)` / `voxBoolIntersect` | `union(...others)` / `subtract(...others)` / `intersect(other)` — all pure |
| `voxOffset` / `voxDoubleOffset` / `voxTripleOffset`·`voxSmoothen` | `offset({ distance })` / `doubleOffset({ first, second })` / `smoothen({ distance })` |
| `voxOverOffset` / `voxFillet` | `fillet({ rounding, finalSurfaceDistance? })` |
| `voxShell(f)` / `voxShell(neg, pos, smooth)` | `shell({ offset })` / `shell({ inner, outer, smoothInner? })` (reversed offsets swap, as C# does) |
| `voxTrim(oBox)` | `trim(bounds)` |
| `voxProjectZSlice` | `projectZSlice({ startZ, endZ })` |
| `RenderMesh/RenderLattice/RenderImplicit` (pure forms) | `withMesh(mesh)` / `withLattice(lattice)` / `withImplicit({ sdf, boundsMin, boundsMax })` |
| `voxIntersectImplicit` | `maskedByImplicit({ sdf })` — the gyroid-in-sphere idiom |
| `bIsEqual` / `bIsEmpty` | `equals(other)` / `isEmpty` — **use `isEmpty`, never volume ≈ 0** (`a−a` keeps ~5% narrow-band volume) |
| `fCalculateVolume` | `volume` — fast, but approximate after booleans |
| `CalculateProperties` / `oCalculateBoundingBox` | `properties()` / `bounds()` — the accurate mesh-roundtrip forms |
| `bIsInside` / `vecSurfaceNormal` | `isInside(p)` / `surfaceNormal(p)` |
| `bClosestPointOnSurface` / `bRayCastToSurface` | `closestPointOnSurface(p)` / `raycastToSurface(p, direction)` — `null` for empty/miss |
| `GetVoxelDimensions` / `nSliceCount` / `vecZSliceOrigin` | `dimensions()` / `sliceCount` / `sliceOrigin(index?)` |
| `GetVoxelSlice` / `GetInterpolatedVoxelSlice` | `getSlice({ index, axis?, mode? })` / `getSlice({ z, interpolated: true, mode? })` — modes `'sdf' \| 'bw' \| 'antialiased'` |
| `mshAsMesh` | `toMesh()` |
| `ScalarField(vox)` | `toScalarField()` |
| `oMetaData()` / `nMemUsage` | `metadata` / `memUsage` |

## Mesh

| C# | picogk-js |
| --- | --- |
| `new Mesh(lib)` + `nAddVertex`/`nAddTriangle` | `pk.createMesh({ vertices, triangles })` — two bulk ABI crossings |
| `vVertices()` / `vTriangles()` | `mesh.vertices` / `mesh.triangles` (caller-owned copies) |
| `nVertexCount` / `nTriangleCount` | `vertexCount` / `triangleCount` |
| `oBoundingBox` | `bounds()` — empty meshes return the ±FLT_MAX sentinel, never NaN |
| `mshCreateTransformed(vecScale, vecOffset)` | `transform({ scale, offset? })` — **fixed here**: C# scales each triangle corner by a *different* axis component (Mesh.cs:86-88) |
| `mshCreateTransformed(matTrans)` | `transform({ matrix })` (row-vector convention, translation in elements 12–14) |
| `mshCreateMirrored` | `mirror({ point, normal })` |
| `Append` | `merged(other)` — pure; no dedup, no boolean (same as upstream) |
| `new Voxels(msh)` | `toVoxels()` |
| `voxMeshShell` | `shellVoxels({ radius })` — offsets in ALL directions from a not-necessarily-closed mesh |
| `SaveToStlFile` / `mshFromStlFile` | `toStl({ unit?, scale?, offset? })` / `pk.meshFromStl(bytes, { unit?, scale?, offset? })` — binary STL, `UNITS=` header honoured |
| — | `toGlb()` (picogk-js original) |

Per-element `nAddVertex`/`vecVertexAt`/`oTriangleAt` live on `picogk-js/raw` only — the facade is bulk-first.

## Lattice / PolyLine

| C# | picogk-js |
| --- | --- |
| `AddSphere(vecCenter, fRadius)` | `lattice.addSphere({ center, radius })` |
| `AddBeam(...)` — two overloads differing only in parameter order | **one** signature: `addBeam({ start, end, radius \| startRadius/endRadius, roundCap? })` (`roundCap` defaults `true`) |
| `new Voxels(lat)` | `lattice.toVoxels()` |
| `PolyLine(lib, clr)` / `nAddVertex` / `Add` | `pk.createPolyLine({ color? })` / `addVertex(p)` / `addVertices(points)` |
| `AddArrow` / `AddCross` | Dropped (viewer decoration) |

## ScalarField / VectorField / Metadata / VdbFile

| C# | picogk-js |
| --- | --- |
| 4 field ctors | `pk.createScalarField()` / `({ from })` / `({ from, value, sdThreshold? })`; same for `createVectorField` |
| `SetValue` / `bGetValue` / `RemoveValue` | `set(p, v)` / `get(p): v \| null` / `remove(p)` |
| `TraverseActive(ITraverse…)` | `traverse((x, y, z, …values) => {})` — scalars, no per-visit allocation |
| `fSignedDistance` | `scalarField.signedDistanceAt(p)` (stored value × voxelSize, as C# does) |
| `GuardInternalFields` | `metadata.set/remove` throw `PICOGK_RESERVED_METADATA` for `PicoGK.*`, `class`, `name`, `file_*` |
| Auto `PicoGK.Class` tag | Preserved on every Voxels/ScalarField/VectorField creation (.vdb interchange) |
| `OpenVdbFile` | `pk.createVdb()` / `pk.openVdb(bytes)`; `add(field, name?)`, `fields()`, `getVoxels/getScalarField/getVectorField(indexOrName)`, `toBytes()` |
| `voxFromVdbFile` | `pk.voxelsFromVdb(bytes)` — first `GRID_LEVEL_SET` field wins; the error lists what was found |
| `libCreateCompatibleLibraryFor` | `pk.vdbVoxelSize(bytes)` — read the size, then `createPicoGK({ voxelSize })` to match |
| `SaveToFile` metadata stamping | Preserved: `toBytes()` stamps `PicoGK.Library/Version/VoxelSize` on every field |

## Slicing (`picogk-js/slicing`)

| C# | picogk-js |
| --- | --- |
| `Voxels.oVectorize` | `sliceVoxels(voxels, { layerHeight?, useAbsoluteXY?, onProgress? })` |
| `PolySlice` / `PolyContour` | `SliceStack` → `Slice { z, contours }` → `SliceContour { points: Float64Array, winding }` (solids CCW, holes CW) |
| `PolySlice.SaveToSvgFile` | `sliceToSvg(slice, { solid?, strokeWidth?, viewBox? })` — deterministic string |
| `CliIo.WriteSlicesToCliFile` / `oSlicesFromCliFile` | `slicesToCli(stack, { units?, emptyFirstLayer?, date? })` / `slicesFromCli(bytes)` |
| `IProgress` | A plain `(fraction: number) => void` callback |

## Upstream bugs fixed here (do-not-port list)

| # | C# location | Bug | picogk-js behaviour |
| --- | --- | --- | --- |
| B1 | `Base/Mesh.cs:86-88` | `mshCreateTransformed(vecScale, …)` multiplies corner A by `scale.X`, B by `scale.Y`, C by `scale.Z` | `transform({ scale })` scales every vertex component-wise |
| B2 | `Library/Library.cs:276` | `MmToVoxels` calls `_VoxelsToMm` — the inverse conversion | `mmToVoxel` binds the real export, rounds to nearest index |
| B3 | `Base/Lattice.cs:78-114` | Two `AddBeam` overloads differing only in parameter order | One options-object signature |
| B4 | `IO/OpenVdbFile.cs` era `Voxels.cs:680-700` | `voxShell(neg, pos, smooth)` calls the *copy* forms of subtract/smoothen and discards the results — the two-offset shell never subtracts and never smooths | `shell({ inner, outer, smoothInner })` implements the documented intent |

## Deliberately not on this surface

`Viewer/*` (browser rendering is `picogk-js/three` + your scene), `Library.Go()` and the global registry, `Numerics/` + `Shapes/` (the flagship C# models don't consume them — candidate future subpath), Skia imaging / `LogFile` / `Animation` / `Csv` / `TgaIo` (platform natives replace them), `MeshMath.bFindTriangleFromSurfacePoint` (use `bounds()` + an external BVH).
