// Web host: stands in for Library.Go. Go starts the task on a second thread and pumps
// the GLFW viewer on the first; single-threaded browser-wasm has neither, so the host
// registers the same three globals Go registers and runs the task on the main thread.
using System.Diagnostics;
using System.Runtime.InteropServices.JavaScript;
using PicoGK;

public static partial class Host
{
    // FNV-1a over every vertex and triangle, in order: equal digests mean equal mesh bytes.
    static string strMeshDigest(Mesh msh)
    {
        ulong h = 1469598103934665603UL;
        void Mix(uint n) { for (int b = 0; b < 4; b++) { h ^= (n >> (8 * b)) & 0xff; h *= 1099511628211UL; } }
        for (int i = 0; i < msh.nVertexCount(); i++)
        {
            var v = msh.vecVertexAt(i);
            Mix(BitConverter.SingleToUInt32Bits(v.X)); Mix(BitConverter.SingleToUInt32Bits(v.Y)); Mix(BitConverter.SingleToUInt32Bits(v.Z));
        }
        for (int i = 0; i < msh.nTriangleCount(); i++)
        {
            var t = msh.oTriangleAt(i);
            Mix((uint)t.A); Mix((uint)t.B); Mix((uint)t.C);
        }
        return h.ToString("x16");
    }

    public static int Main(string[] args)
    {
        float fVoxelSizeMM = args.Length > 0 ? float.Parse(args[0]) : 0.5f;
        int nRuns = args.Length > 1 ? int.Parse(args[1]) : 1;

        var swInit = Stopwatch.StartNew();
        Library oLib = new(fVoxelSizeMM);
        Library.RegisterGlobalLibrary(oLib);
        Library.RegisterGlobalLog(new LogConsole());
        Viewer oViewer = new("PicoGK", new(2000, 2000), Library.xLog());
        Library.RegisterGlobalViewer(oViewer);
        Console.WriteLine($"PicoGK: {Library.strName()} {Library.strVersion()}; voxel {fVoxelSizeMM} mm; init {swInit.Elapsed.TotalMilliseconds:F1} ms");

        for (int i = 0; i < nRuns; i++)
        {
            oViewer.RemoveAllObjects();
            var sw = Stopwatch.StartNew();
            // The LEAP 71 example, compiled from its unmodified source.
            Leap71.ShapeKernelExamples.ImplicitGyroidSphere.Task();
            double fTaskMs = sw.Elapsed.TotalMilliseconds;

            sw.Restart();
            var astrStats = new List<string>();
            foreach (var oShown in oViewer.aoShown)
            {
                if (oShown.oObject is Voxels vox)
                {
                    vox.CalculateProperties(out float fVolume, out BBox3 oBox);
                    Mesh msh = vox.mshAsMesh();
                    astrStats.Add($"group {oShown.nGroupID}: volume {fVolume:F3} mm3 (bits {BitConverter.SingleToUInt32Bits(fVolume):x8}), {msh.nTriangleCount()} triangles, mesh digest {strMeshDigest(msh)}");
                }
            }
            double fMeshMs = sw.Elapsed.TotalMilliseconds;
            Console.WriteLine($"run {i}: task {fTaskMs:F1} ms; mesh+props {fMeshMs:F1} ms");
            if (i == 0) foreach (string s in astrStats) Console.WriteLine("  " + s);
        }
        var sdfSphere = new Leap71.ShapeKernel.ImplicitSphere(new(), 10f);
        var sdfGyroid = new Leap71.ShapeKernel.ImplicitGyroid(3, 1);
        Voxels voxSphere = new(sdfSphere, new BBox3(1.2f * new System.Numerics.Vector3(-10f), 1.2f * new System.Numerics.Vector3(10f)));
        foreach (var (strName, fn) in new (string, Func<Voxels>)[] {
            ("upstream IntersectImplicit, C# callback", () => voxSphere.voxIntersectImplicit(sdfGyroid)),
            ("picovoxel IntersectImplicitFast, C# callback", () => FastPath.voxIntersectFast(voxSphere, sdfGyroid)),
            ("picovoxel IntersectImplicitTapeFast, tape", () => FastPath.voxIntersectGyroidTape(voxSphere)) })
        {
            try { fn(); } // warm
            catch (EntryPointNotFoundException) { Console.WriteLine($"{strName}: not in this runtime build"); continue; }
            var swV = Stopwatch.StartNew();
            const int nReps = 5;
            Voxels vox = null;
            for (int r = 0; r < nReps; r++) vox = fn();
            double fMs = swV.Elapsed.TotalMilliseconds / nReps;
            vox.CalculateProperties(out float fVol, out BBox3 _);
            Console.WriteLine($"{strName}: {fMs:F1} ms; volume {fVol:F3} mm3, {vox.mshAsMesh().nTriangleCount()} triangles");
        }
        // Microbenchmarks: pure managed math (the gyroid SDF, 8M points) and the managed->native
        // call cost (1M Mesh.nAddVertex P/Invokes).
        {
            var swM = Stopwatch.StartNew();
            float fSum = 0;
            for (int i = 0; i < 200; i++)
                for (int j = 0; j < 200; j++)
                    for (int k = 0; k < 200; k++)
                        fSum += sdfGyroid.fSignedDistance(new System.Numerics.Vector3(i * 0.1f, j * 0.1f, k * 0.1f));
            Console.WriteLine($"managed gyroid SDF x 8M: {swM.Elapsed.TotalMilliseconds:F1} ms (checksum {fSum:F3})");
            swM.Restart();
            Mesh msh = new(Library.oLibrary());
            for (int i = 0; i < 1_000_000; i++)
                msh.nAddVertex(new System.Numerics.Vector3(i, i, i));
            Console.WriteLine($"P/Invoke Mesh.nAddVertex x 1M: {swM.Elapsed.TotalMilliseconds:F1} ms");
        }
        return 0;
    }

}
