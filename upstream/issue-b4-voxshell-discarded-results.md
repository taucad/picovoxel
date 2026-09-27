# [DRAFT] voxShell(fNeg, fPos, fSmooth) discards its subtraction and smoothing (copy-forms used as mutators)

**Repo**: leap71/PicoGK · **File**: `Base/Voxels.cs:680-700`

```csharp
Voxels voxInner = voxOffset(fNegOffsetMM);
if (fSmoothInnerMM > 0)
    voxInner.voxTripleOffset(fSmoothInnerMM);   // copy form — result discarded
Voxels voxOuter = voxOffset(fPosOffsetMM);
voxOuter.voxBoolSubtract(voxInner);             // copy form — result discarded
return voxOuter;                                // solid outer offset, no void
```

`voxTripleOffset` and `voxBoolSubtract` are the _pure copy_ forms — they return a
new Voxels and leave the receiver untouched — so the two-offset shell returns
the plain outer offset: no inner void is subtracted and `fSmoothInnerMM` has no
effect. The mutating forms (`TripleOffset`, `BoolSubtract`) appear intended.

The one-offset `voxShell(float)` (Voxels.cs:659-668) is unaffected.

Found while porting to TypeScript (picovoxel); our `shell({ inner, outer,
smoothInner })` implements the documented intent and tests that smoothing
actually changes the result.
