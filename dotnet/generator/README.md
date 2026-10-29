# Signed-distance tape generator

A browser SDF callback costs one managed transition per voxel and pins the fill to the calling thread,
because an `addFunction` entry exists only in the thread that registered it. A tape crosses the boundary
once as data and is then evaluated in-module on every thread by `src/pico-tape.cpp`. This generator closes
the gap for C# authors: it reads an unchanged author's `fSignedDistance` and, where it can prove the tape
produces the identical result, emits a registration that rebuilds the same arithmetic as a tape.

Nothing the author wrote is rewritten. A source generator cannot add members to a type it does not own, and
asking every author to mark their field types `partial` is not a migration anyone would accept, so the
generated code is a separate registry: one build method per eligible type, reading that type's fields
through `UnsafeAccessor` and emitting `PicoGK.SdfTapeBuilder` calls. A type the generator refuses is
absent from the registry, and `Voxels.TauRenderImplicit` keeps serving it through the callback.

The registry's
`Register` entry point is invoked explicitly once the author's assembly is loaded, so no author static
constructor runs to install it, and it is emitted even when it is empty so that call needs no condition.

## What "identical" means here

The evaluator reads each coordinate as `(double) fToMM(voxel)`, evaluates every operation in `double`, and
rounds the final register to `float` once. An author's method has exactly those semantics when its
coordinate-dependent arithmetic is `double` throughout and its result is cast to `float` at the root — which
is how LEAP 71's own ShapeKernel fields are written: they widen each coordinate into a `double` local and
then use `Math.Sin` and friends, which take and return `double`.

So the admitted shape is narrow on purpose:

- A body of single-assignment locals followed by one `return`, whose expression is one `(float)` cast.
- Coordinate-dependent steps whose converted type is `double`. A `float` step rounds where the tape does
  not, so it is refused rather than approximated.
- Coordinate-independent subtrees of literals, locals, the author's own fields and `System.Math` or
  `System.MathF` calls. These are evaluated once per invocation by the author's own C# arithmetic and enter
  the tape as constants, so nothing about them has to be mirrored — but the restriction keeps an invocation
  from running arbitrary author code.
- Operations whose equality is established rather than assumed: `+ - * /` and unary `-` (IEEE-754 correctly
  rounded in both), `Math.Abs` and `Math.Floor` (exact in both), `Math.Sqrt` (correctly rounded in both), and
  `Math.Sin` and `Math.Cos` (the same musl routines back both sides of the wasm build, and the recorded
  gyroid witness reproduces the historical mesh digest through them).

`Math.Min`, `Math.Max`, `Math.Pow`, `Math.Exp`, `Math.Log` and `%` have tape opcodes but are **not** admitted.
The tape's min and max follow `std::min`'s choices on NaN and signed zero rather than .NET's, its `mod` is the
floored GLSL form rather than C#'s truncated `%`, and no witness yet establishes identity for the remaining
transcendentals. Widening the admitted set is an evidence change, not a code change.

Giving the tape a round-to-float opcode would admit the whole class of `float` coordinate arithmetic in one
step, and is the obvious next move — but it changes picovoxel's published expression ABI, so it is not this
generator's to make.

## Diagnosing a fallback

The generated file names every candidate it refused and why, as comments at the top:

```csharp
// Evaluated as a callback — ImplicitThing: `vecPt.X * m_fFrequency` depends on the coordinate but is not evaluated in double
```

`dotnet/tests/sdf-generator` qualifies the decision without a wasm build: each case compiles author source
with the generator and compares the lifted tape against the author's own method bit for bit, through a
reference evaluator that mirrors `dEvalOne`.
