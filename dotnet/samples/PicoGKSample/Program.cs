// SPDX-License-Identifier: Apache-2.0
// One author source for both targets: no conditional compilation, no target-specific API.
using System.Numerics;
using PicoGK;

/// <summary>
/// A gyroid shell, written the way LEAP 71's ShapeKernel writes one: every coordinate-dependent
/// step is evaluated in double, under a single cast to float at the root.
/// </summary>
/// <remarks>
/// That shape is what makes the method liftable. A browser build's generator reads these private
/// fields and emits a tape the engine evaluates directly; a desktop build calls the method itself.
/// Both evaluate the same arithmetic in the same order, so both produce the same bytes.
/// </remarks>
public sealed class GyroidShell(double dFrequency, double dThickness) : IImplicit
{
    private readonly double m_dFrequency = dFrequency;
    private readonly double m_dThickness = dThickness;

    public float fSignedDistance(in Vector3 vec)
    {
        double dX = vec.X;
        double dY = vec.Y;
        double dZ = vec.Z;
        double dDist =
            Math.Sin(dX * m_dFrequency) * Math.Cos(dY * m_dFrequency)
            + Math.Sin(dY * m_dFrequency) * Math.Cos(dZ * m_dFrequency)
            + Math.Sin(dZ * m_dFrequency) * Math.Cos(dX * m_dFrequency);
        return (float)(Math.Abs(dDist) - 0.5 * m_dThickness);
    }
}

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("Usage: PicoGKSample <output directory>");
            return 2;
        }
        Directory.CreateDirectory(args[0]);
        using var library = new Library(0.5f);
        Library.RegisterGlobalLibrary(library);
        try
        {
            var bounds = new BBox3(new Vector3(-20f, -20f, -20f), new Vector3(20f, 20f, 20f));
            using var voxels = new Voxels(new GyroidShell(0.25, 0.6), bounds);
            using var mesh = voxels.mshAsMesh();
            mesh.SaveToStlFile(Path.Combine(args[0], "gyroid.stl"));
            Console.WriteLine($"SAMPLE vertices {mesh.nVertexCount()} triangles {mesh.nTriangleCount()}");
            return 0;
        }
        finally
        {
            Library.UnregisterGlobalLibrary();
        }
    }
}
