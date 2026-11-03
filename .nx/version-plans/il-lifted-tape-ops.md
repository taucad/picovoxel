---
picovoxel: minor
---

The tape evaluator takes six new opcodes for tapes lifted from compiled .NET code: `F32` (20) rounds a value to float, `LT`, `LE` and `EQ` (21 to 23) compare two values, and `SELECT` (24) picks one of the two operands its `PAIR` (25) names. They run in the scalar, SIMD and interval evaluators alike. The expression compiler never emits them, so the tapes it builds, and their output bytes, are unchanged.

New raw exports: `Voxels_RenderImplicitTapeChecked` and `Voxels_IntersectImplicitTapeChecked` fill as their unchecked forms do but return 1, leaving the target unchanged, if any sample is not finite; `Tape_EvaluatePoints` evaluates a tape at a list of points.
