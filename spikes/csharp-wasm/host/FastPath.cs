// The picovoxel exports live in the same wasm module as the PicoGK runtime, so C# reaches
// them with a plain DllImport: no JS crossing. Two of them back this spike:
//  - Voxels_IntersectImplicitFast: the same C# callback, with picovoxel's corrected band.
//  - Voxels_IntersectImplicitTapeFast: the SDF as a tape (picovoxel's expression IR), evaluated
//    natively with no callback at all. The tape here is ImplicitGyroid(3, 1) as picovoxel's
//    compileSdfExpression emits it; a Roslyn generator or IL lifter would emit it from the
//    C# fSignedDistance body.
using System.Numerics;
using System.Runtime.InteropServices;
using PicoGK;

public static unsafe class FastPath
{
    [DllImport(Config.strPicoGKLib, EntryPoint = "Voxels_IntersectImplicitFast")]
    static extern void _IntersectImplicitFast(LibHandle hLib, VoxHandle hThis, delegate* unmanaged[Cdecl]<Vector3*, float> pfn);

    [DllImport(Config.strPicoGKLib, EntryPoint = "Voxels_IntersectImplicitTapeFast")]
    static extern void _IntersectImplicitTapeFast(LibHandle hLib, VoxHandle hThis, uint* pnInstr, int nInstr, double* pfConst, int nConst);

    static IImplicit s_xImplicit;

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    static float fTrampoline(Vector3* pvec) => s_xImplicit.fSignedDistance(*pvec);

    public static Voxels voxIntersectFast(Voxels vox, IImplicit xImp)
    {
        Voxels voxCopy = vox.voxDuplicate();
        s_xImplicit = xImp;
        _IntersectImplicitFast(voxCopy.lib.hThis, voxCopy.hThis, &fTrampoline);
        return voxCopy;
    }

    static class Tape
    {
    public static readonly uint[] s_anGyroidTape = { 0,0,1,0,6,65536,11,2,0,0,2,0,6,327684,12,6,6,458755,0,0,2,0,6,655369,11,11,0,0,3,0,6,917517,12,15,6,1048588,4,1114120,0,0,3,0,6,1310739,11,21,0,0,1,0,6,1572887,12,25,6,1703958,4,1769490,9,28,0,1,5,1966109 };
    public static readonly double[] s_afGyroidConst = { 2.0943951023931953, 0.5 };
    }

    public static Voxels voxIntersectGyroidTape(Voxels vox)
    {
        Voxels voxCopy = vox.voxDuplicate();
        fixed (uint* pn = Tape.s_anGyroidTape)
        fixed (double* pf = Tape.s_afGyroidConst)
            _IntersectImplicitTapeFast(voxCopy.lib.hThis, voxCopy.hThis, pn, Tape.s_anGyroidTape.Length / 2, pf, Tape.s_afGyroidConst.Length);
        return voxCopy;
    }
}
