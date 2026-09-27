// Interactive cutaway viewer for the upstream HelixHeatX fixture.
//
// This is the "see inside the part" tool, not a benchmark: it builds the
// fixture, subtracts a staircase-shaped cutter, and leaves the PicoGK viewer
// open (bEndAppWithTask: false) so the internal fin stacks can be inspected.
// The bench path in Program.cs is untouched -- --view branches away from it
// before any timing or JSONL work happens.
//
// Why a partial class rather than an edit upstream: HelixHeatX declares itself
// `public partial`, and its constructor and voxConstruct() are protected. The
// fixture sources compile into THIS assembly (NativeHeatX.csproj globs them),
// so extending the partial class reaches the real construction path without
// touching a byte of repos/LEAP71_HelixHeatX -- which every recorded benchmark
// arm depends on staying pristine.
//
//   dotnet bin/Release/net9.0/NativeHeatX.dll --view --voxel 0.3

using System.Globalization;
using System.Numerics;
using Leap71.CoolCube;      // HelixHeatX (the fixture, compiled into this assembly)
using Leap71.ShapeKernel;   // Sh, Cp, Uf, BaseBox, LocalFrame
using PicoGK;

namespace Leap71
{
    using ShapeKernel;

    namespace CoolCube
    {
        public partial class HelixHeatX
        {
            /// Runs upstream's own construction logic verbatim -- same previews,
            /// same screenshots, same STL export -- and hands the finished part
            /// back so a cut can be taken out of it.
            public static Voxels voxBuildPart()
            {
                HelixHeatX oCoolCube = new HelixHeatX();
                return oCoolCube.voxConstruct();
            }
        }
    }
}

internal static class Cutaway
{
    // Part bounds, measured from the exported STL rather than re-derived from
    // the constructor: X -87..87, Y -52..52, Z -4..103.
    private const float c_fXMin = -87f;
    private const float c_fXMax =  87f;
    private const float c_fYMax =  52f;
    private const float c_fZMin =  -4f;
    private const float c_fZMax = 103f;

    private static float s_fVoxelMM;
    private static int   s_nSteps;
    private static float s_fNear;
    private static float s_fFar;
    private static bool  s_bCut;
    private static string s_strWork = "";

    public static int Run(string[] args)
    {
        s_fVoxelMM  = float.Parse(Arg(args, "--voxel") ?? "0.3", CultureInfo.InvariantCulture);
        s_nSteps    = int.Parse(Arg(args, "--steps") ?? "5", CultureInfo.InvariantCulture);
        s_fNear     = float.Parse(Arg(args, "--near") ?? "40", CultureInfo.InvariantCulture);
        s_fFar      = float.Parse(Arg(args, "--far") ?? "-6", CultureInfo.InvariantCulture);
        s_bCut      = Array.IndexOf(args, "--no-cut") < 0;
        s_strWork   = Arg(args, "--work")
                        ?? Path.Combine(Path.GetTempPath(), "picogk-heatx-cutaway");

        Directory.CreateDirectory(s_strWork);

        // Library.strLogFolder is where ShapeKernel's Sh.strGetExportPath puts
        // the screenshots AND the STL -- at 0.3 mm that export is ~1.5 GB, so
        // it goes to the work dir, never ~/Documents.
        string strLog = Path.Combine(s_strWork, "PicoGK.log");

        Console.WriteLine(
            $"HeatX cutaway: voxel {s_fVoxelMM.ToString(CultureInfo.InvariantCulture)} mm, " +
            $"{(s_bCut ? $"{s_nSteps}-step cut {s_fNear}→{s_fFar} mm" : "no cut")}, work {s_strWork}");

        // bEndAppWithTask: false -- the whole point is that the window stays up
        // after the geometry is built.
        Library.Go(
            s_fVoxelMM,
            ViewTask,
            strLog,
            bEndAppWithTask: false,
            strWindowTitle: $"HelixHeatX cutaway @ {s_fVoxelMM.ToString(CultureInfo.InvariantCulture)} mm");

        return 0;
    }

    private static void ViewTask()
    {
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();

        Voxels voxPart = HelixHeatX.voxBuildPart();
        Library.Log($"cutaway: part built in {sw.Elapsed.TotalSeconds:F1} s");

        if (s_bCut)
        {
            voxPart -= voxStaircaseCutter();
            Library.Log($"cutaway: cut applied at {sw.Elapsed.TotalSeconds:F1} s");
        }

        // voxConstruct leaves its own construction previews on screen; clear
        // them so what remains is only the cut part.
        Library.oViewer().RemoveAllObjects();
        Sh.PreviewVoxels(voxPart, Cp.clrRock, 1f);

        // Face the opened side. The viewer's default orientation looks down
        // from +Z, which is straight at the part's roof -- the one direction
        // that shows none of the cut. Drag with the mouse to orbit from here.
        Library.oViewer().qOrientation = qLookFrom(
            new Vector3(0.35f, 1f, 0.45f), Vector3.UnitZ);
        Uf.Wait(0.2f);
        Library.oViewer().RequestScreenShot(Path.Combine(s_strWork, "cutaway.tga"));
        Uf.Wait(0.2f);

        Library.Log($"cutaway: ready in {sw.Elapsed.TotalSeconds:F1} s -- viewer stays open");
        Console.WriteLine($"cutaway ready in {sw.Elapsed.TotalSeconds:F1} s; close the window to exit");
    }

    /// A staircase of slabs across X, each cutting to a different depth in Y:
    /// the shallow end barely opens the shell, the deep end passes the centre
    /// line, so one view shows the fin stacks at several depths at once. Slabs
    /// overlap by half a millimetre so no seam of un-cut material survives
    /// between neighbouring steps.
    private static Voxels voxStaircaseCutter()
    {
        Voxels voxCut       = new Voxels();
        float fSlabWidth    = (c_fXMax - c_fXMin) / s_nSteps;
        float fYOuter       = c_fYMax + 10f;

        for (int i = 0; i < s_nSteps; i++)
        {
            float fT        = s_nSteps == 1 ? 0f : (float)i / (s_nSteps - 1);
            float fYCut     = s_fNear + (s_fFar - s_fNear) * fT;
            float fXCentre  = c_fXMin + (i + 0.5f) * fSlabWidth;

            // BaseBox spans [frame.z, frame.z + length] along local z, and is
            // centred on the frame in local x (width) and local y (depth).
            BaseBox oSlab = new BaseBox(
                new LocalFrame(new Vector3(fXCentre, 0.5f * (fYCut + fYOuter), c_fZMin - 10f)),
                (c_fZMax - c_fZMin) + 20f,
                fSlabWidth + 0.5f,
                fYOuter - fYCut);

            voxCut += oSlab.voxConstruct();
        }

        return voxCut;
    }

    /// The arcball puts the eye at pivot + rotate((0,0,distance), q) with up =
    /// rotate((0,1,0), q) (ViewerCamera.UpdateMatrices), so a viewing direction
    /// is expressed by building the rotation whose basis images are the frame
    /// we want and converting that -- safer than hand-deriving Euler angles.
    private static Quaternion qLookFrom(Vector3 vecEyeDir, Vector3 vecUp)
    {
        Vector3 vecF = Vector3.Normalize(vecEyeDir);
        Vector3 vecU = Vector3.Normalize(vecUp - vecF * Vector3.Dot(vecUp, vecF));
        Vector3 vecR = Vector3.Cross(vecU, vecF);

        return Quaternion.CreateFromRotationMatrix(new Matrix4x4(
            vecR.X, vecR.Y, vecR.Z, 0f,
            vecU.X, vecU.Y, vecU.Z, 0f,
            vecF.X, vecF.Y, vecF.Z, 0f,
            0f,     0f,     0f,     1f));
    }

    private static string Arg(string[] args, string strFlag)
    {
        int i = Array.IndexOf(args, strFlag);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
