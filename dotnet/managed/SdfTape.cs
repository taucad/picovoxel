// SPDX-License-Identifier: Apache-2.0
#if PICOGK_BROWSER
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

namespace PicoGK;

// The managed half of the tape contract src/pico-tape.cpp evaluates, and the
// registry the generated adapter fills.
//
// A browser SDF callback costs one managed transition per voxel and pins the
// fill to the calling thread. A tape crosses the boundary once as data and is
// evaluated in-module on every thread. The generator never rewrites an author's
// method: it emits a registration that rebuilds the same arithmetic as a tape,
// and anything it cannot lift exactly is simply not registered, so the callback
// path still runs.
//
// Exactness. The evaluator reads each coordinate as `(double) fToMM(voxel)` and
// rounds the final register to float once, which is what an author's method does
// when every coordinate-dependent step is `double` and the result is cast to
// float at the root. The generator admits only that shape, so a registered tape
// is bit-identical to the callback, not merely close: see
// dotnet/generator/README.md for the admitted operation set and why each one is
// exact.

/// <summary>Builds the instruction stream for one invocation of a lifted signed-distance method.</summary>
/// <remarks>
/// Every method returns the register holding its result, which is the index of the instruction that
/// produced it. Operands must be registers this builder returned. Instances are single-use and are
/// not thread safe; the registry creates one per operation.
/// </remarks>
public sealed class SdfTapeBuilder
{
    // Opcodes are shared with src/pico-tape.cpp and src/tape.ts — never renumber.
    private const uint OpConstant = 0;
    private const uint OpX = 1;
    private const uint OpY = 2;
    private const uint OpZ = 3;
    private const uint OpAdd = 4;
    private const uint OpSubtract = 5;
    private const uint OpMultiply = 6;
    private const uint OpDivide = 7;
    private const uint OpNegate = 8;
    private const uint OpAbsolute = 9;
    private const uint OpSquareRoot = 10;
    private const uint OpSine = 11;
    private const uint OpCosine = 12;
    private const uint OpFloor = 13;

    /// <summary>Operand registers are unsigned 16-bit fields of the instruction word.</summary>
    internal const int MaximumInstructions = 0x10000;

    private readonly List<uint> words = [];
    private readonly List<double> constants = [];
    private readonly Dictionary<double, int> constantRegisters = [];

    internal SdfTapeBuilder()
    {
    }

    internal int Count => words.Count / 2;

    internal uint[] Instructions() => [.. words];

    internal double[] Constants() => [.. constants];

    /// <summary>A constant the author's own arithmetic produced for this invocation.</summary>
    public int Constant(double value)
    {
        if (!double.IsFinite(value))
        {
            throw new ArgumentOutOfRangeException(nameof(value), value, "A tape constant must be finite.");
        }
        // Deduplicate by bits so that +0 and -0 stay distinct constants.
        var bits = BitConverter.DoubleToInt64Bits(value);
        var key = BitConverter.Int64BitsToDouble(bits);
        if (constantRegisters.TryGetValue(key, out var existing))
        {
            return existing;
        }
        var index = constants.Count;
        constants.Add(value);
        var register = Emit(OpConstant, index);
        constantRegisters[key] = register;
        return register;
    }

    /// <summary>The sample's X coordinate in millimetres.</summary>
    public int X() => Emit(OpX);

    /// <summary>The sample's Y coordinate in millimetres.</summary>
    public int Y() => Emit(OpY);

    /// <summary>The sample's Z coordinate in millimetres.</summary>
    public int Z() => Emit(OpZ);

    /// <summary><c>a + b</c>.</summary>
    public int Add(int a, int b) => Emit(OpAdd, a, b);

    /// <summary><c>a - b</c>.</summary>
    public int Subtract(int a, int b) => Emit(OpSubtract, a, b);

    /// <summary><c>a * b</c>.</summary>
    public int Multiply(int a, int b) => Emit(OpMultiply, a, b);

    /// <summary><c>a / b</c>.</summary>
    public int Divide(int a, int b) => Emit(OpDivide, a, b);

    /// <summary><c>-a</c>.</summary>
    public int Negate(int a) => Emit(OpNegate, a);

    /// <summary><c>Math.Abs(a)</c>.</summary>
    public int Absolute(int a) => Emit(OpAbsolute, a);

    /// <summary><c>Math.Sqrt(a)</c>.</summary>
    public int SquareRoot(int a) => Emit(OpSquareRoot, a);

    /// <summary><c>Math.Sin(a)</c>.</summary>
    public int Sine(int a) => Emit(OpSine, a);

    /// <summary><c>Math.Cos(a)</c>.</summary>
    public int Cosine(int a) => Emit(OpCosine, a);

    /// <summary><c>Math.Floor(a)</c>.</summary>
    public int Floor(int a) => Emit(OpFloor, a);

    private int Emit(uint op, int a = 0, int b = 0)
    {
        var register = words.Count / 2;
        if (register >= MaximumInstructions)
        {
            throw new InvalidOperationException(
                $"A signed-distance tape may hold at most {MaximumInstructions} operations.");
        }
        // SSA: an operand must name an instruction this builder already emitted.
        if ((uint)a > (uint)register || (uint)b > (uint)register || (op > OpZ && a == register))
        {
            throw new ArgumentOutOfRangeException(nameof(a), "A tape operand must reference an earlier operation.");
        }
        words.Add(op);
        words.Add((uint)a | ((uint)b << 16));
        return register;
    }
}

/// <summary>
/// The signed-distance methods a generated adapter can evaluate as a tape instead of as a per-voxel
/// callback.
/// </summary>
/// <remarks>
/// The generated registration is invoked explicitly once the author's assembly is loaded. Nothing here
/// runs an author's static constructor, and an unregistered type keeps the callback path unchanged.
/// </remarks>
public static class SdfTapeRegistry
{
    private static readonly ConcurrentDictionary<Type, Func<object, SdfTapeBuilder, int>> Registered = new();
    private static int dispatched;
    private static int fellBack;

    /// <summary>How many implicit operations have run as a tape.</summary>
    /// <remarks>
    /// Diagnostic only: nothing reads it to decide anything. It exists so a conformance program can assert
    /// which path actually executed, rather than inferring it from an equal result.
    /// </remarks>
    public static int Dispatched => Volatile.Read(ref dispatched);

    /// <summary>How many implicit operations have run as a per-voxel callback instead.</summary>
    public static int FellBack => Volatile.Read(ref fellBack);

    /// <summary>The types registered, so a program can tell "not registered" from "registry not invoked".</summary>
    public static int RegisteredCount => Registered.Count;

    /// <summary>Registers the tape form of <typeparamref name="T"/>'s signed-distance method.</summary>
    /// <param name="build">
    /// Rebuilds the method's arithmetic for one instance, reading its fields with ordinary C# arithmetic,
    /// and returns the register holding the signed distance.
    /// </param>
    public static void Register<T>(Func<T, SdfTapeBuilder, int> build)
        where T : IImplicit
    {
        ArgumentNullException.ThrowIfNull(build);
        // Dispatch is by exact runtime type: a subclass may override the method, so it is not covered.
        Registered[typeof(T)] = (instance, builder) => build((T)instance, builder);
    }

    /// <summary>Forgets every registration and counter, so a replaced author assembly leaves nothing behind.</summary>
    public static void Clear()
    {
        Registered.Clear();
        Volatile.Write(ref dispatched, 0);
        Volatile.Write(ref fellBack, 0);
    }

    internal static bool TryBuild(IImplicit implicitFunction, out uint[] instructions, out double[] constants)
    {
        instructions = [];
        constants = [];
        if (!Registered.TryGetValue(implicitFunction.GetType(), out var build))
        {
            Interlocked.Increment(ref fellBack);
            return false;
        }
        var builder = new SdfTapeBuilder();
        var result = build(implicitFunction, builder);
        // The evaluator takes the LAST instruction's register as the signed distance, so a build that
        // returned an earlier register is not expressible; fall back rather than evaluate the wrong node.
        if (result != builder.Count - 1)
        {
            Interlocked.Increment(ref fellBack);
            return false;
        }
        Interlocked.Increment(ref dispatched);
        instructions = builder.Instructions();
        constants = builder.Constants();
        return true;
    }

    internal static bool TryIntersect(LibHandle lib, VoxHandle vox, IImplicit implicitFunction)
    {
        if (!TryBuild(implicitFunction, out var instructions, out var constants))
        {
            return false;
        }
        IntersectNative(lib, vox, instructions, instructions.Length / 2, constants, constants.Length);
        return true;
    }

    internal static bool TryRender(LibHandle lib, VoxHandle vox, in BBox3 bounds, IImplicit implicitFunction)
    {
        if (!TryBuild(implicitFunction, out var instructions, out var constants))
        {
            return false;
        }
        RenderNative(lib, vox, in bounds, instructions, instructions.Length / 2, constants, constants.Length);
        return true;
    }

    // The ordinary upstream-compatible operations. The repository's own `…Fast` variants change
    // upstream's narrow-band behaviour and are never selected from here.
    [DllImport(Config.strPicoGKLib, EntryPoint = "Voxels_IntersectImplicitTape", CallingConvention = CallingConvention.Cdecl)]
    private static extern void IntersectNative(
        LibHandle lib, VoxHandle vox, uint[] instructions, int instructionCount, double[] constants, int constantCount);

    [DllImport(Config.strPicoGKLib, EntryPoint = "Voxels_RenderImplicitTape", CallingConvention = CallingConvention.Cdecl)]
    private static extern void RenderNative(
        LibHandle lib, VoxHandle vox, in BBox3 bounds, uint[] instructions, int instructionCount, double[] constants, int constantCount);
}
#endif
