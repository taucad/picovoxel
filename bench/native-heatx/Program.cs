// Native PicoGK HelixHeatX timing harness — one run per process.
//
// What is timed: the Task delegate exactly as upstream's tutorial runs it
// (Library.Go(voxelSize, HelixHeatX.Task)), which is what the published table
// measures — voxel construction INCLUDING the viewer previews, the ten
// screenshot requests, the Uf.Wait() render pauses, and the final STL export.
// Deviating from that (e.g. skipping previews) would produce a number that is
// not comparable to the published one, which is the entire point of this run.
//
// One process per run: PicoGK allows one global library configuration at a
// time, and a fresh process also gives every run the same cold-JIT/allocator
// state instead of letting run 1 subsidise run 5.
//
// Usage:
//   NativeHeatX --voxel 0.5 --run 1 --out <results.jsonl> --work <scratch dir>

using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using PicoGK;

internal static class Program
{
    private static double s_taskSeconds = -1;
    private static string s_error = null;

    private static int Main(string[] args)
    {
        // --view is the interactive cutaway (Cutaway.cs), not a bench run: it
        // branches out before any timing, JSONL or idle-gate work happens, so
        // the benchmark path below is exactly what it was.
        if (Array.IndexOf(args, "--view") >= 0)
            return Cutaway.Run(args);

        float fVoxelMM = float.Parse(Arg(args, "--voxel") ?? "1.0", CultureInfo.InvariantCulture);
        int nRun = int.Parse(Arg(args, "--run") ?? "1", CultureInfo.InvariantCulture);
        string strOut = Arg(args, "--out") ?? "native-heatx.jsonl";
        string strWork = Arg(args, "--work") ?? Path.Combine(Path.GetTempPath(), "picogk-native-heatx");

        Directory.CreateDirectory(strWork);
        // Library.strLogFolder is the log file's directory, and ShapeKernel's
        // Sh.strGetExportPath writes every screenshot and the STL there — so
        // pointing the log at the scratch dir keeps ~1.4 GB/sweep out of
        // ~/Documents and makes cleanup a single rm -rf.
        string strLog = Path.Combine(strWork, "PicoGK.log");

        Stopwatch swProcess = Stopwatch.StartNew();
        try
        {
            Library.Go(
                fVoxelMM,
                TimedTask,
                strLog,
                bEndAppWithTask: true,
                strWindowTitle: $"HeatX {fVoxelMM.ToString(CultureInfo.InvariantCulture)}mm #{nRun}");
        }
        catch (Exception e)
        {
            s_error ??= e.ToString();
        }
        swProcess.Stop();

        string strStl = Path.Combine(strWork, "HelixHeatX.STL");
        long nStlBytes = File.Exists(strStl) ? new FileInfo(strStl).Length : -1;

        var oRecord = new Dictionary<string, object>
        {
            ["voxelMM"] = fVoxelMM,
            ["run"] = nRun,
            ["taskSeconds"] = Math.Round(s_taskSeconds, 3),
            ["processSeconds"] = Math.Round(swProcess.Elapsed.TotalSeconds, 3),
            ["stlBytes"] = nStlBytes,
            ["ok"] = s_error is null && s_taskSeconds > 0,
            ["error"] = s_error,
            ["picoGKLib"] = $"{Library.strName()} {Library.strVersion()}",
            ["picoGKBuild"] = Library.strBuildInfo(),
            // Ambient host load, captured by the sweep runner immediately
            // before this process started (see run-sweep.sh): the machine
            // could not be driven below ~12% busy during this campaign, so
            // the load rides with every record rather than being asserted
            // away. Measured contention cost on this fixture: ~2.6% at 33%
            // busy, so ~1-1.5% here.
            ["hostBusyPercentBefore"] = Environment.GetEnvironmentVariable("HEATX_HOST_BUSY") ?? "unrecorded",
            // Allocator provenance. dyldInsert is what THIS process actually
            // saw — ground truth for the allocator legs, recorded per run for
            // the same reason as the build stamp: the arm must be provable
            // from the data, not from the runner's intent.
            ["allocator"] = Environment.GetEnvironmentVariable("HEATX_ALLOC") ?? "system",
            ["dyldInsert"] = Environment.GetEnvironmentVariable("DYLD_INSERT_LIBRARIES") ?? "",
            ["processorCount"] = Environment.ProcessorCount,
            ["runtime"] = Environment.Version.ToString(),
            ["os"] = Environment.OSVersion.VersionString,
            ["utc"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
        };

        File.AppendAllText(strOut, JsonSerializer.Serialize(oRecord) + Environment.NewLine);
        Console.WriteLine(
            $"voxel={fVoxelMM.ToString(CultureInfo.InvariantCulture)}mm run={nRun} " +
            $"task={s_taskSeconds.ToString("F1", CultureInfo.InvariantCulture)}s " +
            $"process={swProcess.Elapsed.TotalSeconds.ToString("F1", CultureInfo.InvariantCulture)}s " +
            $"stl={nStlBytes}");

        return s_error is null && s_taskSeconds > 0 ? 0 : 1;
    }

    /// The Task PicoGK runs on its worker thread; the stopwatch brackets
    /// upstream's own entry point and nothing else.
    private static void TimedTask()
    {
        Stopwatch sw = Stopwatch.StartNew();
        try
        {
            Leap71.CoolCube.HelixHeatX.Task();
        }
        catch (Exception e)
        {
            s_error = e.ToString();
        }
        sw.Stop();
        s_taskSeconds = sw.Elapsed.TotalSeconds;
    }

    private static string Arg(string[] args, string strFlag)
    {
        int i = Array.IndexOf(args, strFlag);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
