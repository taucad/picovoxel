# Same-source samples

`PicoGKSample/Program.cs` is one author source with no conditional compilation.
`Desktop.csproj` builds it against the managed base as the native runtime loads
it. `Browser.csproj` builds the same file against the same base with
`PICOGK_BROWSER`, and resolves the package's signed-distance generator as an
ordinary analyzer, so the build emits a tape registration for the sample's own
implicit.

The gyroid shell is written the way LEAP 71's ShapeKernel writes one: each
coordinate-dependent step in `double`, under a single cast to `float` at the
root. That shape is what makes the method liftable. Changing one step to `float`
arithmetic does not break the build; it makes the generator refuse the method
and leaves a comment in the generated file saying why, and the browser target
then evaluates it through the per-voxel callback instead.

A host that compiles author source at run time drives the generator explicitly
rather than resolving it from disk. Both paths produce the same registration
from the same source.

`dotnet/test-package.mjs` builds both targets from a local-feed-only restore.
Running the desktop sample needs LEAP 71's shipped native library, and the
browser sample's native link needs the viewer imports stubbed by a patch this
package does not own, so neither target is executed here: the executed browser
target is the host that consumes this package.
