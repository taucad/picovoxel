"""Second step of the headless split: PicoGK passes bound delegates (xImp.fSignedDistance)
to the runtime as callbacks. Mono on wasm cannot make a native thunk for a delegate at run
time, so the implicit callbacks become one static [UnmanagedCallersOnly] trampoline per
callback type, which the wasm build pre-generates. The public API is unchanged."""
import sys, re
root = sys.argv[1]
p = f'{root}/Internals/Interop.cs'; s = open(p).read()
s = s.replace('''        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate float CallbackImplicitDistance(in Vector3 vec);
''', '')
s = s.replace('private static extern void _RenderImplicit(', 'private static extern unsafe void _RenderImplicit(')
s = s.replace('private static extern void _IntersectImplicit(', 'private static extern unsafe void _IntersectImplicit(')
n = s.count('CallbackImplicitDistance Callback')
assert n == 2, n
s = s.replace('CallbackImplicitDistance Callback', 'delegate* unmanaged[Cdecl]<Vector3*, float> Callback')
open(p, 'w').write(s)

p = f'{root}/Base/Voxels.cs'; s = open(p).read()
old_r = '''        public void RenderImplicit( in IImplicit xImp,
                                    in BBox3 oBounds)
            => _RenderImplicit(lib.hThis, hThis, in oBounds, xImp.fSignedDistance);'''
old_i = '''        public void IntersectImplicit(in IImplicit xImp)
            => _IntersectImplicit(lib.hThis, hThis, xImp.fSignedDistance);'''
assert old_r in s and old_i in s
s = s.replace(old_r, '''        public unsafe void RenderImplicit( in IImplicit xImp,
                                    in BBox3 oBounds)
        {
            IImplicit xPrev = s_xImplicit;
            s_xImplicit = xImp;
            try { _RenderImplicit(lib.hThis, hThis, in oBounds, &fImplicitTrampoline); }
            finally { s_xImplicit = xPrev; }
        }

        // The runtime's callback carries no user pointer, so the implicit being
        // evaluated is held here for the duration of one render.
        static IImplicit s_xImplicit;

        [System.Runtime.InteropServices.UnmanagedCallersOnly(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
        static unsafe float fImplicitTrampoline(Vector3* pvec) => s_xImplicit.fSignedDistance(*pvec);''')
s = s.replace(old_i, '''        public unsafe void IntersectImplicit(in IImplicit xImp)
        {
            IImplicit xPrev = s_xImplicit;
            s_xImplicit = xImp;
            try { _IntersectImplicit(lib.hThis, hThis, &fImplicitTrampoline); }
            finally { s_xImplicit = xPrev; }
        }''')
open(p, 'w').write(s)
print('patched implicit callbacks')

# The runtime's handles are all PKHANDLE (int64). The library declares three of them as
# IntPtr, which is 64-bit on every desktop target but 32-bit on wasm32: an ABI mismatch
# that traps at the first call. Declare them as long, like the other handles.
p = f'{root}/Internals/Types.cs'; s = open(p).read()
for h in ('VdbMetaHandle', 'ScalarFieldHandle', 'VectorFieldHandle'):
    old = f'public readonly record struct {h}(IntPtr Value);'
    assert old in s, h
    s = s.replace(old, f'public readonly record struct {h}(long Value);')
open(p, 'w').write(s)
print('patched IntPtr handles')
