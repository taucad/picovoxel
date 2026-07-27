# Migrating from C# PicoGK

The picovoxel surface is a **semantic port** of PicoGK's C# library (reviewed at `leap71/PicoGK` @ `389d4d9`, runtime 26.2): every behaviour that matters is preserved, while the surface grammar is translated to TypeScript idiom. This is the member-by-member map.

## Idiom rules (apply everywhere)

| C# construct | picovoxel rule |
| --- | --- |
| Constructor overloads | Named factories with options objects (`new Voxels(...)` ×10 → `createVoxels({ shape })`, `clone()`, `mesh.toVoxels()`) |
| Operator overloads (`+`, `-`, `&`) | Methods: `a.union(b)`, `a.subtract(b)`, `a.intersect(b)` |
| Mutate/copy pairs (`BoolAdd`/`voxBoolAdd`) | **Pure copy-first methods only**; variadic forms (`union(...many)`) recover the aggregation performance of `voxBoolAddAll` |
| Hungarian prefixes (`fVoxelSize`, `voxSphere`) | Dropped — TypeScript is the type annotation |
| `out`/`ref` params | Return objects: `CalculateProperties(out v, out b)` → `properties(): { volume, bounds }` |
| `bool Try…(out T)` duals | `T \| null` returns: `bClosestPointOnSurface` → `closestPointOnSurface(p): Vec3 \| null` |
| `IDisposable` + finalizer | Hidden: the GC frees wrappers via `FinalizationRegistry`; `dispose()` is optional; `using` still works |
| Global `Library.oLibrary()` | Not ported — sessions are explicit (`createPico()`), never ambient |
| File paths | Bytes in, bytes out (`Uint8Array`); MEMFS is internal |
| `System.Numerics.Vector3` | `Vec3 = readonly [number, number, number]` |
| Exceptions | `PicoError` with a typed `code` |

## Library → `createPico()` session

| C# | picovoxel |
| --- | --- |
| `new Library(fVoxelSizeMM)` | `await createPico({ voxelSize })` |
| `Library.strName/strVersion/strBuildInfo` | `pk.name` / `pk.version` / `pk.buildInfo` |
| `lib.fVoxelSize` | `pk.voxelSize` |
| `n*MemUsage()` ×9 | `pk.memory` (camelCase map incl. `total`) |
| `n*Allocated()` ×8 | `pk.allocated` — the leak oracle |
| `vecVoxelsToMm` | `pk.voxelToMm([i, j, k])` |
| `MmToVoxels` | `pk.mmToVoxel([x, y, z])` — **fixed here**: the C# method calls the inverse conversion (Library.cs:276) |
| `Library.Dispose()` | `pk.dispose()` — frees everything the session owns |

## Voxels

| C# | picovoxel |
| --- | --- |
| `voxSphere` / `voxLatticeBeam` / ctors | `pk.createVoxels({ shape: 'empty' \| 'sphere' \| 'beam' \| 'implicit' })` |
| `voxDuplicate` / copy ctor | `voxels.clone()` |
| `voxBoolAdd(All)` / `voxBoolSubtract(All)` / `voxBoolIntersect` | `union(...others)` / `subtract(...others)` / `intersect(other)` — all pure |
| `voxOffset` / `voxDoubleOffset` / `voxTripleOffset`·`voxSmoothen` | `offset({ distance })` / `doubleOffset({ first, second })` / `smoothen({ distance })` |
| `voxOverOffset` / `voxFillet` | `fillet({ rounding, finalSurfaceDistance? })` |
| `voxShell(f)` / `voxShell(neg, pos, smooth)` | `shell({ offset })` / `shell({ inner, outer, smoothInner? })` (reversed offsets swap, as C# does) |
| — | `fastRenorm?: true` on all five offset methods (picovoxel original, SK-0.8): first-order instead of HJ-WENO5 level-set renormalization, **3.5–4× faster**, output bounded and gated (`bench/results/webgpu-v2/SK-0.8.md`). Since SKv2-0 V0.4 a per-op absence falls to the session default (`createPico({ fastRenorm })`, library default false; explicit per-op always wins) — the library default path stays the C#-identical call, bit-for-bit. C# has no equivalent (upstreamable **U22**) |
| `voxTrim(oBox)` | `trim(bounds)` |
| `voxProjectZSlice` | `projectZSlice({ startZ, endZ })` |
| `RenderMesh/RenderLattice/RenderImplicit` (pure forms) | `withMesh(mesh)` / `withLattice(lattice)` / `withImplicit({ sdf, boundsMin, boundsMax })` |
| — | lattice rendering (`toVoxels()` / `withLattice`) defaults to the **parallel tube-complex lane** since SK-0.4 (`Voxels_RenderLatticeTubes`, deterministic by construction, flat-capped beams auto-fall back to the serial loop; `bench/results/webgpu-v2/SK-0.4.md`). `PICOVOXEL_SERIAL_LATTICE=1` restores the C#-identical serial lane wholesale; the raw subpath keeps both exports. C# has no parallel equivalent (upstreamable **U5**; the serial SDF is also wrong on nested-radius beams, **U23**) |
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

| C# | picovoxel |
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
| — | `toGlb()` (picovoxel original) |

Per-element `nAddVertex`/`vecVertexAt`/`oTriangleAt` live on `picovoxel/raw` only — the facade is bulk-first.

## Lattice / PolyLine

| C# | picovoxel |
| --- | --- |
| `AddSphere(vecCenter, fRadius)` | `lattice.addSphere({ center, radius })` |
| `AddBeam(...)` — two overloads differing only in parameter order | **one** signature: `addBeam({ start, end, radius \| startRadius/endRadius, roundCap? })` (`roundCap` defaults `true`) |
| `new Voxels(lat)` | `lattice.toVoxels()` |
| `PolyLine(lib, clr)` / `nAddVertex` / `Add` | `pk.createPolyLine({ color? })` / `addVertex(p)` / `addVertices(points)` |
| `AddArrow` / `AddCross` | Dropped (viewer decoration) |

`addBeam`/`addSphere` are **batched** (SK-0.3): elements accumulate in a flat typed array and
cross the ABI once per lattice, at the first call that can observe them — `toVoxels()`,
`memUsage`, or the `handle` escape hatch (which is how `voxels.withLattice` reaches it). The
API is unchanged and so is the resulting geometry, element order included; only the *timing*
of the native call moves. C# has no equivalent — `Lattice.AddBeam` is a P/Invoke per beam
(upstreamable **U17**).

## ScalarField / VectorField / Metadata / VdbFile

| C# | picovoxel |
| --- | --- |
| 4 field ctors | `pk.createScalarField()` / `({ from })` / `({ from, value, sdThreshold? })`; same for `createVectorField` |
| `SetValue` / `bGetValue` / `RemoveValue` | `set(p, v)` / `get(p): v \| null` / `remove(p)` |
| `TraverseActive(ITraverse…)` | `traverse((x, y, z, …values) => {})` — scalars, no per-visit allocation |
| `fSignedDistance` | `scalarField.signedDistanceAt(p)` (stored value × voxelSize, as C# does) |
| `GuardInternalFields` | `metadata.set/remove` throw `PICO_RESERVED_METADATA` for `PicoGK.*`, `class`, `name`, `file_*` |
| Auto `PicoGK.Class` tag | Preserved on every Voxels/ScalarField/VectorField creation (.vdb interchange) |
| `OpenVdbFile` | `pk.createVdb()` / `pk.openVdb(bytes)`; `add(field, name?)`, `fields()`, `getVoxels/getScalarField/getVectorField(indexOrName)`, `toBytes()` |
| `voxFromVdbFile` | `pk.voxelsFromVdb(bytes)` — first `GRID_LEVEL_SET` field wins; the error lists what was found |
| `libCreateCompatibleLibraryFor` | `pk.vdbVoxelSize(bytes)` — read the size, then `createPico({ voxelSize })` to match |
| `SaveToFile` metadata stamping | Preserved: `toBytes()` stamps `PicoGK.Library/Version/VoxelSize` on every field |

### FieldUtils (headless pair, blueprint R14)

| C# | picovoxel |
| --- | --- |
| `SurfaceNormalFieldExtractor.oExtract(vox, fSurfaceThresholdVx, vecDirectionFilter, fDirectionFilterTolerance, vecScaleBy)` | `surfaceNormalFieldExtractor(pk, voxels, { surfaceThresholdVx?, directionFilter?, directionFilterTolerance?, scaleBy? })` — over `traverse()`, no ABI change |
| `VectorFieldMerge.Merge(oSource, oTarget)` | `vectorFieldMerge(source, target)` |
| `SdfVisualizer` / `AddVectorFieldToViewer` (rest of `Utils/FieldUtils.cs`) | N/A — image/viewer-bound |

## Slicing (`picovoxel/slicing`)

| C# | picovoxel |
| --- | --- |
| `Voxels.oVectorize` | `sliceVoxels(voxels, { layerHeight?, useAbsoluteXY?, onProgress? })` |
| `PolySlice` / `PolyContour` | `SliceStack` → `Slice { z, contours }` → `SliceContour { points: Float64Array, winding }` (solids CCW, holes CW) |
| `PolySlice.SaveToSvgFile` | `sliceToSvg(slice, { solid?, strokeWidth?, viewBox? })` — deterministic string |
| `CliIo.WriteSlicesToCliFile` / `oSlicesFromCliFile` | `slicesToCli(stack, { units?, emptyFirstLayer?, date? })` / `slicesFromCli(bytes)` |
| `IProgress` | A plain `(fraction: number) => void` callback |

## Numerics (`picovoxel/numerics`)

The CEM numerics foundation: the System.Numerics analog JS lacks, the
`PicoGK.Numerics` domain layer, and the canonical rigid frame. Pure math — no
wasm dependency. One deliberate architecture deviation: C# houses `Frame3d` in
`PicoGK.Shapes`; the TS module folds the value type into numerics, and
ShapeKernel-TS's `LocalFrame` **is** this `Frame` plus construction helpers —
the C# `LocalFrame⇄Frame3d` duplication and implicit-conversion bridge are not
reproduced. Ported semantics, not bit-width: .NET computes in float32, JS in
float64 (strictly more precise for authoring math).

Because `Rad`/`Overhang` are **branded numbers** and `Vec2`/`Vec3` are tuples,
most C# operator overloads, comparisons and `GetHashCode`/`CompareTo` plumbing
need no port — native JS semantics cover them. Those rows are marked *native*.

### System.Numerics (BCL analog)

| C# | picovoxel |
| --- | --- |
| `Vector2` | `Vec2 = readonly [number, number]` + `vec2.add/sub/scale/dot/length/lengthSquared/distanceSquared/lerp/zero` |
| `Vector2.Normalize` | `vec2.normalized` (throws on zero) / `vec2.safeNormalized` (component-wise division, as .NET) |
| `Vector3` | `Vec3` (types.ts) + `vec3.add/sub/neg/scale/dot/cross/length/lengthSquared/distance/distanceSquared/lerp` |
| `Vector3.UnitX/UnitY/UnitZ/Zero/One` | `vec3.unitX/unitY/unitZ/zero/one` |
| `Vector3.Normalize` | `vec3.normalized` / `vec3.safeNormalized` |
| `Vector3.Transform(v, Matrix4x4)` | `vec3.transformed(v, m)` — row-vector, translation in 12–14 |
| `Vector3.Transform(v, Quaternion)` | `quat.transform(v, q)` |
| `Quaternion` | `Quat = readonly [x, y, z, w]` |
| `Quaternion.Identity` / `CreateFromAxisAngle` / `CreateFromRotationMatrix` / `Slerp` / `Dot` | `quat.identity` / `fromAxisAngle` / `fromMat4` / `slerp` / `dot` (.NET reference algorithms — Shepperd branches, shortest-arc slerp) |
| `Quaternion` remaining members (`Concatenate`, `Inverse`, `CreateFromYawPitchRoll`, …) | N/A — zero kernel/consumer demand; add on first real use |
| `Matrix4x4` | `Mat4` (types.ts — already an ABI type) + `mat4.identity/createScale/multiply` |
| `Matrix4x4` remaining members (`Invert`, `Decompose`, projections, …) | N/A — nothing headless consumes them; `frame.inverse` covers the rigid case |
| `Vector4`, `Plane` | N/A — zero uses in kernel or any consumer repo |
| `BigInteger` / `Complex` / tensor types | N/A — not geometry |

### PicoGK.Numerics

| C# | picovoxel |
| --- | --- |
| `Rad` | `Rad` — branded number in radians; arithmetic/comparisons are native (results re-brand via `rad.add/sub/scale/div/neg`; `Rad / Rad` → `rad.ratio`) |
| `Rad.TwoPi` | `TWO_PI` |
| `Rad.Zero/Full/Half/Quarter/Deg45` (+ `Deg0/Deg360/Deg180/Deg90` aliases) | `rad.zero/full/half/quarter/deg45` (aliases N/A — one name each) |
| `rFromRad` / explicit `(Rad)float` cast | `rad.fromRad` |
| `rFromDeg` / `rFromNormalized` | `rad.fromDeg` / `rad.fromNormalized` (clamped, as C#) |
| `fRad` / implicit `float` conversion | native — a `Rad` **is** a number |
| `fDeg` | `rad.deg(r)` |
| `rNormalizedSigned` / `rNormalizedPositive` | `rad.normalizedSigned` (IEEE-remainder tie-to-even, as `MathF.IEEERemainder`) / `rad.normalizedPositive` |
| `bAlmostEqual` / `bAlmostEqualPeriodic` | `rad.almostEqual` / `rad.almostEqualPeriodic` |
| `bIsFinite` | native `Number.isFinite` |
| `fSin/fCos/fTan` | native `Math.sin/cos/tan` — the C# wrappers exist only for the struct |
| `rAtan2(Vector2)` / `rAtan2(fY, fX)` | `rad.atan2(y, x)` (vector form: pass `v[1], v[0]`) |
| `rAtan` / `rAcos` / `rAcosClamped` / `rAsin` / `rAsinClamped` | `rad.atan/acos/acosClamped/asin/asinClamped` |
| `Rad` operators / `CompareTo` / `Equals` / `GetHashCode` / `ToString` | native (`ToString` → template literal + `rad.deg`) |
| `Overhang` | `Overhang` — branded normalized severity 0..1 |
| `uNone` / `uFull` | `overhang.none` / `overhang.full` |
| `uFromNormalized/uFromPercent/uFromRad/uFromDeg/uFromDegFromHorizontal` | `overhang.fromNormalized/fromPercent/fromRad/fromDeg/fromDegFromHorizontal` (range-validated, throw `PICO_INVALID_ARGUMENT`) |
| `fNormalized/fPercent/fRad/fDeg/fDegFromHorizontal` | the number itself / `overhang.percent/rad/deg/degFromHorizontal` |
| `bExceeds` / comparison operators | native `>` on the branded number |
| `Polar` / `Cylindrical` / `Spherical` | interfaces `Polar { r, phi }` / `Cylindrical { r, phi, z }` / `Spherical { r, phi, theta }` |
| coordinate ctors (validated) | `polar.create` / `cylindrical.create(..)`·`fromPolar` / `spherical.create` — same range checks, `PicoError` instead of `ArgumentException` |
| conversion ctors (`Polar(Vector2)`, `Cylindrical(Vector3/Spherical)`, `Spherical(Vector3/Cylindrical)`) | `polar.fromCartesian` / `cylindrical.fromCartesian/fromSpherical` / `spherical.fromCartesian/fromCylindrical` |
| `vecAsCartesian` | `polar/cylindrical/spherical.toCartesian` |
| `oLerp` (static + instance) | `polar/cylindrical/spherical.lerp` (angular deltas short-way-around, as C#) |
| coordinate `ToString` | N/A — template literals |
| `Tolerances.fDef/fDefSquared/fZero/fZeroSquared` | `tolerances.def/defSquared/zero/zeroSquared` |
| `float.bAlmostEqual/bAlmostLessOrEqual/bAlmostMoreOrEqual/bAlmostZero` | `scalar.almostEqual/almostLessOrEqual/almostMoreOrEqual/almostZero` |
| `Vector2/Vector3.bAlmostEqual/bAlmostZero` | `vec2/vec3.almostEqual/almostZero` |
| `VectorExt.vecNormalized/vecSafeNormalized` (both arities) | `vec2/vec3.normalized/safeNormalized` |
| `VectorExt.vecStripZ` / `vecAsVector3` | `vec3.stripZ` / `vec2.asVec3` |
| `VectorExt.vecPtWorld/vecDirWorld/vecPtLocal/vecDirLocal` | the frame functions themselves: `frame.ptToWorld/dirToWorld/ptFromWorld/dirFromWorld` (extension-method sugar not reproduced) |
| `VectorExt.vecTransformed` / `vecMirrored` | `vec3.transformed` / `vec3.mirrored` |
| `VectorExt.bIsFinite` (both arities) | `vec2/vec3.isFinite` |
| `FloatExt.bIsFinite` | native `Number.isFinite` |

### Frame3d (`PicoGK.Shapes` → folded into `picovoxel/numerics`, Finding 9)

| C# | picovoxel |
| --- | --- |
| `Frame3d` | `Frame { pos, lx, ly, lz }` — readonly value object |
| `frmWorld` | `frame.world` |
| `Frame3d(vecPos)` / `frmFromPos` | `frame.fromPos` |
| `Frame3d(origin, approxZ, approxX)` / `frmFromZX` | `frame.fromZX` — same Gram-Schmidt, Z wins, right-handed |
| `frmFromMatrix4x4` | `frame.fromMat4` |
| `vecPtToWorld` (Vec3 + Vec2 overloads) | `frame.ptToWorld(f, v)` — accepts `Vec2 \| Vec3` |
| `vecDirToWorld` (both overloads) | `frame.dirToWorld(f, v)` — safe-normalized, as C# |
| `vecPtFromWorld` / `vecDirFromWorld` | `frame.ptFromWorld` / `frame.dirFromWorld` |
| `frmCompose` / `operator *(frm, frm)` | `frame.compose(a, b)` |
| `frmInverse` | `frame.inverse` — **fixed here** (B5): rotation is transposed, so compose∘inverse ≡ identity |
| `frmMovedLocal(X/Y/Z)` | `frame.movedLocal` / `movedLocalX/Y/Z` |
| `frmMovedWorld(X/Y/Z)` | `frame.movedWorld` / `movedWorldX/Y/Z` |
| `frmRotatedWorld(vecAxis, rAngle)` | `frame.rotatedWorld(f, axis, angle)` — axis safe-normalized; zero axis is a no-op |
| `frmRepositioned` | `frame.repositioned` |
| `matAsMatrix4x4` | `frame.toMat4` — basis in rows, translation 12–14; feeds `mesh.transform({ matrix })` directly |
| `matComposeWithScale` | `frame.composeWithScale` |
| `AsRigid(out q, out origin)` | `frame.asRigid(f): { rotation, origin }` |
| `operator *(frm, vec)` | `frame.ptToWorld` |
| `frmInterpolate` | `frame.interpolate` — slerp rotation (shortest arc) + lerp position, t clamped |
| `Equals` / `GetHashCode` | `frame.equals` / native (`Map` keys: use your own key fn) |

The rest of `PicoGK.Shapes` (2D paths/contours, `OrientedPath`) stays deferred
until a consumer adopts it — see below.

## ShapeKernel (`picovoxel/shapekernel`)

TypeScript port of LEAP71_ShapeKernel as a layer on top of the public
picovoxel API + `picovoxel/numerics` (blueprint D3: subpath export, no wasm
changes). Explicit-session surface: shapes are pure authoring objects and the
session enters at the construction boundary (`shape.voxConstruct(pk)`,
`sh.*(pk, …)`) — never an ambient Library. `LocalFrame` **is** the numerics
`Frame` plus construction helpers (Finding 9).

| C# | picovoxel |
| --- | --- |
| `VecOperations` | `vecOps` — non-obsolete members; the `[Obsolete]` frame/vector helpers are `vec3`/`frame` in numerics |
| `LocalFrame` ctors / `oTranslate`/`oRotate`/`oGetInvertFrame`/`vecGetLocalY` | `localFrame.create/createZ/createZX/at/translated/rotated/inverted/localY` (normalizing, throwing on zero axes, NO Gram-Schmidt — upstream semantics) |
| `LocalFrame⇄Frame3d` implicit conversions | N/A — one frame type |
| `Frames` (4 ctors, EFrameType incl. MIN_ROTATION, sampling) | `Frames.alongLine/alongSpline/withTargetX/ofType` + `spineAt/localXAt/localYAt/localZAt/frameAt/points` |
| `ISpline` / `ControlPointSpline` / `TangentialControlSpline` / `CylindricalControlSpline` | `Spline` / same names (closed-mode wrap COPIES the control list instead of mutating the caller's — rendered spline identical) |
| `ControlPointSurface` | N/A — nothing headless consumes it yet |
| `SplineOperations` | `splineOps` (Vec2 overloads of closest-point helpers deferred with the 2D layer) |
| `Uf` (transitions, randomness, fibonacci, supershapes, polygons) | `uf` + `createRandom(seed)` (mulberry32); `Uf.Wait`, obsolete `fLimitValue` N/A |
| `LineModulation`/`SurfaceModulation` + operator overloads | same names; operators become `.add/.sub/.scale`; points form `LineModulation.fromPoints`; `SurfaceModulation.fromLineModulation`; the IMAGE input form is Skia-bound, N/A |
| `Distribution` / `GenericContour` | same names |
| `BaseShape` + `ISurfaceBaseShape`/`ISpineBaseShape`/`IMeshBaseShape`/`ILatticeBaseShape` | `BaseShape` (+`setTransformation`) + `SurfaceBaseShape`/`SpineBaseShape`/`MeshBaseShape`/`LatticeBaseShape`; construction takes the session |
| `BaseBox`/`BaseCylinder`/`BaseCone`/`BaseLens`/`BasePipe`/`BasePipeSegment`/`BaseRevolve`/`BaseRing`/`BaseSphere` | same names; `BasePipeSegment` takes an options object for the C# ctor split; `BaseBox(BBox3)` → `BaseBox.fromBounds` |
| `BaseLogoBox` | N/A — image input |
| `LatticePipe`/`LatticeManifold` | same names (`LatticeManifold` options object) |
| `MeshUtility` | `meshUtility` (session-first; C# `Append` → the facade's pure `mesh.merged`) |
| `ImplicitUtility` (`ImplicitGyroid`/`Sphere`/`Genus`/`SuperEllipsoid`) | same names, each as BOTH a JS callback (`.sdf`) and a tape (`.expression`) — value-identical (pinned) |
| `Sh` lattice builders / export functions | `sh` (session-first; bytes not paths; `latFromGrid`'s last-row-wins quirk ported verbatim and pinned) |
| `Sh` `[Obsolete]` voxel/boolean/query pass-throughs | N/A — the facade methods on `Voxels` |
| `Sh.Preview*` / TGA/PNG/CSV exports / `strGetExportPath` | N/A — see Visualizations below |
| `Visualizations/*` (MeshPainter, ColorScales, Cp palette, RotationAnimator) | **N/A — deliberate (blueprint R16 decision, recorded here):** the layer binds to the desktop GL viewer; headless examples emit volume/STL/GLB, and interactive viewing is the `picovoxel/three` subpath + your scene. Revisit only if a headless consumer demands `Sh.Preview*`-shaped helpers. |
| `Measure`/`Bisection`/`LineDecimation`/`ListOperations`/`CylUtility`/`RectUtility`/`GridOperations` (beyond `inverseGrid`)/`CSVWriter` | N/A until a subject pulls them (port-on-demand discipline; `inverseGrid` is exported from `sh`) |

Known upstream limitation carried faithfully (not fixable without patching the
vendored runtime): `voxIntersectImplicit` (`maskedByImplicit`) breaks below
**⅓ mm voxel size** — upstream's C++ `IntersectImplicit` passes
`fBackgroundMM()` (millimetres, float) into the fresh grid constructor's
`int nNarrowBand`, so fine sizes truncate to band 0 and openvdb's csg throws.
Verified on the pure callback path (0.34 mm works, 0.33 mm throws); the R9
tape entry replicates the truncation bit-compatibly so the two paths stay
differential-identical.

## LatticeLibrary (`picovoxel/latticelibrary`)

TypeScript port of LEAP71_LatticeLibrary as the third subpath export — the
interface-driven beam-lattice pipeline plus the implicit/TPMS library
(blueprint R13). Same conventions as ShapeKernel: explicit session, seeded
randomness only, derived-from headers.

| C# | picovoxel |
| --- | --- |
| `ICellArray`/`ILatticeType`/`IBeamThickness`/`IUnitCell`/`ICoordinateTrafo`/`ISplittingLogic`/`IRawTPMSPattern` | TS interfaces (same contracts) |
| `RegularCellArray`/`RegularUnitCell`/`ConformalCellArray` (+ showcase shapes)/`CuboidCell` | same names |
| `BodyCentreLattice`/`OctahedronLattice`/`RandomSplineLattice` | same names (`RandomSplineLattice` takes an explicit `RandomSource`) |
| `ConstantBeamThickness`/`CellBasedBeamThickness`/`BoundaryBeamThickness`/`GlobalFuncBeamThickness` | same names |
| `ScaleTrafo`/`FunctionalScaleTrafo`/`RadialTrafo`/`CombinedTrafo`; the six splitting logics; the five raw TPMS patterns | same names |
| The 8 TPMS presets (`ImplicitLidinoid`, `ImplicitSchwarzPrimitive`, `ImplicitSchwarzDiamond`, `ImplicitModular`, `ImplicitRadialGyroid`, `ImplicitRandomizedSchwarzPrimitive`, `ImplicitSplitWallGyroid`, `ImplicitSplitVoidGyroid`) | same names; the 5 closed-form presets carry `.sdf` AND `.expression` (tape ≡ callback pinned; the M13 A/B measures the tape ~2× faster) — `RadialGyroid` (atan2), `RandomizedSchwarzPrimitive` (data-grid gather) and `Modular` (arbitrary user callbacks) are callback-only, the same expressibility boundary R9 drew |
| `RandomDeformationField` | same name, explicit `RandomSource`; upstream quirks kept and pinned (corner-seed `iX*iY*iZ` overflow via `Math.imul`, max-face off-by-one) |
| `PreviewUnitCell` + wireframe loops | N/A — viewer-bound (R16) |

## Upstream bugs fixed here (do-not-port list)

| # | C# location | Bug | picovoxel behaviour |
| --- | --- | --- | --- |
| B1 | `Base/Mesh.cs:86-88` | `mshCreateTransformed(vecScale, …)` multiplies corner A by `scale.X`, B by `scale.Y`, C by `scale.Z` | `transform({ scale })` scales every vertex component-wise |
| B2 | `Library/Library.cs:276` | `MmToVoxels` calls `_VoxelsToMm` — the inverse conversion | `mmToVoxel` binds the real export, rounds to nearest index |
| B3 | `Base/Lattice.cs:78-114` | Two `AddBeam` overloads differing only in parameter order | One options-object signature |
| B4 | `IO/OpenVdbFile.cs` era `Voxels.cs:680-700` | `voxShell(neg, pos, smooth)` calls the *copy* forms of subtract/smoothen and discards the results — the two-offset shell never subtracts and never smooths | `shell({ inner, outer, smoothInner })` implements the documented intent |
| B5 | `Shapes/3D/Frame3d.cs:229-241` | `frmInverse` copies `vecLz`/`vecLx` into the inverse unchanged — the translation is inverted but the rotation is not, so `frmCompose(frmInverse())` ≠ identity for any rotated frame | `frame.inverse` transposes the rotation (inverse basis = rows of R); compose∘inverse ≡ identity is a pinned test |

## Upstreamable spikes ledger

Per-component queue of fixes/improvements we carry (or plan) locally that belong upstream. Status: `identified` → `spiked` (implemented + measured here) → `pr-drafted` → `landed`. Convergent-evidence notes strengthen the PR case. Companion: `WORKLOAD-EXECUTORS.md`; program docs in `docs/research/picogk-webgpu-*` (tau monorepo).

**Standing rule.** This ledger is updated with **every** patch we make to an
upstream dependency, in the *same* change that lands the patch. A patch with no
U-row, or a U-row that does not cite its patch file by exact path, is a defect
in this document. Corollary: a row that claims implemented-and-measured work
owes a real `.patch` file — "staged in `upstream/`" is not a deliverable.

**Two homes for patch files** (full explanation in `upstream/README.md`):
`patches/<dep>/*.patch` are **applied to our vendored build** by
`scripts/fetch-deps.sh` and are upstreamable as-is; `upstream/*.patch` are
**proposals only**, never applied locally — code we ship some other way (a
sibling TU, a direct binding) shaped as a diff so the offer to a maintainer is
a patch and not prose. Never move a file between the two directories to tidy
up: `patches/` is build input.

**Gate regime (2026-07-27).** Upstream candidacy now includes the *shape of the
evidence*, per `NON-DETERMINISM.md`: byte parity is the oracle lane's service,
not the program gate. A PR from us should ship with the **G0 identity** tuple
(canonical grid hash, volume as hex float64, active-voxel and triangle/vertex
counts, order-invariant mesh multiset hash — run-to-run triples, single≡multi,
cross-build, **at ≤0.7 mm as well as pinned scales**) and, where the change is
allowed to move values, the **SK-0.8 tolerance gates** (corrected volume and
area ≤3%, bounds ≤1 voxel, band SDF max ≤1 / mean ≤0.25 voxel,
`tools::checkLevelSet` EMPTY as a hard boolean, analytic cross-scoring where a
closed form exists). That is a *stronger* offer than byte pins: it survives
platform, allocator and thread-count differences a maintainer's machine will
have and ours will not, and it is what actually caught both of this program's
Class-X defects. Each row below should state the divergence class it claims
(0 byte-identical / 1 same geometry, permuted order / 2 bounded numeric drift)
and the oracle that establishes it.

### PicoGKRuntime (leap71/PicoGKRuntime)

| # | Item | Evidence | Status |
| --- | --- | --- | --- |
| U1 | `IntersectImplicit` narrow-band int-truncation (`Voxels oVox(oVoxelSize(), fBackgroundMM())` → `m_nSdfNarrowBand`); breaks below ~0.33 mm | our R7 root-cause + PicoPie `scripts/patch_runtime.py` Fix 2 — two independent bindings, identical diagnosis | identified |
| U2 | `ProjectZSliceDn/Up` end-cap seal uses mm as a voxel count (`(int)(0.5f + background())`, `PicoGKVdbVoxels.h:482,523`); caps silently unsealed <0.167 mm, wrong count at 0.5 mm | PicoPie Fix 3; on HeatX + RoverWheel hot paths; L0-visible (pins regenerate on adoption). **Unblocked by the gate regime** (`NON-DETERMINISM.md` §4, §14.3): this is a *correctness* fix that byte pins currently freeze, and it is the canonical case pairwise identity can never catch on its own (deterministic wrongness, p=1 — identity gates must pair with a semantic oracle). Adopt with seal-count-correct pins *per scale* rather than byte pins; the defect is scale-gated exactly like the P0s were, so the gate must sweep ≤0.167 mm | identified |
| U3 | Active-voxel-count export (pre-size batch buffers; kills count-then-fill double passes) | PicoPie `_fastloop.pyx:143-144` needs it; our batch ABIs need it | identified |
| U4 | Bulk mesh ABI — `Mesh_GetVertices`/`Mesh_GetTriangles`/`Mesh_AddVertices`/`Mesh_AddTriangles`, caller-supplied buffers on the `Voxels_GetZSlice` precedent. Reads clamp and return the count written; writes return the first index and route through `Mesh::nAddVertex/nAddTriangle` so the bbox and `nMemUsage` bookkeeping stay correct | our R11 implementation (`src/pico-bulk.cpp`) + measured wins: 522k ABI crossings → 2 on a 174k-vertex mesh, ~150× on readback; differentially byte-identical to the per-element path (100k-vertex FNV-1a) in our suite. **Patch: `upstream/picogkruntime-bulk-mesh-abi.patch`** (C ABI half, dry-run clean against pristine `0f26321c`); PR text `upstream/pr-bulk-mesh-transfer.md` carries the rationale and the C# binding half, which targets leap71/PicoGK — a different repo, so it stays described rather than diffed. Class 0 (pure transport; identical bytes out) | **spiked** |
| U5 | Parallel `RenderLattice` via `tools::createLevelSetTubeComplex` — the parallel replacement has shipped inside openvdb since 12.1 and `PicoGKVdbVoxels.h:49` already `#include`s it unused. Ask: dispatch round-capped beams + spheres through the tube complex (they are exactly its sphere-capped convex hulls; flat cones keep the serial loop), plus the U18-adjacent accessor patch (`patches/PicoGKRuntime/0002-lattice-parameter-accessors.patch`, seven inline const getters — without them `fSdValue()` is the only readable surface and every renderer is forced into the per-sample shape). One caveat for upstream: the stock entry point runs `parallel_reduce` under the auto partitioner, so output tree topology depends on worker availability — our TU drives the same voxelizer under `parallel_deterministic_reduce` (grain from bucket count only) and measures bit-exact single≡multi at no cost | implemented here as a sibling TU (`src/pico-lattice.cpp`, SK-0.4, now the facade default): wall stages 6.05× @1.0 mm/12T, 13.2× @0.5 mm, field deltas ≤1e-5 mm vs serial with byte-identical `checkLevelSet` counts, +61.6 MiB peak at 10⁵ beams; `bench/results/webgpu-v2/SK-0.4.md`. **Class 1** (schedule-independent by the tape-fill proof; ~1e-7 rel deltas vs serial, 3/3 run-stable) — under the gate regime (`NON-DETERMINISM.md` §4) the byte gate's only contribution to this row was ceremony, and the SK-0.4 pin regeneration is chartered as the *last* pin ceremony of its kind (§12.5). **Patch pending — blocked on a build**: the accessor half is a real file (above), but the tube-complex dispatch is a *rewrite* of `Voxels::RenderLattice`, not an insertion — shaping our `src/pico-lattice.cpp` as an upstream diff needs a compile+run to verify the flat-cone fallback and the `parallel_deterministic_reduce` driver against upstream's own call sites, which this pass does not do | **spiked** |
| U6 | Never-abort guard (try/catch → error flag on every `PICOGK_API`; uncatchable OpenVDB aborts become recoverable errors) | PicoPie Fix 1 pattern; our TU has zero try/catch | identified |
| U7 | GPU compute lane (WGSL kernels + C-ABI TUs + Dawn scheduler) as optional capability | program P9 exit; offered with benchmarks | identified (gated on program GO) |
| U17 | Bulk lattice authoring ABI — `Lattice_AddBeams(pfBeams, pnRoundCap, nCount)` / `Lattice_AddSpheres(pfSpheres, nCount)`, the sibling of U4 for the *other* chatty entry point. Wire format is 8 f32 per beam, `(x, y, z, radius)` per endpoint (two vec4 lanes, 32 B stride) so the same buffer feeds a GPU upload unrepacked; elements still route through `Lattice::AddBeam`, preserving the bbox update and the degenerate round-cap → sphere rule (`PicoGKLattice.h:213-218`) | our SK-0.3 implementation (`src/pico-bulk.cpp`) + measurement: HeatX **1,197,460 crossings → 37**, counter-verified; facade **50.1 → 39.2 ns/beam**; `author` stage **238.7 → 150.8 ms** (paired ABAB ×5, disjoint ranges); voxelization byte-identical (`bench/results/webgpu-v2/SK-0.3.md`). The C# binding has the same shape of problem — `Lattice.AddBeam` is a P/Invoke per beam. **Patch: `upstream/picogkruntime-bulk-lattice-abi.patch`** (C ABI half, dry-run clean against pristine `0f26321c`, and clean applied after the U4 patch); the C#-side accumulate-and-flush change targets leap71/PicoGK and stays described here. Class 0 — same elements, same order, byte-identical voxelization | **spiked** |
| U18 | `Lattice` stores `std::vector<LatticeBeam::Ptr>` — a `make_shared` (control block + ~64 B object) **per beam** and a pointer chase per beam in `RenderLattice`. `LatticeBeam` is a value type with no polymorphism and no shared ownership; `std::vector<LatticeBeam>` would be a 2-line change in `PicoGKLattice.h` plus `*roBeam` → `roBeam` in `PicoGKVdbVoxels.h:349,354`. Also unlocks contiguous upload (and pairs with U5's parallel `RenderLattice`) | SK-0.3 decomposition: with the ABI crossing amortised away, **20.9 ns of the 39.2 ns/beam is C++-side ingest** — i.e. the allocator, not the boundary. 1.2M beams per HeatX. Not implemented here: it edits the vendored tree R4 keeps pristine, and the renderer TU is a sibling spike's. **Priority under the lane regime (2026-07-27):** the row has two halves and they now diverge. The *ingest* half (one `make_shared` per beam, the 20.9 ns) is paid on **every** lane, is the residual left over after U17, and is what blocks a contiguous GPU upload (harmonic S-A wants the flat buffer as the storage, not as a staging copy) — so it is the half that matters and it went **up** in priority. The *pointer-chase in `RenderLattice`* half is now paid only on the retired serial lane (`PICOVOXEL_SERIAL_LATTICE=1`) and in C#, since SK-0.4's tube-complex lane is the default here — demoted to oracle-lane duty. Cheap to gate: a storage-representation change with no value change is **Class 0**, so G0 identity (canonical grid hash + volume hex, run-to-run and single≡multi at ≤0.7 mm) settles it without a pin ceremony. Patch pending — blocked on a build (it changes a header the vendored tree keeps pristine and the renderer must be recompiled against it) | identified |
| U19 | `roAsMesh()` parallel disjoint-slot flatten + `Mesh` bulk-construction seam — replaces four serial copy passes (openvdb's per-element primitive copy + the facade's quad-split/point/triangle re-copies) with pool-indexed count→prefix-sum→parallel emission; byte-identical output, order now allocation-independent | SK-0.6: patches `patches/PicoGKRuntime/0001-parallel-disjoint-mesh-flatten.patch` + `patches/openvdb/0001-flat-quad-output.patch` (opt-in flat quad output on the uniform path — the openvdb half extends U10) apply to pristine trees verbatim (re-verified `patch -p1 --dry-run`, 0 fuzz, 2026-07-27); suite 453/453 + byte-locked pins green both variants; `bench/results/webgpu-v2/SK-0.6.md`. **Exoneration worth carrying into the PR text:** SK-0.9 named both of these patches as prime suspects for a mesh corruption (91.8% out-of-range triangle indices under mimalloc MT) and SK-0.10 **cleared them by direct measurement** — a sentinel probe (`0xAB` over `mFlatQuads`, `0xCD` over the `BulkResize` triangle array, scanned over the exact consumed ranges) found zero surviving sentinels, zero `INVALID_IDX` and zero out-of-range indices *inside wasm*; the defect was a signed-shift heap-view read in our own TypeScript (`bench/results/webgpu-v2/SK-0.10.md` §2–§4). The patches also carry the regime's own headline: SK-0.6 is the proof that a Class-1 ordering problem can be engineered away at **negative cost** — the deterministic disjoint-slot layout *is* the performance fix (`NON-DETERMINISM.md` §4) | **spiked** |
| U20 | `BoolAdd/BoolSubtract/BoolIntersect` deep-copy the WHOLE operand grid before `tools::csg*` because those steal from their second argument (`PicoGKVdbVoxels.h:247-275`). The deficiency is real and still open. The *fix we tried* — the same merge operators under a `DeepCopy` tag (`tools/Merge.h`, `TreeToMerge`), which copy only the grafted nodes and track consumption in a lightweight `MaskTree` — **is not usable as written**: it made the 12-thread build drop geometry nondeterministically at every voxel size below 1.0 mm | **REVERTED (P0)**: the toggle matrix in `bench/results/webgpu-v2/SK-0-P0-finecell.md` found it necessary and sufficient (3/3 divergent with it, 3/3 bit-exact without; U21 alone clean), and the byte-locked corpus never saw it because every pin sits at ≥1.0 mm. **Precondition for any re-attempt**: establish whether the race is upstream in `TreeToMerge` under `DeepCopy` or in how the patch drove it — that question is open and is what decides whether this is a U-row at all. The 442.5 → 368.8 MB high-water win was real but was measured on a build that was losing nodes, so it needs re-deriving too. Method: `SK-0.5.md` §1. **Updated by `NON-DETERMINISM.md` (§4 modify/combine, §11.3):** (a) the **re-attempt vehicle is now `csgUnionCopy`**, not the `DeepCopy`-tagged merge — shared-nothing, const inputs, thread-local segments + merge, the shape this repo has already proven deterministic at production scale; it also deletes the facade's result clone, so its ceiling is *better* than the reverted design's, and post-SK-0.6 it may be byte-identical anyway. (b) The **precondition is a native stock-TBB reproducer** (~a day) and it is a precondition for the *diagnosis*, not just the re-attempt: close reading of `Merge.h`/`NodeManager.h` shows the mask access pattern is *designed* task-confined and our patch drove upstream's own code shape faithfully, which elevates a third suspect the toggle matrix structurally could not see — **substrate interaction**, since all four toggle configs ran patched oneTBB (U13–U15) on emscripten pthreads. (c) Upstream `Merge.h` is unchanged 122 commits past our pin, so a native repro would be a **novel upstream report**; if it does not reproduce natively, the row is ours and not upstream's. (d) **No patch file exists for this row and that is deliberate**: the `DeepCopy` hunks were reverted out of `patches/PicoGKRuntime/0001-post-fill-prune.patch` and are not retained, so a re-attempt starts from `csgUnionCopy` against a pristine tree rather than from the reverted diff. (e) Gate note: this is **Class X** and tolerance gates cannot police it — the worst run lost 0.64% of triangles, inside any 3% band; only exact identity at fine cells finds it (§3.1) | **reverted (P0)** |
| U21 | The dense-accessor fills (`RenderImplicit`, `RenderLattice`, `ProjectZSliceUp/Dn`) never prune, so every 8³ block they touch keeps a leaf — including blocks that end up uniformly ±background. The csg paths already end in `pruneLevelSet` (`Composite.h`, `prune=true`) and `LevelSetFilter` prunes its own output; these three are the only unpruned producers, and every downstream op then iterates the slack | SK-0.5 prunable-slack probe at 0.4 mm: **−68.1%** tree (`RenderImplicit`), **−36.1%** (`ProjectZSlice`), **−5.5%** (`RenderLattice`); all fills at 0% residual after. Bit-identical raw `levelSetVolume`, mesh-roundtrip volume and STL bytes on every path. Patch: `patches/PicoGKRuntime/0001-post-fill-prune.patch` (the whole file since the U20 half was reverted out of it). Measured **innocent** of the P0 in its own toggle row — 3/3 bit-exact at 0.7 mm with it applied and U20 removed (`SK-0-P0-finecell.md`). `bench/results/webgpu-v2/SK-0.5.md` §2. **Class 0** — bit-identical raw `levelSetVolume`, mesh-roundtrip volume and STL bytes on every path, so under the gate regime it needs only G0 identity and no pin ceremony; that is also the whole PR argument (a representation normalization that changes nothing observable and shrinks every downstream iteration) | **spiked** |
| U22 | The offset family (`Offset`/`DoubleOffset`/`TripleOffset`, `PicoGKVdbVoxels.h:277-330`, and every C# composition on them — `voxOffset`, `voxOverOffset`, `voxFillet`, `voxSmoothen`, `voxShell`) constructs its `LevelSetFilter` locally and never touches the tracker's settings, so every offset pays the **interface-TRACKING** defaults: 3 sweeps of `HJWENO5_BIAS` per half-voxel CFL step. An offset moves the surface along its own normal by a constant and keeps the distance property by construction — upstream's own header says one low-order sweep is often enough for the analogous band dilation (`LevelSetTracker.h:115-123`). **Two asks, and the second is the bigger one.** (1) An optional settings parameter (or a `Voxels`-level knob) on the three exports; the setters are already public `LevelSetTracker` API, so this is plumbing, not new math. (2) **Change the shipped default from `HJWENO5_BIAS`×3 to `SECOND_BIAS`×3** — this is not a "we want a fast mode" request, it is a *defect report against the default*: `SECOND_BIAS`×3 is **more accurate than the current default measured against the closed form** (0.050% vs 0.094% volume error on an analytic sphere offset) **and 2.1–2.3× faster**. There is no axis on which the shipped setting wins. A knob leaves every other binding paying an inferior default forever; the default change is what makes the finding worth upstream's time. **The C# binding has the identical deficiency** — `Voxels.cs`'s offsets are P/Invokes straight to these three exports, so it inherits the defaults with no way to override | SK-0.8 (`bench/results/webgpu-v2/SK-0.8.md`), implemented here as a sibling TU (`src/pico-offset.cpp` → `Voxels_OffsetTuned`) so the vendored tree stays pristine per R4, opt-in via `fastRenorm`. Measured: renormalization is **93.9–97.5% of the offset wall** across 4 fixtures; an `HJWENO5` sweep costs **4.2×** a `FIRST_BIAS` sweep; `FIRST_BIAS` at the default 3 sweeps is **3.49–3.95×** (12 paired repeats, CI widths ≤0.02×) with `tools::checkLevelSet` still clean and ≤2.14% corrected-volume delta. Two findings worth the PR text: (a) the two knobs are not interchangeable — dropping the scheme order preserves \|∇φ\|∈[0.5,1.5], dropping `normCount` breaks it on every fixture tried, so **`HJWENO5` at 1 sweep is strictly dominated by `FIRST_BIAS` at 3** (slower AND broken AND less accurate); (b) `SECOND_BIAS` at 3 sweeps is **more accurate than the shipped default against the closed form** (0.050% vs 0.094% volume error on an analytic sphere offset) at 2.1–2.3× — strictly dominant, hence ask (2). Also recorded: plain `WENO5_BIAS` is 5–8% **slower** than `HJWENO5` and breaks the level set — a dead end, not a middle setting. **Gate-regime notes** (`NON-DETERMINISM.md` §2, §5, §6, §12.4): this row is the program's worked example of the byte gate taxing a measured win — SK-0.8's own "it is still not the default, because the default is byte-locked" is the policy under review stated as a tautology, and the accuracy result means "differs from the byte-locked path" and "worse" are different claims. `fastRenorm` is **Class 2** and its SK-0.8 gate is now the *template* for every value-changing lane (the load-bearing area metric and the hard `checkLevelSet` boolean included — it rejected 6 of 8 renorm settings that volume tolerances passed). picovoxel flips `fastRenorm` default-on in the fast lane per §12.4; the SECOND_BIAS accuracy finding goes upstream as ask (2). Offsets are also the money row for the GPU lane (renorm is 93.9–97.5% of the wall; P5 re-posed per-sweep). **Patch: `upstream/picogkruntime-offset-renorm-scheme.patch`** — the default-change half (ask 2), three inserted lines, dry-run clean against pristine `0f26321c` and against our patched tree. **Filing text ready: `upstream/pr-offset-renorm-default.md`** (SKv2-0 V0.4; posting is operator-gated). Ask (1), the settings parameter, is *not* diffed: it changes the C ABI signatures and has to be coordinated with the C# binding in leap71/PicoGK, so the API shape is the maintainers' call | **spiked** |
| U23 | `LatticeBeam::fSdvRoundCone` (`PicoGKLattice.h:115-148`, iq's sdRoundCone) is **wrong when the end spheres nest** (`(p0-p1)^2 <= (r0-r1)^2`): `a2 = l2 - (r0-r1)^2` goes negative and the formula takes `sqrtf(x2*a2*il2)` of a negative product, so the beam that is by definition the larger sphere renders as something else entirely — measured 84.21 mm3 against the closed form's 904.78 mm3 (-90.7%) with 160 `checkLevelSet` violations, where the tube-complex lane emits the exact ball (-0.37%, clean). C# inherits it verbatim (`Lattice.cs` P/Invokes into the same renderer). Fix: dispatch the nested case to the larger sphere before the round-cone algebra, exactly as openvdb does (`LevelSetTubesImpl.h:1191`) | SK-0.4 equivalence corpus (`case:nested end spheres r 6->1 L=2`, `bench/results/webgpu-v2/SK-0.4.md` section 3) + the direction-pinned differential in `test/tier2.test.mjs` (tube lane matches the closed form, serial lane does not). **Class X — wrong geometry**, so no tolerance gate reaches it and no byte pin ever would have: the serial lane is self-consistently wrong, which is the U2 failure shape (deterministic wrongness, `NON-DETERMINISM.md` §14.3(ii)) and is why the catch came from **analytic cross-scoring** against the closed form, not from a differential. Reachability after SK-0.4: here it survives only on the oracle lane (`PICOVOXEL_SERIAL_LATTICE=1`), so it is no longer a live picovoxel defect; **in C# it is unconditional**, which is where the urgency is | identified |

### OpenVDB / NanoVDB (AcademySoftwareFoundation/openvdb)

| # | Item | Evidence | Status |
| --- | --- | --- | --- |
| U8 | NanoVDB fallback scheduler deadlocks under Emscripten's fixed pthread pool (nested `std::thread` fan-out); `NANOVDB_USE_TBB` reuses the linked scheduler — document/build-guard for wasm builds | iteration-1 spike bring-up (findings doc, Finding 6) | identified |
| U9 | WGSL/WebGPU compute layer for NanoVDB (leaf transforms, grid building) — no WebGPU target exists upstream (fVDB is CUDA-only) | program frontier position; survey S7; ASWF discussions #1486/#1625 | identified (gated on program GO) |
| U10 | `volumeToMesh` scaling at small/medium grids (non-scaling serial phases: 50.2 ms ST vs 46.2 ms 12T; extend the existing disjoint-slot points pattern `:5092-5123` to polygons — per-leaf upper bound already computed `:4060-4066`) | OCCT learnings doc: bulk of the wall is PicoGK-side glue (no `reserve()`, serial passes), remainder is this upstream shape. Partly answered already: `patches/openvdb/0001-flat-quad-output.patch` (shipped, U19) adds opt-in flat quad output on the uniform path, which is the emission half of this row; it applies to pristine `7c03e1f0` and was **exonerated** of SK-0.9's corruption suspicion by SK-0.10's in-wasm sentinel probe | identified |
| U12 | Unconditional `${CMAKE_SOURCE_DIR}` references in `openvdb/openvdb/CMakeLists.txt` (:22 include, :600-603 required Half.cc source, post-13.0) break `add_subdirectory` consumers — 2-line fix (`OpenVDB_SOURCE_DIR`) | upstream-delta doc; PicoGKRuntime is the proof case; unblocks any future pin move | identified |

### oneTBB (uxlfoundation/oneTBB) + emscripten

| # | Item | Evidence | Status |
| --- | --- | --- | --- |
| U13 | wasm `machine_pause` is one `sched_yield` (JS-boundary call, delay param ignored) — exponential backoff flattens, workers over-park; fix = worker-side register spin, main-thread yield kept (the main thread's yield drains the proxy queue worker launch needs, so it must stay) | `tbb-emscripten-substrate-audit.md` + SK-0.7 A/B: **65.8 → 2.1 ns/call** (n=9/10). Patch: `patches/oneTBB/0001-wasm-substrate-edges.patch` hunk 1 (`include/oneapi/tbb/detail/_machine.h`) | **spiked** |
| U14 | External-thread steal-budget mis-derivation on emscripten (`get_stack_attributes`'s EMSCRIPTEN branch sets only `stack_base`, so the external thread's threshold comes from the *worker* stack size) — fix = `stack_size = base - emscripten_stack_get_end()` | same doc, `governor.cpp:154-163,220-223` + SK-0.7 A/B: external thread's task share at 72 KB depth **0.71× → 0.98×** of its shallow share, `can_steal` NO → yes. Note participation stayed 12/12 throughout — the loss is share, not presence. Patch: `patches/oneTBB/0001-wasm-substrate-edges.patch` hunk 2 (`src/tbb/governor.cpp`) | **spiked** |
| U15 | `TBB_EMSCRIPTEN_STACK_SIZE` is a plain `set()` in `cmake/compilers/Clang.cmake:22`, so `-DTBB_EMSCRIPTEN_STACK_SIZE=…` is silently ignored and 64 KB worker stacks are un-opt-outable — 3-line `if (NOT DEFINED …)` guard | SK-0.7: probe built with `-D…=1048576` still reported `worker_stack_size=65536`; after the guard, 1048576. We ship 1 MB (`scripts/build-deps-wasm.sh`), measured cost +10.3 MiB of pool heap. Patch: `patches/oneTBB/0001-wasm-substrate-edges.patch` hunk 3 (`cmake/compilers/Clang.cmake`) | **spiked** |

(Ours, not upstream: `-sMALLOC=mimalloc` link flag — the 113× figure is an allocation-only
microbench on 12T leaf churn against dlmalloc's global mutex, **not** a production ratio.
Measured at application scale (SK-0.1, 2026-07-26, ABAB ×20 samples/side): the win is
confined to genuinely multithreaded paths — HeatX `construct` **1.208×** (CI 1.171–1.262)
on the multi build, `io-threads.create` 4.58×, tape `mesh` 1.998× — while the single-thread
build is flat (0.991×, CI 0.974–1.024) and five small single-thread boolean stages regress
up to 21.8%. Cost: peak wasm heap 1.81× at 1.0 mm (0.866 → 1.567 GiB; a largely fixed
segment-cache overhead, falling to ~1.3× by 0.5 mm — the OOM boundary does **not** move,
both allocators clear 0.5 mm and fail at 0.4 mm). Kept as `MALLOC=` in
`scripts/build-pico-module.sh`, default `dlmalloc`. See
`bench/results/webgpu-v2/SK-0.1.md`. Also ours:
warmup-sleep → `PThread.runningWorkers` poll; `global_control(thread_stack_size)` for 64 KB
worker stacks.

**Correction, 2026-07-27 — mimalloc is exonerated and there is nothing here to file
upstream.** This paragraph used to end "the reason it is **not** the default — loss of STL
byte reproducibility at 0.5 mm: identical geometry, three different byte streams across
three multi runs", and SK-0.9 escalated that to a correctness verdict (91.9% NaN records,
one trap). **Both readings were wrong about the cause.** SK-0.10 rooted it to *our own*
TypeScript: `src/mesh.ts` (and 38 sibling sites) indexed the wasm heap views with a
**signed** shift (`pointer >> 2`). A pointer at or past 2 GiB is ≥ 2³¹, JS `>>` coerces to
int32 first, and `TypedArray.subarray` *clamps* a negative start instead of throwing — so
the readback returned a correctly-sized window one to two GiB away from the mesh, while
triangle count, volume hex and STL byte count (all computed in wasm) stayed correct.
mimalloc's only role was **placing** the 120 MB triangle staging buffer above 2 GiB where
dlmalloc happened to place it below; a 400 MiB ballast reproduces the identical corruption
on the dlmalloc build. Fixed with `>>>` at 39 sites, pinned by a source-invariant guard in
`test/surface-manifest.test.ts` (a behavioural test would need a 2.8 GiB heap). **Re-verdict:
mimalloc multi is Class 0 — byte-identical to the dlmalloc single-thread reference at
0.5/0.6/0.7 mm, 5 runs each; 32 runs total, four byte streams, exactly one per (cell, lane).**
The 1.208× is spendable pending the exit-baseline measurement, and the flip is gated on that
alone (`NON-DETERMINISM.md` §5, §11.1, §11.2, §12.3; `bench/results/webgpu-v2/SK-0.10.md`).
The one upstream-facing fragment of this lesson is filed as **U24**; the rest is ours.)

### emscripten (emscripten-core/emscripten)

| # | Item | Evidence | Status |
| --- | --- | --- | --- |
| U16 | `cwrap`'s fast-path predicate omits `'bigint'` (`src/lib/libccall.js:148`): `numericArgs` accepts only `'number'`/`'boolean'`, so **one i64 argument demotes the binding to `ccall`** — string-keyed `getCFunc` re-resolution, a per-call converter loop and stack save/restore — even though a BigInt needs no marshalling at all under `-sWASM_BIGINT`, which is **default-on** (`src/settings.js:1475`). Two-token fix: add `\|\| type === 'bigint'`. Same block, second defect: `numericRet` is only `returnType !== 'string'`, so a boolean-returning export with numeric args takes the fast path and returns a raw **i32**, while the identical `ccall` returns `Boolean(ret)` (`:59`) — cwrap and ccall disagree on the same signature. Third: the fast path is `#if !ASSERTIONS`, so debug builds marshal every call | measured here (SK-0.2, emsdk 5.0.1): **143 of 147** PicoGK exports take a handle and were therefore all on the slow path; `Lattice_AddBeam` 154.3 ns via cwrap→ccall vs **56.4 ns** direct, `Voxels_bIsEmpty` 99.4 → 34.7 ns — a 2.7–2.9× per-call tax on a binding that needed no conversion. `bench/results/webgpu-v2/SK-0.2.md`. **Patch: `upstream/emscripten-cwrap-bigint.patch`** (dry-run clean against emscripten 5.0.1 as installed by emsdk) — it fixes defects 1 and 2; defect 3 (`#if !ASSERTIONS`) is left described, because "debug and release builds have different per-call semantics" is a maintainer policy question, not a two-token fix. We work around all three by binding the raw exports directly, so nothing here is on our critical path — this row is a contribution, not a need | identified |
| U24 | Six hand-written heap indexings in the WebGL libraries use a **signed** shift and so are wrong above 2 GiB: `src/lib/libwebgl.js:3019,3028,3037,3046` (`glVertexAttrib{1,2,3,4}fv`) and `src/lib/libwebgl2.js:881,889` (`glVertexAttribI4{i,ui}v`). Emscripten's own codegen already knows the rule — `getHeapOffset` (`src/parseTools.mjs:399-410`) emits `>>>` whenever `CAN_ADDRESS_2GB` is set, which `tools/link.py:1680-1681` sets automatically for `MAXIMUM_MEMORY > 2GB` — so these are stragglers that bypass the macro; `glUniformMatrix4x3fv` five lines above one of them uses `{{{ getHeapOffset(…) }}}` correctly. Fix: `>>` → `>>>` at those sites (no-op below 2 GiB, correct above) | **Our lesson, their stragglers — the split is the honest part of this row.** SK-0.10 (`bench/results/webgpu-v2/SK-0.10.md`) spent a spike rooting a silent mesh corruption to exactly this class in *our* glue: `HEAPU32.subarray(pointer >> 2, …)` on a 120 MB staging buffer the allocator placed above 2 GiB; `subarray` clamps a negative start instead of throwing, so the read succeeded and every cheap invariant (element count, byte count, volume hex) still passed. That part is a picovoxel defect, not an emscripten one, and is recorded in the mimalloc note above — emscripten's generated code was never wrong. What *is* upstream's is the six-line straggler set, which is a real defect of the same class in shipped library JS. Nothing broader is filable: there is no docs tree in the emsdk install to patch, and a lint for "hand-written glue must not index heap views with `>>`" is a proposal we have not designed. **Patch: `upstream/emscripten-heap-index-signed-shift.patch`** (dry-run clean against emscripten 5.0.1 as installed by emsdk) | identified |

### emdawnwebgpu (google/dawn, `src/emdawnwebgpu`)

| # | Item | Evidence | Status |
| --- | --- | --- | --- |
| U11a | `HEAPU8.fill` end-index bug in mapped-shadow zeroing (`library_webgpu.js:1040` — no-op as written; writable shadows start as heap garbage) | port-internals audit; 1-line fix; crbug component known | identified |
| U11b | Asyncify futures-table growth (wrapper promise per async op, deleted only by a WaitAny race winner — unbounded in long sessions) | port-internals audit; ~3-line fix | identified |
| U11c | Asyncify-free build hygiene (preprocess out `emwgpuWaitAny` timed-wait plumbing — upstream's own TODO, crbug.com/377760848) | port-internals audit; upstream-first | identified |

Note: a "bulk write path" patch was assessed and **rejected** — `wgpuQueueWriteBuffer` already adds zero copies over the browser-inherent snapshot (`docs/research/emdawnwebgpu-memory-boundary-audit.md`).

## Deliberately not on this surface

`Viewer/*` (browser rendering is `picovoxel/three` + your scene), `Library.Go()` and the global registry, `Shapes/` 2D paths/contours + `OrientedPath` (deferred until any consumer adopts them; the 3D `Frame3d` is ported — see `picovoxel/numerics`), Skia imaging / `LogFile` / `Animation` / `Csv` / `TgaIo` (platform natives replace them), `MeshMath.bFindTriangleFromSurfacePoint` (use `bounds()` + an external BVH).
