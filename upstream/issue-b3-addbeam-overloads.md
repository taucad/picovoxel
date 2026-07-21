# [DRAFT] Lattice.AddBeam has two overloads differing only in parameter order

**Repo**: leap71/PicoGK · **File**: `Base/Lattice.cs:78-114`

```csharp
public void AddBeam(in Vector3 vecA, float fRadA, in Vector3 vecB, float fRadB, bool bRoundCap = true)
public void AddBeam(in Vector3 vecA, in Vector3 vecB, float fRadA, float fRadB, bool bRoundCap = true)
```

Both overloads are live, differing only in whether the second radius argument
comes before or after the second point. Overload resolution silently picks one
based on argument types, so transposing a point and a radius compiles and
produces a subtly wrong lattice instead of an error.

Suggestion: deprecate one form (or introduce a single parameter-object/named-
argument style call). Found while porting to TypeScript (picovoxel), where the
port exposes a single options-object signature.
