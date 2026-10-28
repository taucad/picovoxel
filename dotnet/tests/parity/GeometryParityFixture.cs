// SPDX-License-Identifier: Apache-2.0
// Test backend only: run pinned, unchanged examples and capture exact geometry.
using System.Numerics;
using PicoGK;
using PicoGK.Numerics;

public static class GeometryParityFixture
{
    public static void Run(string[] args)
    {
        if (args.Length != 2 || args[1] is not ("gyroid" or "heatx"))
            throw new ArgumentException("Expected output directory and gyroid or heatx");
        string output = Path.GetFullPath(args[0]);
        bool heatx = args[1] == "heatx";
        Directory.CreateDirectory(output);
        string previousDirectory = Directory.GetCurrentDirectory();
        using var library = new Library(0.5f);
        var log = new LogConsole();
        var backend = new ParityCapture(output, captureAll: !heatx);
        using var viewer = new Viewer(backend, log);
        Library.RegisterGlobalLibrary(library);
        Library.RegisterGlobalLog(log);
        Library.RegisterGlobalViewer(viewer);
        try
        {
            Directory.SetCurrentDirectory(output);
            if (heatx) Leap71.CoolCube.HelixHeatX.Task();
            else Leap71.ShapeKernelExamples.ImplicitGyroidSphere.Task();
            viewer.bPoll();
            if (backend.Count == 0) throw new Exception("No geometry captured");
            if (heatx)
            {
                using var final = backend.LastVoxels?.mshAsMesh()
                    ?? throw new Exception("Final HeatX voxels missing");
                ParityCapture.WriteRaw(final, Path.Combine(output, "final.mesh"));
            }
            Console.WriteLine("EXAMPLE_PASS " + backend.Count);
        }
        finally
        {
            Library.UnregisterGlobalViewer();
            Library.UnregisterGlobalLog();
            Library.UnregisterGlobalLibrary();
            Directory.SetCurrentDirectory(previousDirectory);
        }
    }
}

sealed class ParityCapture(string output, bool captureAll) : IViewerBackend
{
    public int Count;
    public Voxels? LastVoxels;
    public bool IsIdle => true;
    public Quaternion Orientation { get; set; }
    public void Dispose() { }
    public bool Poll() => true;
    public BBox3 GetBoundingBox() => new();

    public void Add(Voxels vox, int groupId)
    {
        LastVoxels = vox;
        if (!captureAll) { Count++; return; }
        using var mesh = vox.mshAsMesh();
        Save(mesh);
    }
    public void Add(Voxels vox, string name, int groupId) => Add(vox, groupId);

    private void Save(Mesh mesh)
    {
        int index = Count++;
        if (!captureAll) return;
        string name = Path.Combine(output, "capture-" + index);
        mesh.SaveToStlFile(name + ".stl");
        WriteRaw(mesh, name + ".mesh");
    }

    public static void WriteRaw(Mesh mesh, string path)
    {
        using var writer = new BinaryWriter(File.Create(path));
        writer.Write(mesh.nVertexCount());
        writer.Write(mesh.nTriangleCount());
        for (int i = 0; i < mesh.nVertexCount(); i++)
        {
            var point = mesh.vecVertexAt(i);
            writer.Write(point.X); writer.Write(point.Y); writer.Write(point.Z);
        }
        for (int i = 0; i < mesh.nTriangleCount(); i++)
        {
            var triangle = mesh.oTriangleAt(i);
            writer.Write(triangle.A); writer.Write(triangle.B); writer.Write(triangle.C);
        }
    }
    public void RequestUpdate() {}
    public void LoadLightSetup(byte[] abyDiffuseDds, byte[] abySpecularDds) {}
    public void SetBackgroundColor(ColorFloat color) {}
    public void SetFieldOfView(float radians) {}
    public void ZoomToFit() {}
    public void Remove(Voxels vox) {}
    public void SetObjectMatrix(Voxels vox, Matrix4x4 mat) {}
    public void Add(Mesh msh, int nGroupID) => Save(msh);
    public void Add(Mesh msh, string name, int nGroupID) => Save(msh);
    public void Remove(Mesh msh) {}
    public void SetObjectMatrix(Mesh msh, Matrix4x4 mat) {}
    public void Add(PolyLine poly, int nGroupID) {}
    public void Add(PolyLine poly, string name, int nGroupID) {}
    public void Remove(PolyLine poly) {}
    public void SetObjectMatrix(PolyLine poly, Matrix4x4 mat) {}
    public void RemoveAllObjects() {}
    public void SetMechanism(object source) {}
    public void RequestScreenShot(string strScreenShotPath) {}
    public void EnableExperimental(bool bEnable) {}
    public void SetGroupVisible(int nGroupID, bool bVisible) {}
    public void SetGroupMaterial(int nGroupID, ColorFloat clr, float fMetallic, float fRoughness) {}
    public void SetGroupMaterial(int groupId, Material material) {}
    public void SetGroupMatrix(int nGroupID, Matrix4x4 mat) {}
    public void EnableOverhangWarning(int nGroupID, Overhang uWarning, Overhang uError) {}
    public void DisableOverhangWarning(int nGroupID) {}
}
