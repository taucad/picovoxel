# [DRAFT] Library.MmToVoxels calls \_VoxelsToMm — returns the inverse conversion

**Repo**: leap71/PicoGK · **File**: `Library/Library.cs:269-283`

```csharp
public void MmToVoxels(Vector3 vecMm, out int x, out int y, out int z)
{
    Vector3 vecResult = Vector3.Zero;
    _VoxelsToMm(hThis, vecMm, ref vecResult);   // <- should be _MmToVoxels
    ...
}
```

`MmToVoxels` invokes the `Library_VoxelsToMm` interop entry point, so a caller
asking "which voxel index is 10 mm?" at 0.5 mm voxel size receives 5 (mm-scaled)
instead of 20 (index-scaled). The sibling `vecVoxelsToMm` is correct.

A secondary note: the `(int)(v + 0.5f)` rounding truncates toward zero, which
mis-rounds negative coordinates (−3.0 becomes −2); `MathF.Round` would round to
the nearest index on both sides of the origin.

Found while porting to TypeScript (picovoxel); our `mmToVoxel` binds
`Library_MmToVoxels` and pins negative-coordinate round-trips in tests.
