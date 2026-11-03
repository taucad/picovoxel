// SPDX-License-Identifier: Apache-2.0
// The PicoGK types SdfTape.cs names in its native declarations; this harness never calls them.
using System.Runtime.InteropServices;

namespace PicoGK
{
    public interface ITraverseScalarField { void InformActiveValue(in System.Numerics.Vector3 point, float value); }
    public interface ITraverseVectorField { void InformActiveValue(in System.Numerics.Vector3 point, in System.Numerics.Vector3 value); }
    public sealed class ScalarFieldHandle() : SafeHandle(IntPtr.Zero, true)
    {
        public override bool IsInvalid => true;
        protected override bool ReleaseHandle() => true;
    }
    public sealed class VectorFieldHandle() : SafeHandle(IntPtr.Zero, true)
    {
        public override bool IsInvalid => true;
        protected override bool ReleaseHandle() => true;
    }
    /// <summary>Only named in an exception message the harness never raises.</summary>
    public static class Voxels { }
    public static class ScalarField { }
    public static class VectorField { }
    internal static class Config { internal const string strPicoGKLib = "picogk"; }
    public sealed class LibHandle() : SafeHandle(IntPtr.Zero, true)
    {
        public override bool IsInvalid => true;
        protected override bool ReleaseHandle() => true;
    }
    public sealed class VoxHandle() : SafeHandle(IntPtr.Zero, true)
    {
        public override bool IsInvalid => true;
        protected override bool ReleaseHandle() => true;
    }
}
