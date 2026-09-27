# [DRAFT] mshCreateTransformed(vecScale, vecOffset) applies a different axis scale to each triangle corner

**Repo**: leap71/PicoGK · **File**: `Base/Mesh.cs:86-88`

```csharp
A *= vecScale.X;
B *= vecScale.Y;
C *= vecScale.Z;
```

Each triangle corner is multiplied by a _different uniform scalar_ (corner A by
`scale.X`, B by `scale.Y`, C by `scale.Z`) instead of every vertex being scaled
component-wise. For uniform scales the bug is invisible (X == Y == Z); for any
non-uniform scale the mesh is sheared per-triangle and the result depends on
vertex order within each triangle.

Expected:

```csharp
A = new Vector3(A.X * vecScale.X, A.Y * vecScale.Y, A.Z * vecScale.Z); // same for B, C
```

Found while porting the library surface to TypeScript (picovoxel); our port
implements component-wise scaling and pins it with a hand-computed test.
