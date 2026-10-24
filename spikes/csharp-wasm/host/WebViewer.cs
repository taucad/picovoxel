// The web platform shim for PicoGK's Viewer. The desktop Viewer drives a GLFW window
// through the runtime's Viewer_* exports, which the wasm core does not carry; this
// class keeps the same public surface and records what a program shows, so a web
// host can hand the meshes to three.js. Programs compile against it unchanged.
using System.Numerics;

namespace PicoGK
{
    public partial class Viewer : IDisposable
    {
        public record Shown(string strKind, object oObject, int nGroupID);

        public readonly List<Shown> aoShown = new();
        public readonly Dictionary<int, (ColorFloat clr, float fMetallic, float fRoughness)> oMaterials = new();

        public Viewer(string strTitle, Vector2 vecSize, ILog xLog) { m_xLog = xLog; }

        readonly ILog m_xLog;

        public bool bPoll() => false;
        public bool bIsIdle() => true;
        public void RequestUpdate() { }
        public void LoadLightSetup(string strFilePath) { }
        public void LoadLightSetup(Stream oStream) { }
        public void Add(in Voxels vox, int nGroupID = 0) => aoShown.Add(new("voxels", vox, nGroupID));
        public void Add(Mesh msh, int nGroupID = 0) => aoShown.Add(new("mesh", msh, nGroupID));
        public void Add(PolyLine oPoly, int nGroupID = 0) => aoShown.Add(new("polyline", oPoly, nGroupID));
        public void Remove(Voxels vox) => aoShown.RemoveAll(s => ReferenceEquals(s.oObject, vox));
        public void Remove(Mesh msh) => aoShown.RemoveAll(s => ReferenceEquals(s.oObject, msh));
        public void Remove(PolyLine oPoly) => aoShown.RemoveAll(s => ReferenceEquals(s.oObject, oPoly));
        public void RemoveAllObjects() => aoShown.Clear();
        public void RequestScreenShot(string strScreenShotPath) { }
        public void SetGroupMaterial(int nGroupID, ColorFloat clr, float fMetallic, float fRoughness)
            => oMaterials[nGroupID] = (clr, fMetallic, fRoughness);
        public void SetGroupMatrix(int nGroupID, Matrix4x4 mat) { }
        public void SetGroupVisible(int nGroupID, bool bVisible) { }
        public void SetGroupStatic(int nGroupID, bool bStatic) { }
        public void SetBackgroundColor(ColorFloat clr) { }
        public void SetFov(float fAngle) { }
        public void SetViewAngles(float fOrbit, float fElevation) { }
        public void SetZoom(float fZoom) { }
        public void SetPerspective(bool bPerspective) { }
        public void AdjustViewAngles(float fOrbitRelative, float fElevationRelative) { }
        public void AddAnimation(Animation oAnim) { }
        public void RemoveAllAnimations() { }
        public void LogStatistics() { }
        public BBox3 oBBox()
        {
            BBox3 oBox = new();
            foreach (Shown s in aoShown)
                if (s.oObject is Voxels vox) oBox.Include(vox.mshAsMesh().oBoundingBox());
            return oBox;
        }
        public void Dispose() { }

        public class ImageQuad : IDisposable
        {
            public ImageQuad(Viewer oSetViewer, ImageRgba32 img, ColorFloat clrDefault, float fAlpha,
                             Matrix4x4 matDefault, bool bFlipX, bool bFlipY, bool bDoubleSided) { }
            public void UpdateImage(ImageRgba32 img) { }
            public void UpdateMatrix(in Matrix4x4 mat) { }
            public void Dispose() { }
        }
    }
}
