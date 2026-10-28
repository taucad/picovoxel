using System.Numerics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using PicoGK;

if (args.Length != 2) throw new ArgumentException("Expected native library and output directory");
string native = Path.GetFullPath(args[0]);
string output = Path.GetFullPath(args[1]);
Directory.CreateDirectory(output);
NativeLibrary.SetDllImportResolver(typeof(Library).Assembly, (name, assembly, path) =>
    name == "picogk.26.2" ? NativeLibrary.Load(native) : IntPtr.Zero);

// Compile-time consumer coverage: the desktop public handle signatures remain IntPtr.
#if PICOGK_BROWSER
VdbMetaHandle meta = new(17L);
ScalarFieldHandle scalarHandle = new(23L);
VectorFieldHandle vectorHandle = new(29L);
if (meta.Value + scalarHandle.Value + vectorHandle.Value != 69) throw new Exception("Browser handle mismatch");
#else
VdbMetaHandle meta = new(new IntPtr(17));
ScalarFieldHandle scalarHandle = new(new IntPtr(23));
VectorFieldHandle vectorHandle = new(new IntPtr(29));
IntPtr[] handleValues = [meta.Value, scalarHandle.Value, vectorHandle.Value];
if (handleValues.Select(v => v.ToInt64()).Sum() != 69) throw new Exception("Handle consumer mismatch");

#endif

using var lib = new Library(0.5f);
var sphere = new Sphere();
using var vox = new Voxels(lib);
vox.RenderImplicit(sphere, new BBox3(new Vector3(-7), new Vector3(7)));
vox.IntersectImplicit(new Sphere(5));
vox.CalculateProperties(out float volume, out BBox3 bounds);
using var mesh = vox.mshAsMesh();
mesh.SaveToStlFile(Path.Combine(output, "sphere.stl"));
using var stream = new MemoryStream();
using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, true))
{
    writer.Write(mesh.nVertexCount()); writer.Write(mesh.nTriangleCount());
    for (int i = 0; i < mesh.nVertexCount(); i++)
    {
        var p = mesh.vecVertexAt(i); writer.Write(p.X); writer.Write(p.Y); writer.Write(p.Z);
    }
    for (int i = 0; i < mesh.nTriangleCount(); i++)
    {
        var t = mesh.oTriangleAt(i); writer.Write(t.A); writer.Write(t.B); writer.Write(t.C);
    }
}
File.WriteAllBytes(Path.Combine(output, "mesh.bin"), stream.ToArray());

using var scalar = new ScalarField(lib);
scalar.SetValue(Vector3.Zero, 3.25f); scalar.SetValue(new Vector3(1, 0, 0), -2.5f);
var scalarVisitor = new ScalarVisitor(); scalar.TraverseActive(scalarVisitor);
if (scalarVisitor.Count != 2 || scalarVisitor.Sum != 0.75f) throw new Exception("Scalar traversal mismatch");
using var vector = new VectorField(lib);
vector.SetValue(Vector3.Zero, new Vector3(1, 2, 3));
var vectorVisitor = new VectorVisitor(); vector.TraverseActive(vectorVisitor);
if (vectorVisitor.Count != 1 || vectorVisitor.Sum != new Vector3(1, 2, 3)) throw new Exception("Vector traversal mismatch");
using (var file = new OpenVdbFile(lib))
{
    file.nAdd(vox, "sphere"); file.nAdd(scalar, "scalar"); file.nAdd(vector, "vector");
    file.SaveToFile(Path.Combine(output, "fields.vdb"));
}
using (var file = new OpenVdbFile(lib, Path.Combine(output, "fields.vdb")))
{
    if (file.nFieldCount() != 3) throw new Exception("VDB field count mismatch");
    using var restored = file.oGetScalarField("scalar");
    if (!restored.bGetValue(Vector3.Zero, out float value) || value != 3.25f) throw new Exception("VDB scalar mismatch");
}
#if PICOGK_BROWSER
// Reentry must preserve the outer callback context, and a thrown author error
// must return through native status before it is rethrown on the managed side.
using (var nestedVoxels = new Voxels(lib))
{
    var nested = new NestedSphere(lib);
    nestedVoxels.RenderImplicit(nested, new BBox3(new Vector3(-3), new Vector3(3)));
    if (!nested.Nested || nested.Count < 2) throw new Exception("Nested SDF did not resume");
}
var expected = new InvalidOperationException("author callback failure");
void ExpectFailure(Action action)
{
    try { action(); throw new Exception("Callback error was lost"); }
    catch (InvalidOperationException error) when (ReferenceEquals(error, expected)) { }
}
using (var failed = new Voxels(lib))
    ExpectFailure(() => failed.RenderImplicit(new ThrowingSphere(expected), new BBox3(new Vector3(-2), new Vector3(2))));
ExpectFailure(() => vox.IntersectImplicit(new ThrowingSphere(expected)));
ExpectFailure(() => scalar.TraverseActive(new ThrowingScalar(expected)));
ExpectFailure(() => vector.TraverseActive(new ThrowingVector(expected)));
var recovered = new ScalarVisitor(); scalar.TraverseActive(recovered);
if (recovered.Count != 2) throw new Exception("Callback context did not recover");
Parallel.For(0, 8, i => {
    using var concurrentLib = new Library(1f);
    using var concurrentVox = new Voxels(concurrentLib);
    var callback = new NestedSphere(concurrentLib);
    concurrentVox.RenderImplicit(callback, new BBox3(new Vector3(-3), new Vector3(3)));
    if (!callback.Nested || callback.Count < 2) throw new Exception("Concurrent context mismatch");
});
File.WriteAllText(Path.Combine(output, "callback-status.json"), "{\"nested\":true,\"errorsContained\":4,\"recovered\":true,\"concurrentCalls\":8}");
#endif
var api = typeof(Library).Assembly.GetExportedTypes().OrderBy(t => t.FullName, StringComparer.Ordinal)
    .SelectMany(t => new[] { $"TYPE {t.FullName} {t.Attributes} {t.BaseType}" }
        .Concat(t.GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Select(m => $"{t.FullName} {m.MemberType} {m}")))
    .OrderBy(s => s, StringComparer.Ordinal).ToArray();
File.WriteAllLines(Path.Combine(output, "public-api.txt"), api);
var result = new { runtime = Library.strVersion(), name = Library.strName(),
    triangles = mesh.nTriangleCount(), vertices = mesh.nVertexCount(), volumeBits = BitConverter.SingleToUInt32Bits(volume),
    meshSha256 = Convert.ToHexStringLower(SHA256.HashData(stream.ToArray())),
    stlSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(output, "sphere.stl")))),
    scalarCallbacks = scalarVisitor.Count, vectorCallbacks = vectorVisitor.Count, implicitCallbacks = sphere.Count,
    handleWidth = Marshal.SizeOf<ScalarFieldHandle>(), apiMembers = api.Length };
File.WriteAllText(Path.Combine(output, "result.json"), JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(result));

sealed class Sphere(float radius = 6) : IImplicit
{
    public int Count;
    public float fSignedDistance(in Vector3 p) { Count++; return p.Length() - radius; }
}
sealed class ScalarVisitor : ITraverseScalarField
{
    public int Count; public float Sum;
    public void InformActiveValue(in Vector3 p, float value) { Count++; Sum += value; }
}
sealed class VectorVisitor : ITraverseVectorField
{
    public int Count; public Vector3 Sum;
    public void InformActiveValue(in Vector3 p, in Vector3 value) { Count++; Sum += value; }
}

#if PICOGK_BROWSER
sealed class NestedSphere(Library lib) : IImplicit
{
    public int Count; public bool Nested;
    public float fSignedDistance(in Vector3 p)
    {
        Count++;
        if (!Nested) { Nested = true; using var inner = new Voxels(lib); inner.RenderImplicit(new Sphere(1), new BBox3(new Vector3(-2), new Vector3(2))); }
        return p.Length() - 2;
    }
}
sealed class ThrowingSphere(Exception error) : IImplicit
{
    public float fSignedDistance(in Vector3 p) => throw error;
}
sealed class ThrowingScalar(Exception error) : ITraverseScalarField
{
    public void InformActiveValue(in Vector3 p, float value) => throw error;
}
sealed class ThrowingVector(Exception error) : ITraverseVectorField
{
    public void InformActiveValue(in Vector3 p, in Vector3 value) => throw error;
}
#endif
