// Native repro of the properties() closed-cavity caveat — `--u25`.
//
// Builds hollow spheres (outer radius 20 mm minus an inner sphere) with the
// native PicoGK runtime, headless, and compares three volumes:
//   exact        the closed form 4/3·π·(R³ − r³)
//   properties   Voxels.CalculateProperties, which meshes the field, renders
//                the mesh into fresh voxels and measures those
//   mesh         the divergence theorem over the triangles of Voxels → Mesh
// A vented case drills a capsule from the centre through the wall, so the
// cavity is open to the outside through a channel of the given width.
//
// Usage:
//   NativeHeatX --u25 --out <results.jsonl>
// One JSONL record per case; the table is printed as well.

using System.Globalization;
using System.Numerics;
using System.Text.Json;
using PicoGK;

internal static class U25Repro
{
    private const float OuterRadius = 20f;

    public static int Run(string[] args)
    {
        int i = Array.IndexOf(args, "--out");
        string strOut = i >= 0 && i + 1 < args.Length ? args[i + 1] : "u25-native.jsonl";

        foreach (float fVoxelMM in new[] { 1.0f, 0.5f })
        {
            using Library lib = new(fVoxelMM);
            foreach (float fInner in new[] { 5f, 10f, 15f })
                Measure(lib, fVoxelMM, fInner, 0f, strOut);

            // Vent widths either side of the threshold the wasm probe found (2 vs 3 voxels).
            foreach (float fVentVoxels in new[] { 2f, 3f })
                Measure(lib, fVoxelMM, 15f, fVentVoxels, strOut);
        }
        return 0;
    }

    private static void Measure(Library lib, float fVoxelMM, float fInner, float fVentVoxels, string strOut)
    {
        using Voxels vox = Voxels.voxSphere(lib, Vector3.Zero, OuterRadius);
        using Voxels voxInner = Voxels.voxSphere(lib, Vector3.Zero, fInner);
        vox.BoolSubtract(voxInner);
        if (fVentVoxels > 0)
        {
            float fVentRadius = 0.5f * fVentVoxels * fVoxelMM;
            using Voxels voxVent = Voxels.voxLatticeBeam(
                lib, Vector3.Zero, fVentRadius, new Vector3(1.5f * OuterRadius, 0, 0), fVentRadius);
            vox.BoolSubtract(voxVent);
        }

        vox.CalculateProperties(out float fPropertiesVolume, out BBox3 _);

        using Mesh msh = new(vox);
        double dMeshVolume = 0, dMeshArea = 0;
        for (int n = 0; n < msh.nTriangleCount(); n++)
        {
            msh.GetTriangle(n, out Vector3 a, out Vector3 b, out Vector3 c);
            dMeshVolume += Vector3.Dot(a, Vector3.Cross(b, c)) / 6.0;
            dMeshArea += Vector3.Cross(b - a, c - a).Length() / 2.0;
        }

        double dExact = 4.0 / 3.0 * Math.PI * (Math.Pow(OuterRadius, 3) - Math.Pow(fInner, 3));
        var oRecord = new Dictionary<string, object>
        {
            ["voxelMM"] = fVoxelMM,
            ["outerMM"] = OuterRadius,
            ["innerMM"] = fInner,
            ["ventVoxels"] = fVentVoxels,
            ["exactVolume"] = Math.Round(dExact, 1),
            ["solidVolume"] = Math.Round(4.0 / 3.0 * Math.PI * Math.Pow(OuterRadius, 3), 1),
            ["propertiesVolume"] = Math.Round(fPropertiesVolume, 1),
            ["meshVolume"] = Math.Round(dMeshVolume, 1),
            ["meshArea"] = Math.Round(dMeshArea, 1),
            ["picoGKLib"] = $"{Library.strName()} {Library.strVersion()}",
            ["picoGKBuild"] = Library.strBuildInfo(),
            ["utc"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
        };
        File.AppendAllText(strOut, JsonSerializer.Serialize(oRecord) + Environment.NewLine);
        Console.WriteLine(string.Create(CultureInfo.InvariantCulture,
            $"voxel={fVoxelMM}mm inner={fInner}mm vent={fVentVoxels}vox exact={dExact:F1} " +
            $"properties={fPropertiesVolume:F1} mesh={dMeshVolume:F1} area={dMeshArea:F1}"));
    }
}
