// SPDX-License-Identifier: Apache-2.0
#if PICOGK_BROWSER
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;

namespace PicoGK;

// Each operation owns a GC handle until native code returns. Trampolines contain
// managed errors and native code returns a status before the original error is
// rethrown. There is no process-wide active author callback.
internal static unsafe class BrowserCallbacks
{
    private sealed class Context(object callback)
    {
        internal readonly object Callback = callback;
        internal ExceptionDispatchInfo? Error;
    }
    private static Context Get(nint token) => (Context)GCHandle.FromIntPtr(token).Target!;
    private static int Fail(Context context, Exception error)
    {
        context.Error ??= ExceptionDispatchInfo.Capture(error);
        return 1;
    }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static int Sdf(nint token, Vector3* point, float* value)
    {
        var context = Get(token);
        try { *value = ((IImplicit)context.Callback).fSignedDistance(in *point); return 0; }
        catch (Exception error) { return Fail(context, error); }
    }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static int Scalar(nint token, Vector3* point, float value)
    {
        var context = Get(token);
        try { ((ITraverseScalarField)context.Callback).InformActiveValue(in *point, value); return 0; }
        catch (Exception error) { return Fail(context, error); }
    }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static int Vector(nint token, Vector3* point, Vector3* value)
    {
        var context = Get(token);
        try { ((ITraverseVectorField)context.Callback).InformActiveValue(in *point, in *value); return 0; }
        catch (Exception error) { return Fail(context, error); }
    }
    private static void Check(int status, Context context, string owner)
    {
        context.Error?.Throw();
        if (status == 3) throw new ArgumentException("PicoGK callback operation received invalid bounds or input.");
        if (status == 4) throw new ObjectDisposedException(owner);
        if (status != 0) throw new InvalidOperationException($"PicoGK browser callback operation failed (status {status}).");
    }
    internal static void Render(LibHandle lib, VoxHandle vox, in BBox3 bounds, IImplicit callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        var context = new Context(callback); var handle = GCHandle.Alloc(context);
        try { Check(RenderNative(lib, vox, in bounds, GCHandle.ToIntPtr(handle), &Sdf), context, nameof(Voxels)); }
        finally { handle.Free(); }
    }
    internal static void Intersect(LibHandle lib, VoxHandle vox, IImplicit callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        var context = new Context(callback); var handle = GCHandle.Alloc(context);
        try { Check(IntersectNative(lib, vox, GCHandle.ToIntPtr(handle), &Sdf), context, nameof(Voxels)); }
        finally { handle.Free(); }
    }
    internal static void Traverse(LibHandle lib, ScalarFieldHandle field, ITraverseScalarField callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        var context = new Context(callback); var handle = GCHandle.Alloc(context);
        try { Check(ScalarNative(lib, field, GCHandle.ToIntPtr(handle), &Scalar), context, nameof(ScalarField)); }
        finally { handle.Free(); }
    }
    internal static void Traverse(LibHandle lib, VectorFieldHandle field, ITraverseVectorField callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        var context = new Context(callback); var handle = GCHandle.Alloc(context);
        try { Check(VectorNative(lib, field, GCHandle.ToIntPtr(handle), &Vector), context, nameof(VectorField)); }
        finally { handle.Free(); }
    }
    [DllImport(Config.strPicoGKLib, EntryPoint = "PicoDotNet_RenderImplicit", CallingConvention = CallingConvention.Cdecl)]
    private static extern int RenderNative(LibHandle lib, VoxHandle vox, in BBox3 bounds, nint context, delegate* unmanaged[Cdecl]<nint, Vector3*, float*, int> callback);
    [DllImport(Config.strPicoGKLib, EntryPoint = "PicoDotNet_IntersectImplicit", CallingConvention = CallingConvention.Cdecl)]
    private static extern int IntersectNative(LibHandle lib, VoxHandle vox, nint context, delegate* unmanaged[Cdecl]<nint, Vector3*, float*, int> callback);
    [DllImport(Config.strPicoGKLib, EntryPoint = "PicoDotNet_TraverseScalar", CallingConvention = CallingConvention.Cdecl)]
    private static extern int ScalarNative(LibHandle lib, ScalarFieldHandle field, nint context, delegate* unmanaged[Cdecl]<nint, Vector3*, float, int> callback);
    [DllImport(Config.strPicoGKLib, EntryPoint = "PicoDotNet_TraverseVector", CallingConvention = CallingConvention.Cdecl)]
    private static extern int VectorNative(LibHandle lib, VectorFieldHandle field, nint context, delegate* unmanaged[Cdecl]<nint, Vector3*, Vector3*, int> callback);
}
#endif
