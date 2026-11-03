// SPDX-License-Identifier: Apache-2.0
#if PICOGK_BROWSER
using System.Numerics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;

namespace PicoGK;

// Lifts an author's signed-distance method to a tape by executing its IL symbolically on the live
// instance, so a field the source generator cannot match still renders natively on every thread.
//
// Every value the method computes is either known now (a constant, a field read from the live
// instance, a static the program set, an array element) or a function of the sample point, which
// becomes a tape register. Known values fold with the runtime's own arithmetic. Register values
// follow the runtime exactly: a `float` operation is the double operation rounded once to float (exact
// for + - * / and sqrt), comparisons are IEEE comparisons, and a library call is replaced only by a
// leaf whose tape form reproduces the runtime's result bit for bit (Math.Max's NaN and signed-zero
// rules included).
//
// Control flow on a register becomes data flow. Each branch splits the state; states that reach the
// same instruction merge with a select on their path conditions, so the tape computes every arm and
// keeps the one the sample takes. A path that reaches `throw`, or a leaf that would throw (Math.Clamp
// with min > max, MathF.Sign of NaN), adds its condition to a trap; the root becomes NaN wherever the
// trap is set, and the checked native render then reports the field as nonfinite so that the caller
// renders it on the callback, which throws exactly as before.
//
// Anything outside this model (a loop whose trip count depends on the sample, a write to shared
// state, an unknown library call, exception handlers) refuses the lift with a reason; the field then
// renders on the callback path unchanged. The caller also compares the tape with the method on sample
// points before using it, so a defect here costs speed, never a byte.

/// <summary>Builds a tape from an author's signed-distance IL, or says why it cannot.</summary>
internal static class SdfIlTape
{
    private const int MaximumDepth = 32;
    private const int MaximumSteps = 2_000_000;
    // Leaves room under the native 16-bit operand limit for the root and the trap.
    private const int MaximumRegisters = SdfTapeBuilder.MaximumInstructions - 16;

    private sealed class Refusal(string reason) : Exception(reason);

    /// <summary>Lifts <paramref name="field"/>'s signed-distance method on the live instance.</summary>
    internal static bool TryLift(IImplicit field, out uint[] instructions, out double[] constants, out string? reason)
    {
        instructions = [];
        constants = [];
        try
        {
            var method = SdfPurity.Implementation(field.GetType(), typeof(IImplicit).GetMethod(nameof(IImplicit.fSignedDistance))!)
                ?? throw new Refusal("the signed-distance implementation could not be resolved");
            var lift = new Lift();
            lift.Run(field, method);
            instructions = lift.Builder.Instructions();
            constants = lift.Builder.Constants();
            reason = null;
            return true;
        }
        catch (Refusal refusal)
        {
            reason = refusal.Message;
            return false;
        }
        catch (Exception error)
        {
            // A lift failure is never a reason to render differently.
            reason = $"lift failed: {error.GetType().Name}: {error.Message}";
            return false;
        }
    }

    // ── Values ──────────────────────────────────────────────────────────────────────────────────

    private enum Kind { I4, I8, R4, R8, Bool }

    /// <summary>A symbolic value: a number known now, a tape register, an object, a struct, or an address.</summary>
    private abstract class V;

    /// <summary>A number known now. R4 values are exact in <see cref="Real"/>; I4/I8/Bool use <see cref="Integer"/>.</summary>
    private sealed class Num(Kind kind, double real, long integer) : V
    {
        internal readonly Kind Kind = kind;
        internal readonly double Real = real;
        internal readonly long Integer = integer;
        internal static Num Int(long value) => new(Kind.I4, 0, (int)value);
        internal static Num Bool(bool value) => new(Kind.Bool, 0, value ? 1 : 0);
        internal static Num Float(float value) => new(Kind.R4, value, 0);
        internal static Num Double(double value) => new(Kind.R8, value, 0);
        internal bool IsInteger => Kind is Kind.I4 or Kind.I8 or Kind.Bool;
    }

    /// <summary>A tape register. Bool registers hold 0 or 1; I4 registers hold small exact integers.</summary>
    private sealed class Reg(int register, Kind kind) : V
    {
        internal readonly int Register = register;
        internal readonly Kind Kind = kind;
    }

    /// <summary>A known reference (null included), or a stand-in for an exception or message being built.</summary>
    private sealed class Obj(object? value) : V
    {
        internal readonly object? Value = value;
        internal static readonly object Placeholder = new();
    }

    /// <summary>A value-type value, field by field in <see cref="Layout"/> order.</summary>
    private sealed class Struct(Type type, V[] fields) : V
    {
        internal readonly Type Type = type;
        internal readonly V[] Fields = fields;
        internal Struct With(int index, V value)
        {
            var copy = (V[])Fields.Clone();
            copy[index] = value;
            return new Struct(Type, copy);
        }
    }

    /// <summary>A managed pointer.</summary>
    private sealed class Addr(Location location) : V
    {
        internal readonly Location Location = location;
    }

    private abstract class Location;

    /// <summary>A local or argument of an inlined frame, optionally a field path inside a struct there.</summary>
    private sealed class Slot(int frame, bool argument, int index, int[] path) : Location
    {
        internal readonly int Frame = frame;
        internal readonly bool Argument = argument;
        internal readonly int Index = index;
        internal readonly int[] Path = path;
        internal (int, bool, int) Key => (Frame, Argument, Index);
        internal Slot Field(int field) => new(Frame, Argument, Index, [.. Path, field]);
    }

    /// <summary>Storage that existed before the evaluation: readable now, never writable.</summary>
    private sealed class Fixed(V value, string what) : Location
    {
        internal readonly V Value = value;
        internal readonly string What = what;
    }

    private static readonly ConditionalWeakTable<Type, FieldInfo[]> Layouts = new();

    private static FieldInfo[] Layout(Type type) => Layouts.GetValue(type, static t =>
        t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .OrderBy(static field => field.MetadataToken).ToArray());

    private static int FieldIndex(FieldInfo field)
    {
        var layout = Layout(field.DeclaringType!);
        for (var index = 0; index < layout.Length; index++)
        {
            if (layout[index].MetadataToken == field.MetadataToken && layout[index].Module == field.Module) return index;
        }
        throw new Refusal($"field {field.Name} is not part of {field.DeclaringType!.Name}'s layout");
    }

    // ── States ──────────────────────────────────────────────────────────────────────────────────

    private sealed class State
    {
        internal List<V> Stack = [];
        internal V[] Locals = [];
        internal V[] Arguments = [];
        /// <summary>The path condition: a known true, or a 0/1 register.</summary>
        internal V Condition = Num.Bool(true);
        /// <summary>Writes made through addresses into frames that are not this one, by slot.</summary>
        internal Dictionary<(int, bool, int), V> Outer = [];

        internal State Copy() => new()
        {
            Stack = [.. Stack],
            Locals = (V[])Locals.Clone(),
            Arguments = (V[])Arguments.Clone(),
            Condition = Condition,
            Outer = new(Outer),
        };
    }

    // ── The lift ────────────────────────────────────────────────────────────────────────────────

    private sealed class Lift
    {
        internal readonly SdfTapeBuilder Builder = new();
        private V? trap;
        private int steps;
        private int nextFrame;
        /// <summary>The state each enclosing frame was in when it made the call being executed, by frame id.</summary>
        private readonly Dictionary<int, State> suspended = [];
        private readonly HashSet<MethodBase> active = [];

        internal void Run(IImplicit field, MethodInfo method)
        {
            if (method.ReturnType != typeof(float)) throw new Refusal("the signed-distance method does not return float");
            var point = new Struct(typeof(Vector3), new V[3]);
            var layout = Layout(typeof(Vector3));
            for (var index = 0; index < layout.Length; index++)
            {
                var register = layout[index].Name switch
                {
                    "X" => Builder.X(),
                    "Y" => Builder.Y(),
                    "Z" => Builder.Z(),
                    _ => throw new Refusal("Vector3 has an unexpected layout"),
                };
                point.Fields[index] = new Reg(register, Kind.R4);
            }
            V receiver = field.GetType().IsValueType ? Live(field, field.GetType()) : new Obj(field);
            var root = new State();
            var result = Invoke(method, [receiver, new Addr(new Fixed(point, "the sample point"))], root);
            var value = Register(result, Kind.R4);
            if (trap is not null)
            {
                var zero = Builder.Constant(0);
                var nan = Builder.Divide(zero, zero);
                value = Builder.Select(Register(trap, Kind.Bool), nan, value);
            }
            else if (value != Builder.Count - 1)
            {
                // The evaluator returns the last register; rounding a float-exact value to float is the identity.
                value = Builder.Float(value);
            }
            if (Builder.Count > MaximumRegisters) throw new Refusal("the lifted tape is too long");
        }

        // ── Registers and arithmetic ──

        private int Register(V value, Kind expected)
        {
            switch (value)
            {
                case Reg register:
                    if (!Compatible(register.Kind, expected)) throw new Refusal($"a {register.Kind} value is used as {expected}");
                    return register.Register;
                case Num number when number.IsInteger || double.IsFinite(number.Real):
                    return Builder.Constant(number.IsInteger ? number.Integer : number.Real);
                case Num number:
                {
                    // The pool holds finite constants; an infinity or NaN is built from one division.
                    var numerator = Builder.Constant(double.IsNaN(number.Real) ? 0 : Math.Sign(number.Real));
                    return Builder.Divide(numerator, Builder.Constant(0));
                }
                default:
                    throw new Refusal($"a {value.GetType().Name} is used as a number");
            }
        }

        private static bool Compatible(Kind actual, Kind expected) =>
            actual == expected || (actual is Kind.Bool or Kind.I4 && expected is Kind.Bool or Kind.I4);

        private Reg Emit(int register, Kind kind)
        {
            if (Builder.Count > MaximumRegisters) throw new Refusal("the lifted tape is too long");
            return new Reg(register, kind);
        }

        private static Kind KindOf(V value) => value switch
        {
            Num number => number.Kind,
            Reg register => register.Kind,
            _ => throw new Refusal($"a {value.GetType().Name} is used as a number"),
        };

        /// <summary>A float or double binary operation: folded when both are known, else rounded per kind.</summary>
        private V Arithmetic(int op, V left, V right)
        {
            var kind = KindOf(left);
            var other = KindOf(right);
            if (kind is Kind.Bool) kind = Kind.I4;
            if (other is Kind.Bool) other = Kind.I4;
            if (kind != other) throw new Refusal($"mixed {kind} and {other} arithmetic");
            if (left is Num a && right is Num b) return Fold(op, kind, a, b);
            if (kind is not (Kind.R4 or Kind.R8)) throw new Refusal("integer arithmetic on a sample-dependent value");
            var l = Register(left, kind);
            var r = Register(right, kind);
            var result = op switch
            {
                0x58 => Builder.Add(l, r),
                0x59 => Builder.Subtract(l, r),
                0x5A => Builder.Multiply(l, r),
                0x5B => Builder.Divide(l, r),
                _ => throw new Refusal($"opcode 0x{op:X2} on a sample-dependent value"),
            };
            return Emit(kind == Kind.R4 ? Builder.Float(result) : result, kind);
        }

        private V Fold(int op, Kind kind, Num a, Num b)
        {
            switch (kind)
            {
                case Kind.R4:
                {
                    float x = (float)a.Real, y = (float)b.Real;
                    return Num.Float(op switch
                    {
                        0x58 => x + y, 0x59 => x - y, 0x5A => x * y, 0x5B => x / y, 0x5D => x % y,
                        _ => throw new Refusal($"opcode 0x{op:X2} on float"),
                    });
                }
                case Kind.R8:
                {
                    double x = a.Real, y = b.Real;
                    return Num.Double(op switch
                    {
                        0x58 => x + y, 0x59 => x - y, 0x5A => x * y, 0x5B => x / y, 0x5D => x % y,
                        _ => throw new Refusal($"opcode 0x{op:X2} on double"),
                    });
                }
                case Kind.I8:
                {
                    long x = a.Integer, y = b.Integer;
                    if (op is 0x5B or 0x5D or 0x5C or 0x5E && y == 0) return Throw("integer division by zero", Num.Int(0));
                    return new Num(Kind.I8, 0, op switch
                    {
                        0x58 => unchecked(x + y), 0x59 => unchecked(x - y), 0x5A => unchecked(x * y),
                        0x5B => x == long.MinValue && y == -1 ? x : x / y, 0x5D => y == -1 ? 0 : x % y,
                        0x5F => x & y, 0x60 => x | y, 0x61 => x ^ y,
                        0x62 => x << (int)(y & 63), 0x63 => x >> (int)(y & 63), 0x64 => (long)((ulong)x >> (int)(y & 63)),
                        _ => throw new Refusal($"opcode 0x{op:X2} on long"),
                    });
                }
                default:
                {
                    int x = (int)a.Integer, y = (int)b.Integer;
                    if (op is 0x5B or 0x5D or 0x5C or 0x5E && y == 0) return Throw("integer division by zero", Num.Int(0));
                    return Num.Int(op switch
                    {
                        0x58 => unchecked(x + y), 0x59 => unchecked(x - y), 0x5A => unchecked(x * y),
                        0x5B => x == int.MinValue && y == -1 ? x : x / y, 0x5D => y == -1 ? 0 : x % y,
                        0x5C => (int)((uint)x / (uint)y), 0x5E => (int)((uint)x % (uint)y),
                        0x5F => x & y, 0x60 => x | y, 0x61 => x ^ y,
                        0x62 => x << (y & 31), 0x63 => x >> (y & 31), 0x64 => (int)((uint)x >> (y & 31)),
                        _ => throw new Refusal($"opcode 0x{op:X2} on int"),
                    });
                }
            }
        }

        private V Negate(V value)
        {
            if (value is Num number)
            {
                return number.Kind switch
                {
                    Kind.R4 => Num.Float(-(float)number.Real),
                    Kind.R8 => Num.Double(-number.Real),
                    Kind.I8 => new Num(Kind.I8, 0, unchecked(-number.Integer)),
                    _ => Num.Int(unchecked(-(int)number.Integer)),
                };
            }
            var register = (Reg)value;
            if (register.Kind is not (Kind.R4 or Kind.R8)) throw new Refusal("integer negation of a sample-dependent value");
            return Emit(Builder.Negate(register.Register), register.Kind);
        }

        /// <summary>The IEEE comparisons: 0 lt, 1 le, 2 eq on (left, right); NaN compares false.</summary>
        private V Compare(int relation, V left, V right)
        {
            if (left is Obj l && right is Obj r) return relation == 2 ? Num.Bool(ReferenceEquals(l.Value, r.Value)) : throw new Refusal("orders two references");
            var kind = KindOf(left);
            var other = KindOf(right);
            if (kind is Kind.Bool) kind = Kind.I4;
            if (other is Kind.Bool) other = Kind.I4;
            if (kind != other) throw new Refusal($"compares {kind} with {other}");
            if (left is Num a && right is Num b)
            {
                if (kind is Kind.R4 or Kind.R8)
                    return Num.Bool(relation switch { 0 => a.Real < b.Real, 1 => a.Real <= b.Real, _ => a.Real == b.Real });
                return Num.Bool(relation switch { 0 => a.Integer < b.Integer, 1 => a.Integer <= b.Integer, _ => a.Integer == b.Integer });
            }
            var x = Register(left, kind);
            var y = Register(right, kind);
            return Emit(relation switch { 0 => Builder.Less(x, y), 1 => Builder.LessOrEqual(x, y), _ => Builder.Equal(x, y) }, Kind.Bool);
        }

        private V Not(V condition)
        {
            if (condition is Num number) return Num.Bool(number.Integer == 0);
            return Emit(Builder.Subtract(Builder.Constant(1), Register(condition, Kind.Bool)), Kind.Bool);
        }

        private V And(V left, V right)
        {
            if (left is Num a) return a.Integer != 0 ? right : Num.Bool(false);
            if (right is Num b) return b.Integer != 0 ? left : Num.Bool(false);
            return Emit(Builder.Multiply(Register(left, Kind.Bool), Register(right, Kind.Bool)), Kind.Bool);
        }

        /// <summary>A 0/1 condition from a branch operand: a bool, an integer (nonzero), or a reference (non-null).</summary>
        private V Truth(V value)
        {
            switch (value)
            {
                case Obj reference: return Num.Bool(reference.Value is not null);
                case Num number: return Num.Bool(number.IsInteger ? number.Integer != 0 : number.Real != 0);
                case Reg { Kind: Kind.Bool }: return value;
                case Reg register: return Not(Compare(2, register, register.Kind == Kind.I4 ? Num.Int(0) : throw new Refusal("branches on a floating value")));
                default: throw new Refusal($"branches on a {value.GetType().Name}");
            }
        }

        private V Select(V condition, V whenTrue, V whenFalse)
        {
            if (condition is Num number) return number.Integer != 0 ? whenTrue : whenFalse;
            if (ReferenceEquals(whenTrue, whenFalse)) return whenTrue;
            switch (whenTrue, whenFalse)
            {
                case (Num a, Num b) when a.Kind == b.Kind && a.Integer == b.Integer
                    && BitConverter.DoubleToInt64Bits(a.Real) == BitConverter.DoubleToInt64Bits(b.Real):
                    return a;
                case (Reg a, Reg b) when a.Register == b.Register:
                    return a;
                case (Num or Reg, Num or Reg):
                {
                    var kind = KindOf(whenTrue);
                    var other = KindOf(whenFalse);
                    if (kind != other && !(Compatible(kind, other) && Compatible(other, kind)))
                        throw new Refusal($"merges a {kind} with a {other}");
                    var resultKind = kind == other ? kind : Kind.I4;
                    return Emit(Builder.Select(Register(condition, Kind.Bool), Register(whenTrue, kind), Register(whenFalse, other)), resultKind);
                }
                case (Struct a, Struct b) when a.Type == b.Type:
                {
                    var fields = new V[a.Fields.Length];
                    for (var index = 0; index < fields.Length; index++) fields[index] = Select(condition, a.Fields[index], b.Fields[index]);
                    return new Struct(a.Type, fields);
                }
                case (Obj a, Obj b) when ReferenceEquals(a.Value, b.Value):
                    return a;
                case (Addr a, Addr b) when SameLocation(a.Location, b.Location):
                    return a;
                default:
                    throw new Refusal("merges paths that hold different objects or addresses");
            }
        }

        private static bool SameLocation(Location left, Location right) => (left, right) switch
        {
            (Slot a, Slot b) => a.Key == b.Key && a.Path.SequenceEqual(b.Path),
            _ => ReferenceEquals(left, right),
        };

        /// <summary>Records that the current path throws; returns a placeholder so execution can continue to the trap.</summary>
        private V Throw(string what, V placeholder)
        {
            _ = what;
            var condition = current?.Condition ?? Num.Bool(true);
            TrapWhen(condition);
            return placeholder;
        }

        private void TrapWhen(V condition)
        {
            if (condition is Num { Integer: 0 }) return;
            if (trap is null) { trap = condition; return; }
            if (trap is Num { Integer: not 0 }) return;
            if (condition is Num) { trap = condition; return; }
            // or(a, b) on 0/1 values: a + b - a * b.
            var a = Register(trap, Kind.Bool);
            var b = Register(condition, Kind.Bool);
            trap = Emit(Builder.Subtract(Builder.Add(a, b), Builder.Multiply(a, b)), Kind.Bool);
        }

        private State? current;

        // ── Live values ──

        /// <summary>A value read now from the live program, as the method would read it.</summary>
        private static V Live(object? value, Type type, int depth = 0)
        {
            if (depth > 8) throw new Refusal($"a {type.Name} value nests too deeply");
            if (type.IsEnum) type = Enum.GetUnderlyingType(type);
            if (type == typeof(float)) return Num.Float((float)value!);
            if (type == typeof(double)) return Num.Double((double)value!);
            if (type == typeof(bool)) return Num.Bool((bool)value!);
            if (type == typeof(int)) return Num.Int((int)value!);
            if (type == typeof(short)) return Num.Int((short)value!);
            if (type == typeof(sbyte)) return Num.Int((sbyte)value!);
            if (type == typeof(byte)) return Num.Int((byte)value!);
            if (type == typeof(ushort)) return Num.Int((ushort)value!);
            if (type == typeof(char)) return Num.Int((char)value!);
            if (type == typeof(uint)) return Num.Int(unchecked((int)(uint)value!));
            if (type == typeof(long)) return new Num(Kind.I8, 0, (long)value!);
            if (type == typeof(ulong)) return new Num(Kind.I8, 0, unchecked((long)(ulong)value!));
            if (type.IsPointer || type.IsByRefLike || type == typeof(nint) || type == typeof(nuint) || type == typeof(decimal))
                throw new Refusal($"reads a {type.Name}");
            if (type.IsValueType)
            {
                var layout = Layout(type);
                var fields = new V[layout.Length];
                for (var index = 0; index < layout.Length; index++)
                    fields[index] = Live(layout[index].GetValue(value), layout[index].FieldType, depth + 1);
                return new Struct(type, fields);
            }
            return new Obj(value);
        }

        private static V Default(Type type)
        {
            if (!type.IsValueType && !type.IsByRef && !type.IsPointer) return new Obj(null);
            // A ref local, a pointer, or a ref struct (an interpolated message being built) holds nothing
            // the tape can use; any arithmetic on it refuses the lift.
            if (type.IsByRef || type.IsPointer || type.IsByRefLike) return new Obj(Obj.Placeholder);
            return Live(Activator.CreateInstance(type), type);
        }

        // ── Locations ──

        private V Read(Location location, State state, int frame)
        {
            switch (location)
            {
                case Fixed fixedLocation:
                    return fixedLocation.Value;
                case Slot slot:
                {
                    V value;
                    if (slot.Frame == frame) value = slot.Argument ? state.Arguments[slot.Index] : state.Locals[slot.Index];
                    else if (state.Outer.TryGetValue(slot.Key, out var written)) value = written;
                    else if (suspended.TryGetValue(slot.Frame, out var owner)) value = slot.Argument ? owner.Arguments[slot.Index] : owner.Locals[slot.Index];
                    else throw new Refusal("reads through an address whose frame has returned");
                    foreach (var field in slot.Path) value = ((Struct)value).Fields[field];
                    return value;
                }
                default:
                    throw new Refusal("reads an unknown location");
            }
        }

        private void Write(Location location, V value, State state, int frame)
        {
            if (location is Fixed fixedLocation) throw new Refusal($"writes to {fixedLocation.What}, which the evaluation does not own");
            var slot = (Slot)location;
            var whole = new Slot(slot.Frame, slot.Argument, slot.Index, []);
            var updated = slot.Path.Length == 0 ? value : Replace(Read(whole, state, frame), slot.Path, 0, value);
            if (slot.Frame == frame)
            {
                if (slot.Argument) state.Arguments[slot.Index] = updated;
                else state.Locals[slot.Index] = updated;
            }
            else
            {
                state.Outer[slot.Key] = updated;
            }
        }

        private static V Replace(V container, int[] path, int depth, V value)
        {
            var structure = (Struct)container;
            var index = path[depth];
            return structure.With(index, depth == path.Length - 1 ? value : Replace(structure.Fields[index], path, depth + 1, value));
        }

        // ── Methods ──

        /// <summary>Executes <paramref name="method"/> for the given arguments under <paramref name="caller"/>'s condition.</summary>
        private V Invoke(MethodBase method, V[] arguments, State caller)
        {
            if (active.Count >= MaximumDepth) throw new Refusal("calls nest too deeply to lift");
            if (!active.Add(method)) throw new Refusal($"{method.Name} is recursive");
            try
            {
                var body = method.GetMethodBody() ?? throw new Refusal($"{method.DeclaringType?.Name}.{method.Name} has no readable IL body");
                if (body.ExceptionHandlingClauses.Count > 0) throw new Refusal($"{method.DeclaringType?.Name}.{method.Name} has exception handlers");
                var il = body.GetILAsByteArray() ?? throw new Refusal($"{method.Name} has no IL");
                var code = IlReader.Decode(il) ?? throw new Refusal($"{method.Name} contains an instruction this reader does not decode");
                var frame = new Frame(this, method, body, code, nextFrame++);
                return frame.Run(arguments, caller);
            }
            finally { active.Remove(method); }
        }

        /// <summary>One inlined method: states keyed by IL offset, merged where control flow joins.</summary>
        private sealed class Frame(Lift lift, MethodBase method, MethodBody body, IlReader.Instruction[] code, int id)
        {
            private readonly Dictionary<int, int> indexOf = code.Select(static (instruction, index) => (instruction.Offset, index))
                .ToDictionary(static pair => pair.Offset, static pair => pair.index);
            private readonly SortedDictionary<int, State> pending = [];
            private readonly List<(V Condition, V? Value, Dictionary<(int, bool, int), V> Outer)> returns = [];
            private Type[] GenericTypes => method.DeclaringType?.IsGenericType == true ? method.DeclaringType.GetGenericArguments() : [];
            private Type[] GenericMethods => method.IsGenericMethod ? method.GetGenericArguments() : [];
            private Module Module => method.Module;

            internal V Run(V[] arguments, State caller)
            {
                var start = new State
                {
                    Arguments = arguments,
                    Locals = body.LocalVariables.Select(static local => Default(local.LocalType)).ToArray(),
                    Condition = caller.Condition,
                    Outer = new(caller.Outer),
                };
                if (!body.InitLocals && body.LocalVariables.Count > 0)
                {
                    // Uninitialized locals are written before they are read in verifiable C#; defaults stand in.
                }
                Arrive(0, start);
                while (pending.Count > 0)
                {
                    var (offset, state) = pending.First();
                    pending.Remove(offset);
                    Execute(indexOf[offset], state);
                }
                return Finish(caller);
            }

            private V Finish(State caller)
            {
                var returnsValue = method is MethodInfo info && info.ReturnType != typeof(void);
                if (returns.Count == 0)
                {
                    // Every path throws: the trap already covers them, and nothing after the call is reached.
                    return returnsValue ? Default(((MethodInfo)method).ReturnType) : new Num(Kind.I4, 0, 0);
                }
                // The last return is the default arm; each earlier one is selected by its own path condition.
                var (_, value, outer) = returns[^1];
                var merged = new Dictionary<(int, bool, int), V>(outer);
                for (var index = returns.Count - 2; index >= 0; index--)
                {
                    var (condition, other, otherOuter) = returns[index];
                    if (returnsValue) value = lift.Select(condition, other!, value!);
                    foreach (var key in merged.Keys.Union(otherOuter.Keys).ToArray())
                    {
                        var whenTrue = otherOuter.TryGetValue(key, out var a) ? a : Current(key, caller);
                        var whenFalse = merged.TryGetValue(key, out var b) ? b : Current(key, caller);
                        merged[key] = lift.Select(condition, whenTrue, whenFalse);
                    }
                }
                // Writes into the caller's own slots land there; writes further out stay pending for it.
                foreach (var (key, written) in merged)
                {
                    if (key.Item1 == CallerFrame) { if (key.Item2) caller.Arguments[key.Item3] = written; else caller.Locals[key.Item3] = written; }
                    else caller.Outer[key] = written;
                }
                return returnsValue ? value! : new Num(Kind.I4, 0, 0);
            }

            internal int CallerFrame = -1;

            private V Current((int Frame, bool Argument, int Index) key, State caller)
            {
                if (caller.Outer.TryGetValue(key, out var value)) return value;
                if (key.Frame == CallerFrame) return key.Argument ? caller.Arguments[key.Index] : caller.Locals[key.Index];
                if (lift.suspended.TryGetValue(key.Frame, out var owner)) return key.Argument ? owner.Arguments[key.Index] : owner.Locals[key.Index];
                throw new Refusal("writes through an address whose frame has returned");
            }

            private void Arrive(int offset, State state)
            {
                if (state.Condition is Num { Integer: 0 }) return;
                if (!indexOf.ContainsKey(offset)) throw new Refusal("branches into the middle of an instruction");
                if (!pending.TryGetValue(offset, out var waiting)) { pending[offset] = state; return; }
                pending[offset] = Merge(waiting, state);
            }

            private State Merge(State a, State b)
            {
                if (a.Stack.Count != b.Stack.Count) throw new Refusal("joins paths with different stack depths");
                var c = a.Condition;
                var merged = new State
                {
                    Stack = a.Stack.Select((value, index) => lift.Select(c, value, b.Stack[index])).ToList(),
                    Locals = a.Locals.Select((value, index) => lift.Select(c, value, b.Locals[index])).ToArray(),
                    Arguments = a.Arguments.Select((value, index) => lift.Select(c, value, b.Arguments[index])).ToArray(),
                    Condition = Or(a.Condition, b.Condition),
                    Outer = [],
                };
                foreach (var key in a.Outer.Keys.Union(b.Outer.Keys))
                {
                    var whenTrue = a.Outer.TryGetValue(key, out var x) ? x : Outside(key);
                    var whenFalse = b.Outer.TryGetValue(key, out var y) ? y : Outside(key);
                    merged.Outer[key] = lift.Select(c, whenTrue, whenFalse);
                }
                return merged;
            }

            private V Outside((int Frame, bool Argument, int Index) key)
            {
                if (lift.suspended.TryGetValue(key.Frame, out var owner)) return key.Argument ? owner.Arguments[key.Index] : owner.Locals[key.Index];
                throw new Refusal("joins writes through an address whose frame has returned");
            }

            /// <summary>Path conditions of different states are disjoint, so their union is their sum.</summary>
            private V Or(V a, V b)
            {
                if (a is Num { Integer: not 0 } || b is Num { Integer: not 0 }) return Num.Bool(true);
                return lift.Emit(lift.Builder.Add(lift.Register(a, Kind.Bool), lift.Register(b, Kind.Bool)), Kind.Bool);
            }

            private V Pop(State state)
            {
                if (state.Stack.Count == 0) throw new Refusal("pops an empty stack");
                var value = state.Stack[^1];
                state.Stack.RemoveAt(state.Stack.Count - 1);
                return value;
            }

            private void Execute(int index, State state)
            {
                Type? constrained = null;
                var first = true;
                while (true)
                {
                    // Another path is already waiting here: join it rather than run the rest twice.
                    if (!first && constrained is null && pending.ContainsKey(code[index].Offset)) { Arrive(code[index].Offset, state); return; }
                    first = false;
                    if (++lift.steps > MaximumSteps) throw new Refusal("does not finish within the lift's step budget (a sample-dependent loop?)");
                    lift.current = state;
                    var instruction = code[index];
                    var next = index + 1 < code.Length ? code[index + 1].Offset : -1;
                    var op = instruction.Code;
                    switch (op)
                    {
                        case 0x00: case 0xFE1E: case 0xFE13: case 0xFE14: case 0xFE12: case 0xFE19: break; // nop, readonly., volatile., tail., unaligned., no.
                        case 0xFE16: constrained = Module.ResolveType(instruction.Token, GenericTypes, GenericMethods); index++; continue;
                        case >= 0x02 and <= 0x05: state.Stack.Add(state.Arguments[op - 0x02]); break;
                        case 0x0E: case 0xFE09: state.Stack.Add(state.Arguments[instruction.Index]); break;
                        case 0x0F: case 0xFE0A: state.Stack.Add(new Addr(new Slot(id, true, instruction.Index, []))); break;
                        case 0x10: case 0xFE0B: state.Arguments[instruction.Index] = Pop(state); break;
                        case >= 0x06 and <= 0x09: state.Stack.Add(state.Locals[op - 0x06]); break;
                        case 0x11: case 0xFE0C: state.Stack.Add(state.Locals[instruction.Index]); break;
                        case 0x12: case 0xFE0D: state.Stack.Add(new Addr(new Slot(id, false, instruction.Index, []))); break;
                        case >= 0x0A and <= 0x0D: state.Locals[op - 0x0A] = Pop(state); break;
                        case 0x13: case 0xFE0E: state.Locals[instruction.Index] = Pop(state); break;
                        case 0x14: state.Stack.Add(new Obj(null)); break;
                        case >= 0x15 and <= 0x1E: state.Stack.Add(Num.Int(op - 0x16)); break;
                        case 0x1F: case 0x20: state.Stack.Add(Num.Int(instruction.Integer)); break;
                        case 0x21: state.Stack.Add(new Num(Kind.I8, 0, instruction.Integer)); break;
                        case 0x22: state.Stack.Add(Num.Float((float)instruction.Real)); break;
                        case 0x23: state.Stack.Add(Num.Double(instruction.Real)); break;
                        case 0x25: { var top = Pop(state); state.Stack.Add(top); state.Stack.Add(top); break; }
                        case 0x26: Pop(state); break;
                        case 0x28: case 0x6F: case 0x73:
                            Call(instruction, state, op, constrained);
                            constrained = null;
                            break;
                        case 0x2A:
                        {
                            V? value = method is MethodInfo info && info.ReturnType != typeof(void) ? Pop(state) : null;
                            returns.Add((state.Condition, value, state.Outer));
                            return;
                        }
                        case 0x2B: case 0x38: Arrive(instruction.Targets[0], state); return;
                        case 0x2C: case 0x39: case 0x2D: case 0x3A:
                        {
                            var truth = lift.Truth(Pop(state));
                            var whenTaken = op is 0x2D or 0x3A ? truth : lift.Not(truth);
                            Branch(state, whenTaken, instruction.Targets[0], next);
                            return;
                        }
                        case >= 0x2E and <= 0x37: case >= 0x3B and <= 0x44:
                        {
                            var right = Pop(state);
                            var left = Pop(state);
                            var relation = op >= 0x3B ? op - 0x3B : op - 0x2E;
                            Branch(state, Relation(relation, left, right), instruction.Targets[0], next);
                            return;
                        }
                        case 0x45:
                        {
                            if (Pop(state) is not Num selector) throw new Refusal("switches on a sample-dependent value");
                            var target = selector.Integer >= 0 && selector.Integer < instruction.Targets.Length ? instruction.Targets[(int)selector.Integer] : next;
                            Arrive(target, state);
                            return;
                        }
                        case 0x4E: case 0x4C: case 0x4A: case 0x4B: case 0x46: case 0x47: case 0x48: case 0x49: case 0x4D: case 0x4F: case 0x50:
                        {
                            if (Pop(state) is not Addr address) throw new Refusal("loads through a pointer");
                            state.Stack.Add(lift.Read(address.Location, state, id));
                            break;
                        }
                        case >= 0x51 and <= 0x57: case 0xDF:
                        {
                            var value = Pop(state);
                            if (Pop(state) is not Addr address) throw new Refusal("stores through a pointer");
                            lift.Write(address.Location, value, state, id);
                            break;
                        }
                        case >= 0x58 and <= 0x5B: case 0x5D:
                        {
                            var right = Pop(state);
                            var left = Pop(state);
                            state.Stack.Add(lift.Arithmetic(op, left, right));
                            break;
                        }
                        case 0x5C: case 0x5E: case >= 0x5F and <= 0x64:
                        {
                            var right = Pop(state);
                            var left = Pop(state);
                            if (left is Num a && right is Num b && a.IsInteger && b.IsInteger)
                                state.Stack.Add(lift.Fold(op, a.Kind == Kind.I8 ? Kind.I8 : Kind.I4, a, b));
                            else if (op is 0x5F && KindOf(left) is Kind.Bool && KindOf(right) is Kind.Bool)
                                state.Stack.Add(lift.And(left, right));
                            else if (op is 0x60 && KindOf(left) is Kind.Bool && KindOf(right) is Kind.Bool)
                                state.Stack.Add(lift.Not(lift.And(lift.Not(left), lift.Not(right))));
                            else throw new Refusal($"opcode 0x{op:X2} on a sample-dependent value");
                            break;
                        }
                        case 0x65: state.Stack.Add(lift.Negate(Pop(state))); break;
                        case 0x66:
                        {
                            var value = Pop(state);
                            if (value is Num { IsInteger: true } n) state.Stack.Add(n.Kind == Kind.I8 ? new Num(Kind.I8, 0, ~n.Integer) : Num.Int(~(int)n.Integer));
                            else throw new Refusal("bitwise not of a sample-dependent value");
                            break;
                        }
                        case 0x6B: state.Stack.Add(ToFloat(Pop(state))); break; // conv.r4
                        case 0x6C: state.Stack.Add(ToDouble(Pop(state))); break; // conv.r8
                        case 0x67: case 0x68: case 0x69: case 0x6A: case 0x6D: case 0x6E: case 0xD1: case 0xD2: case 0xD3: case 0xE0: case 0xD4: case 0xD5: case 0x76:
                            state.Stack.Add(ConvertInteger(op, Pop(state)));
                            break;
                        case 0xFE01: case 0xFE02: case 0xFE03: case 0xFE04: case 0xFE05:
                        {
                            var right = Pop(state);
                            var left = Pop(state);
                            state.Stack.Add(op switch
                            {
                                0xFE01 => lift.Compare(2, left, right),                    // ceq
                                0xFE02 => lift.Compare(0, right, left),                    // cgt
                                0xFE03 => lift.Not(lift.Compare(1, left, right)),          // cgt.un: !(a <= b)
                                0xFE04 => lift.Compare(0, left, right),                    // clt
                                _ => lift.Not(lift.Compare(1, right, left)),               // clt.un: !(b <= a)
                            });
                            break;
                        }
                        case 0x7B: // ldfld
                        {
                            var field = Module.ResolveField(instruction.Token, GenericTypes, GenericMethods)!;
                            state.Stack.Add(LoadField(field, Pop(state), state));
                            break;
                        }
                        case 0x7C: // ldflda
                        {
                            var field = Module.ResolveField(instruction.Token, GenericTypes, GenericMethods)!;
                            var owner = Pop(state);
                            state.Stack.Add(owner switch
                            {
                                Addr { Location: Slot slot } => new Addr(slot.Field(FieldIndex(field))),
                                Addr { Location: Fixed f } => new Addr(new Fixed(((Struct)f.Value).Fields[FieldIndex(field)], f.What)),
                                Obj { Value: { } instance } => new Addr(new Fixed(Live(field.GetValue(instance), field.FieldType), $"field {field.Name} of a shared object")),
                                _ => throw new Refusal($"takes the address of {field.Name} on an unknown owner"),
                            });
                            break;
                        }
                        case 0x7D: // stfld
                        {
                            var field = Module.ResolveField(instruction.Token, GenericTypes, GenericMethods)!;
                            var value = Pop(state);
                            var owner = Pop(state);
                            if (owner is not Addr address) throw new Refusal($"stores {field.Name} into an object the evaluation does not own");
                            var location = address.Location is Slot slot ? (Location)slot.Field(FieldIndex(field)) : address.Location;
                            lift.Write(location, value, state, id);
                            break;
                        }
                        case 0x7E: // ldsfld
                        {
                            var field = Module.ResolveField(instruction.Token, GenericTypes, GenericMethods)!;
                            if (field.IsLiteral) state.Stack.Add(Live(field.GetRawConstantValue(), field.FieldType));
                            else state.Stack.Add(Live(field.GetValue(null), field.FieldType));
                            break;
                        }
                        case 0x7F: // ldsflda
                        {
                            var field = Module.ResolveField(instruction.Token, GenericTypes, GenericMethods)!;
                            state.Stack.Add(new Addr(new Fixed(Live(field.GetValue(null), field.FieldType), $"static field {field.Name}")));
                            break;
                        }
                        case 0x80: throw new Refusal("writes a static field");
                        case 0x71: // ldobj
                        {
                            Module.ResolveType(instruction.Token, GenericTypes, GenericMethods);
                            if (Pop(state) is not Addr address) throw new Refusal("ldobj through a pointer");
                            state.Stack.Add(lift.Read(address.Location, state, id));
                            break;
                        }
                        case 0x81: // stobj
                        {
                            var value = Pop(state);
                            if (Pop(state) is not Addr address) throw new Refusal("stobj through a pointer");
                            lift.Write(address.Location, value, state, id);
                            break;
                        }
                        case 0xFE15: // initobj
                        {
                            var type = Module.ResolveType(instruction.Token, GenericTypes, GenericMethods);
                            if (Pop(state) is not Addr address) throw new Refusal("initobj through a pointer");
                            lift.Write(address.Location, Default(type), state, id);
                            break;
                        }
                        case 0x72: state.Stack.Add(new Obj(Obj.Placeholder)); break; // ldstr: only ever a message
                        case 0x7A: // throw
                            Pop(state);
                            lift.TrapWhen(state.Condition);
                            return;
                        case 0x8E: // ldlen
                        {
                            if (Pop(state) is not Obj { Value: Array array }) throw new Refusal("reads the length of an unknown array");
                            state.Stack.Add(Num.Int(array.Length));
                            break;
                        }
                        case >= 0x90 and <= 0x9A: case 0xA3: // ldelem.*
                        {
                            var position = Pop(state);
                            if (Pop(state) is not Obj { Value: Array array }) throw new Refusal("reads an element of an unknown array");
                            if (position is not Num { IsInteger: true } at) throw new Refusal("indexes an array by a sample-dependent value");
                            if (array.Rank != 1) throw new Refusal("reads a multi-dimensional array");
                            if (at.Integer < 0 || at.Integer >= array.Length) { state.Stack.Add(lift.Throw("index out of range", Default(array.GetType().GetElementType()!))); break; }
                            state.Stack.Add(Live(array.GetValue(at.Integer), array.GetType().GetElementType()!));
                            break;
                        }
                        case 0x8F: // ldelema
                        {
                            Module.ResolveType(instruction.Token, GenericTypes, GenericMethods);
                            var position = Pop(state);
                            if (Pop(state) is not Obj { Value: Array array }) throw new Refusal("addresses an element of an unknown array");
                            if (position is not Num { IsInteger: true } at || at.Integer < 0 || at.Integer >= array.Length || array.Rank != 1)
                                throw new Refusal("addresses an array element it cannot resolve");
                            state.Stack.Add(new Addr(new Fixed(Live(array.GetValue(at.Integer), array.GetType().GetElementType()!), "an element of a shared array")));
                            break;
                        }
                        default:
                            throw new Refusal($"{method.DeclaringType?.Name}.{method.Name} uses IL opcode 0x{op:X2}, which the lift does not model");
                    }
                    if (next < 0) throw new Refusal("falls off the end of the method");
                    index++;
                }
            }

            private void Branch(State state, V whenTaken, int target, int next)
            {
                if (whenTaken is Num known)
                {
                    Arrive(known.Integer != 0 ? target : next, state);
                    return;
                }
                var taken = state.Copy();
                taken.Condition = lift.And(state.Condition, whenTaken);
                state.Condition = lift.And(state.Condition, lift.Not(whenTaken));
                Arrive(target, taken);
                Arrive(next, state);
            }

            /// <summary>The 10 conditional branches in IL order: beq, bge, bgt, ble, blt, bne.un, bge.un, bgt.un, ble.un, blt.un.</summary>
            private V Relation(int relation, V left, V right) => relation switch
            {
                0 => lift.Compare(2, left, right),
                1 => lift.Compare(1, right, left),
                2 => lift.Compare(0, right, left),
                3 => lift.Compare(1, left, right),
                4 => lift.Compare(0, left, right),
                5 => lift.Not(lift.Compare(2, left, right)),
                6 => lift.Not(lift.Compare(0, left, right)),
                7 => lift.Not(lift.Compare(1, left, right)),
                8 => lift.Not(lift.Compare(0, right, left)),
                _ => lift.Not(lift.Compare(1, right, left)),
            };

            private V ToFloat(V value) => value switch
            {
                Num { Kind: Kind.R4 } n => n,
                Num { Kind: Kind.R8 } n => Num.Float((float)n.Real),
                Num { Kind: Kind.I8 } n => Num.Float(n.Integer),
                Num n => Num.Float((int)n.Integer),
                Reg { Kind: Kind.R4 } r => r,
                // A double, or a small exact integer: one rounding to float.
                Reg r => lift.Emit(lift.Builder.Float(r.Register), Kind.R4),
                _ => throw new Refusal($"converts a {value.GetType().Name} to float"),
            };

            private V ToDouble(V value) => value switch
            {
                Num { Kind: Kind.R4 or Kind.R8 } n => Num.Double(n.Real),
                Num { Kind: Kind.I8 } n => Num.Double(n.Integer),
                Num n => Num.Double((int)n.Integer),
                Reg r => new Reg(r.Register, Kind.R8),
                _ => throw new Refusal($"converts a {value.GetType().Name} to double"),
            };

            private static V ConvertInteger(int op, V value)
            {
                if (value is not Num n) throw new Refusal("converts a sample-dependent value to an integer");
                if (n.Kind is Kind.R4 or Kind.R8)
                {
                    if (!double.IsFinite(n.Real)) throw new Refusal("converts a nonfinite constant to an integer");
                    return op switch
                    {
                        0x69 or 0x6D => Num.Int((int)n.Real), // conv.i4 / conv.u4: the low 32 bits of a truncation in range
                        0x6A or 0x6E => new Num(Kind.I8, 0, (long)n.Real),
                        _ => throw new Refusal("converts a floating constant to a narrow integer"),
                    };
                }
                var bits = n.Integer;
                return op switch
                {
                    0x67 => Num.Int((sbyte)bits),
                    0x68 => Num.Int((short)bits),
                    0x69 or 0xD3 or 0x6D => Num.Int((int)bits),
                    0x6A or 0x6E or 0xD4 or 0xD5 or 0xD6 => new Num(Kind.I8, 0, n.Kind == Kind.I8 ? bits : op == 0x6E ? (uint)(int)bits : (int)bits),
                    0xD1 => Num.Int((ushort)bits),
                    0xD2 => Num.Int((byte)bits),
                    0xE0 => new Num(Kind.I8, 0, (long)(ulong)(uint)(int)bits),
                    _ => throw new Refusal($"conversion 0x{op:X2}"),
                };
            }

            private V LoadField(FieldInfo field, V owner, State state)
            {
                switch (owner)
                {
                    case Struct structure: return structure.Fields[FieldIndex(field)];
                    case Addr address:
                        var value = lift.Read(address.Location, state, id);
                        if (value is Struct inner) return inner.Fields[FieldIndex(field)];
                        if (value is Obj { Value: { } boxed }) return Live(field.GetValue(boxed), field.FieldType);
                        throw new Refusal($"reads {field.Name} from a {value.GetType().Name}");
                    case Obj { Value: { } instance }:
                        // Render is synchronous and the field was proven pure, so this is what every sample reads.
                        return Live(field.GetValue(instance), field.FieldType);
                    case Obj:
                        return lift.Throw("null reference", Default(field.FieldType));
                    default:
                        throw new Refusal($"reads {field.Name} from an unknown owner");
                }
            }

            private void Call(IlReader.Instruction instruction, State state, int op, Type? constrained)
            {
                var callee = Module.ResolveMethod(instruction.Token, GenericTypes, GenericMethods)!;
                var parameters = callee.GetParameters();
                var hasThis = !callee.IsStatic && op != 0x73;
                var values = new V[parameters.Length + (hasThis ? 1 : 0)];
                for (var index = values.Length - 1; index >= 0; index--) values[index] = Pop(state);

                if (op == 0x73)
                {
                    var type = callee.DeclaringType!;
                    if (typeof(Exception).IsAssignableFrom(type)) { state.Stack.Add(new Obj(Obj.Placeholder)); return; }
                    if (!type.IsValueType) throw new Refusal($"allocates a {type.Name}");
                    if (Leaves.TryConstruct(lift, (ConstructorInfo)callee, values) is { } built) { state.Stack.Add(built); return; }
                    // A user struct: run its constructor on a fresh temporary of this frame's state.
                    var temporary = new Slot(lift.nextFrame++, false, 0, []);
                    var holder = new State { Locals = [Default(type)] };
                    lift.suspended[temporary.Frame] = holder;
                    try
                    {
                        Inline(callee, [new Addr(temporary), .. values], state);
                        state.Stack.Add(state.Outer.Remove(temporary.Key, out var constructed) ? constructed : holder.Locals[0]);
                    }
                    finally { lift.suspended.Remove(temporary.Frame); }
                    return;
                }

                var target = callee;
                if (hasThis && constrained is not null && values[0] is Addr constrainedAddress)
                {
                    if (constrained.IsValueType)
                    {
                        // A struct's own implementation, called on its address.
                        target = callee.IsVirtual && callee is MethodInfo virtualOnStruct
                            ? SdfPurity.Implementation(constrained, virtualOnStruct) ?? throw new Refusal($"{constrained.Name} does not implement {callee.Name}")
                            : callee;
                        if (target.DeclaringType != constrained) throw new Refusal($"boxes a {constrained.Name} to call {callee.Name}");
                    }
                    else
                    {
                        values[0] = lift.Read(constrainedAddress.Location, state, id);
                    }
                }
                if (op == 0x6F && callee is MethodInfo virtualMethod && (virtualMethod.IsVirtual && !virtualMethod.IsFinal || callee.DeclaringType!.IsInterface) && values[0] is Obj receiver)
                {
                    if (receiver.Value is null) { PushResult(state, callee, lift.Throw("null reference", Default(ReturnType(callee)))); return; }
                    if (receiver.Value is Delegate dispatch && callee.Name == "Invoke")
                    {
                        var invocations = dispatch.GetInvocationList();
                        if (invocations.Length != 1) throw new Refusal("invokes a multicast delegate");
                        var bound = invocations[0].Method.IsStatic ? values[1..] : [new Obj(invocations[0].Target), .. values[1..]];
                        PushResult(state, callee, Inline(invocations[0].Method, bound, state));
                        return;
                    }
                    target = SdfPurity.Implementation(receiver.Value.GetType(), virtualMethod) ?? throw new Refusal($"cannot resolve {callee.Name} on {receiver.Value.GetType().Name}");
                }
                if (hasThis && values[0] is Obj { Value: null }) { PushResult(state, callee, lift.Throw("null reference", Default(ReturnType(callee)))); return; }

                if (Leaves.TryCall(lift, target, values, state, id) is { } leaf) { PushResult(state, target, leaf); return; }
                if (Leaves.IsMessage(target)) { PushResult(state, target, new Obj(Obj.Placeholder)); return; }
                if (target.DeclaringType is { } declaring && (declaring.Assembly == typeof(object).Assembly || declaring.Assembly == typeof(Vector3).Assembly))
                    throw new Refusal($"calls {declaring.Name}.{target.Name}, which is not a tape leaf");
                PushResult(state, target, Inline(target, values, state));
            }

            private static Type ReturnType(MethodBase method) => method is MethodInfo info ? info.ReturnType : typeof(void);

            private static void PushResult(State state, MethodBase callee, V result)
            {
                if (ReturnType(callee) != typeof(void)) state.Stack.Add(result);
            }

            private V Inline(MethodBase target, V[] values, State state)
            {
                lift.suspended[id] = state;
                try
                {
                    var body = target.GetMethodBody() ?? throw new Refusal($"{target.DeclaringType?.Name}.{target.Name} has no readable IL body");
                    if (body.ExceptionHandlingClauses.Count > 0) throw new Refusal($"{target.DeclaringType?.Name}.{target.Name} has exception handlers");
                    if (lift.active.Count >= MaximumDepth) throw new Refusal("calls nest too deeply to lift");
                    if (!lift.active.Add(target)) throw new Refusal($"{target.Name} is recursive");
                    try
                    {
                        var il = body.GetILAsByteArray() ?? throw new Refusal($"{target.Name} has no IL");
                        var decoded = IlReader.Decode(il) ?? throw new Refusal($"{target.Name} contains an instruction this reader does not decode");
                        var callee = new Frame(lift, target, body, decoded, lift.nextFrame++) { CallerFrame = id };
                        return callee.Run(values, state);
                    }
                    finally { lift.active.Remove(target); }
                }
                finally
                {
                    lift.suspended.Remove(id);
                    lift.current = state;
                }
            }
        }

        // ── Leaves: library methods replaced by their exact tape form ──

        private static class Leaves
        {
            internal static bool IsMessage(MethodBase method)
            {
                var type = method.DeclaringType;
                if (type == typeof(string) && method.Name is "Concat" or "Format") return true;
                if (type == typeof(DefaultInterpolatedStringHandler)) return true;
                return false;
            }

            internal static V? TryConstruct(Lift lift, ConstructorInfo constructor, V[] values)
            {
                var type = constructor.DeclaringType!;
                if (type != typeof(Vector2) && type != typeof(Vector3)) return null;
                var lanes = type == typeof(Vector2) ? 2 : 3;
                var parameters = constructor.GetParameters().Select(static p => p.ParameterType).ToArray();
                if (parameters.Length == 1 && parameters[0] == typeof(float))
                    return Vector(type, Enumerable.Repeat(values[0], lanes).ToArray());
                if (parameters.Length == lanes && parameters.All(static p => p == typeof(float)))
                    return Vector(type, values);
                if (type == typeof(Vector3) && parameters.Length == 2 && parameters[0] == typeof(Vector2) && parameters[1] == typeof(float))
                    return Vector(type, [.. Lanes(values[0]), values[1]]);
                throw new Refusal($"constructs a {type.Name} from ({string.Join(", ", parameters.Select(static p => p.Name))})");
            }

            private static V Vector(Type type, V[] lanes)
            {
                var layout = Layout(type);
                var fields = new V[layout.Length];
                for (var index = 0; index < layout.Length; index++)
                {
                    fields[index] = layout[index].Name switch
                    {
                        "X" => lanes[0], "Y" => lanes[1], "Z" => lanes[2],
                        _ => throw new Refusal($"{type.Name} has an unexpected layout"),
                    };
                }
                return new Struct(type, fields);
            }

            private static V[] Lanes(V vector)
            {
                if (vector is not Struct structure) throw new Refusal("uses an unknown vector");
                var layout = Layout(structure.Type);
                var lanes = new V[layout.Length];
                for (var index = 0; index < layout.Length; index++)
                {
                    lanes[layout[index].Name switch { "X" => 0, "Y" => 1, "Z" => 2, _ => throw new Refusal("unexpected vector layout") }] = structure.Fields[index];
                }
                return lanes;
            }

            internal static V? TryCall(Lift lift, MethodBase method, V[] values, State state, int frame)
            {
                var type = method.DeclaringType;
                var name = method.Name;
                var parameters = method.GetParameters().Select(static p => p.ParameterType).ToArray();
                if (type == typeof(Math) || type == typeof(MathF))
                {
                    var single = type == typeof(MathF) || parameters.Length > 0 && parameters[0] == typeof(float);
                    if (parameters.Length > 0 && parameters.Any(static p => p != typeof(float) && p != typeof(double)))
                    {
                        // Integer overloads fold only on known operands.
                        if (values.All(static v => v is Num)) return FoldInteger(name, values);
                        throw new Refusal($"calls {type.Name}.{name} on a sample-dependent integer");
                    }
                    return Scalar(lift, name, values, single);
                }
                if (type == typeof(float) || type == typeof(double))
                {
                    if (name == "IsNaN") return lift.Not(lift.Compare(2, values[0], values[0]));
                    return null;
                }
                if (type == typeof(Vector2) || type == typeof(Vector3))
                {
                    if (method.IsConstructor)
                    {
                        // `call .ctor` on an address: construct, then store.
                        if (values[0] is not Addr address) throw new Refusal("constructs a vector through a pointer");
                        var built = TryConstruct(lift, (ConstructorInfo)method, values[1..])!;
                        lift.Write(address.Location, built, state, frame);
                        return new Num(Kind.I4, 0, 0);
                    }
                    if (!method.IsStatic && values[0] is Addr receiver) values[0] = lift.Read(receiver.Location, state, frame);
                    return VectorMember(lift, type, name, values, parameters);
                }
                return null;
            }

            private static V FoldInteger(string name, V[] values)
            {
                var a = (Num)values[0];
                long x = a.Integer;
                long y = values.Length > 1 ? ((Num)values[1]).Integer : 0;
                var result = name switch
                {
                    "Abs" => Math.Abs(x),
                    "Min" => Math.Min(x, y),
                    "Max" => Math.Max(x, y),
                    "Sign" => Math.Sign(x),
                    _ => throw new Refusal($"calls Math.{name} on integers"),
                };
                return a.Kind == Kind.I8 ? new Num(Kind.I8, 0, result) : Num.Int(result);
            }

            private static V Scalar(Lift lift, string name, V[] values, bool single)
            {
                var kind = single ? Kind.R4 : Kind.R8;
                if (values.All(static v => v is Num))
                {
                    // Known operands: the runtime's own call, so the folded value is the callback's.
                    return FoldScalar(lift, name, values, single);
                }
                switch (name)
                {
                    case "Sqrt": return Round(lift, lift.Builder.SquareRoot(lift.Register(values[0], kind)), kind);
                    case "Abs": return lift.Emit(lift.Builder.Absolute(lift.Register(values[0], kind)), kind);
                    case "Floor": return lift.Emit(lift.Builder.Floor(lift.Register(values[0], kind)), kind);
                    case "Ceiling":
                        return lift.Emit(lift.Builder.Negate(lift.Builder.Floor(lift.Builder.Negate(lift.Register(values[0], kind)))), kind);
                    case "Sin": return Round(lift, lift.Builder.Sine(lift.Register(values[0], kind)), kind);
                    case "Cos": return Round(lift, lift.Builder.Cosine(lift.Register(values[0], kind)), kind);
                    case "Exp" when !single: return lift.Emit(lift.Builder.Exp(lift.Register(values[0], kind)), kind);
                    case "Log" when !single && values.Length == 1: return lift.Emit(lift.Builder.Log(lift.Register(values[0], kind)), kind);
                    case "Min": return Minimum(lift, values[0], values[1], kind);
                    case "Max": return Maximum(lift, values[0], values[1], kind);
                    case "Clamp":
                    {
                        // if (min > max) throw; if (value < min) return min; if (value > max) return max; return value.
                        lift.TrapWhen(lift.And(lift.current!.Condition, lift.Compare(0, values[2], values[1])));
                        var low = lift.Select(lift.Compare(0, values[0], values[1]), values[1], values[0]);
                        return lift.Select(lift.Compare(0, values[2], values[0]), values[2], low);
                    }
                    case "Sign":
                    {
                        // NaN throws ArithmeticException; otherwise -1, 1 or 0.
                        lift.TrapWhen(lift.And(lift.current!.Condition, lift.Not(lift.Compare(2, values[0], values[0]))));
                        var zero = single ? (V)Num.Float(0) : Num.Double(0);
                        var positive = lift.Select(lift.Compare(0, zero, values[0]), Num.Int(1), Num.Int(0));
                        return lift.Select(lift.Compare(0, values[0], zero), Num.Int(-1), positive);
                    }
                    default:
                        throw new Refusal($"calls {(single ? "MathF" : "Math")}.{name}, which is not a tape leaf");
                }
            }

            private static V FoldScalar(Lift lift, string name, V[] values, bool single)
            {
                double A(int index) => ((Num)values[index]).Real;
                if (single)
                {
                    float a = (float)A(0);
                    switch (name)
                    {
                        case "Sign": return float.IsNaN(a) ? lift.Throw("Sign of NaN", Num.Int(0)) : Num.Int(MathF.Sign(a));
                        case "Clamp":
                            return (float)A(1) > (float)A(2) ? lift.Throw("Clamp with min > max", values[0]) : Num.Float(Math.Clamp(a, (float)A(1), (float)A(2)));
                    }
                    return Num.Float(name switch
                    {
                        "Sqrt" => MathF.Sqrt(a), "Abs" => MathF.Abs(a), "Floor" => MathF.Floor(a), "Ceiling" => MathF.Ceiling(a),
                        "Sin" => MathF.Sin(a), "Cos" => MathF.Cos(a), "Tan" => MathF.Tan(a), "Exp" => MathF.Exp(a), "Log" when values.Length == 1 => MathF.Log(a),
                        "Atan2" => MathF.Atan2(a, (float)A(1)), "Pow" => MathF.Pow(a, (float)A(1)), "Atan" => MathF.Atan(a),
                        "Asin" => MathF.Asin(a), "Acos" => MathF.Acos(a), "Round" when values.Length == 1 => MathF.Round(a),
                        "Min" => MathF.Min(a, (float)A(1)), "Max" => MathF.Max(a, (float)A(1)), "Truncate" => MathF.Truncate(a),
                        _ => throw new Refusal($"calls MathF.{name}, which the lift does not fold"),
                    });
                }
                double d = A(0);
                switch (name)
                {
                    case "Sign": return double.IsNaN(d) ? lift.Throw("Sign of NaN", Num.Int(0)) : Num.Int(Math.Sign(d));
                    case "Clamp": return A(1) > A(2) ? lift.Throw("Clamp with min > max", values[0]) : Num.Double(Math.Clamp(d, A(1), A(2)));
                }
                return Num.Double(name switch
                {
                    "Sqrt" => Math.Sqrt(d), "Abs" => Math.Abs(d), "Floor" => Math.Floor(d), "Ceiling" => Math.Ceiling(d),
                    "Sin" => Math.Sin(d), "Cos" => Math.Cos(d), "Tan" => Math.Tan(d), "Exp" => Math.Exp(d), "Log" when values.Length == 1 => Math.Log(d),
                    "Atan2" => Math.Atan2(d, A(1)), "Pow" => Math.Pow(d, A(1)), "Atan" => Math.Atan(d),
                    "Asin" => Math.Asin(d), "Acos" => Math.Acos(d), "Round" when values.Length == 1 => Math.Round(d),
                    "Min" => Math.Min(d, A(1)), "Max" => Math.Max(d, A(1)), "Truncate" => Math.Truncate(d),
                    _ => throw new Refusal($"calls Math.{name}, which the lift does not fold"),
                });
            }

            private static V Round(Lift lift, int register, Kind kind) =>
                lift.Emit(kind == Kind.R4 ? lift.Builder.Float(register) : register, kind);

            /// <summary>.NET's Math.Max: NaN if either is NaN, else the larger, with +0 above -0.</summary>
            private static V Maximum(Lift lift, V a, V b, Kind kind)
            {
                // Distinct ordered values pick by <; equal zeros take a + b (+0 unless both are -0);
                // other equal values take a; a NaN anywhere makes a + b NaN.
                var zero = kind == Kind.R4 ? (V)Num.Float(0) : Num.Double(0);
                var sum = lift.Arithmetic(0x58, a, b);
                var tie = lift.Select(lift.Compare(2, a, b), lift.Select(lift.Compare(2, a, zero), sum, a), sum);
                return lift.Select(lift.Compare(0, a, b), b, lift.Select(lift.Compare(0, b, a), a, tie));
            }

            /// <summary>.NET's Math.Min: NaN if either is NaN, else the smaller, with -0 below +0.</summary>
            private static V Minimum(Lift lift, V a, V b, Kind kind)
            {
                var zero = kind == Kind.R4 ? (V)Num.Float(0) : Num.Double(0);
                // For equal zeros, -(-a + -b) is -0 unless both are +0.
                var negativeSum = lift.Negate(lift.Arithmetic(0x58, lift.Negate(a), lift.Negate(b)));
                var sum = lift.Arithmetic(0x58, a, b);
                var tie = lift.Select(lift.Compare(2, a, b), lift.Select(lift.Compare(2, a, zero), negativeSum, a), sum);
                return lift.Select(lift.Compare(0, a, b), a, lift.Select(lift.Compare(0, b, a), b, tie));
            }

            private static V VectorMember(Lift lift, Type type, string name, V[] values, Type[] parameters)
            {
                V[] Lane(V value) => value is Struct ? Lanes(value) : throw new Refusal($"{type.Name}.{name} on an unknown vector");
                V Each(Func<V, V, V> op, V left, V right)
                {
                    var l = left is Struct ? Lanes(left) : null;
                    var r = right is Struct ? Lanes(right) : null;
                    var count = (l ?? r)!.Length;
                    var lanes = new V[count];
                    for (var index = 0; index < count; index++) lanes[index] = op(l?[index] ?? left, r?[index] ?? right);
                    return Vector(type, lanes);
                }
                V Dot(V left, V right)
                {
                    var l = Lane(left);
                    var r = Lane(right);
                    var sum = lift.Arithmetic(0x5A, l[0], r[0]);
                    for (var index = 1; index < l.Length; index++) sum = lift.Arithmetic(0x58, sum, lift.Arithmetic(0x5A, l[index], r[index]));
                    return sum;
                }
                V Length(V value) => Scalar(lift, "Sqrt", [Dot(value, value)], single: true);
                switch (name)
                {
                    case "op_Addition": return Each((a, b) => lift.Arithmetic(0x58, a, b), values[0], values[1]);
                    case "op_Subtraction": return Each((a, b) => lift.Arithmetic(0x59, a, b), values[0], values[1]);
                    case "op_Multiply": case "Multiply": return Each((a, b) => lift.Arithmetic(0x5A, a, b), values[0], values[1]);
                    case "op_Division": case "Divide": return Each((a, b) => lift.Arithmetic(0x5B, a, b), values[0], values[1]);
                    case "op_UnaryNegation": case "Negate": return Vector(type, Lane(values[0]).Select(lift.Negate).ToArray());
                    case "Abs": return Vector(type, Lane(values[0]).Select(lane => Scalar(lift, "Abs", [lane], single: true)).ToArray());
                    case "Min": return Each((a, b) => Scalar(lift, "Min", [a, b], single: true), values[0], values[1]);
                    case "Max": return Each((a, b) => Scalar(lift, "Max", [a, b], single: true), values[0], values[1]);
                    case "Dot": return Dot(values[0], values[1]);
                    case "LengthSquared": return Dot(values[0], values[0]);
                    case "Length": return Length(values[0]);
                    case "Distance": return Length(Each((a, b) => lift.Arithmetic(0x59, a, b), values[0], values[1]));
                    case "DistanceSquared": { var d = Each((a, b) => lift.Arithmetic(0x59, a, b), values[0], values[1]); return Dot(d, d); }
                    case "Normalize": { var length = Length(values[0]); return Each((a, b) => lift.Arithmetic(0x5B, a, b), values[0], length); }
                    case "Cross" when type == typeof(Vector3):
                    {
                        var a = Lane(values[0]);
                        var b = Lane(values[1]);
                        V Term(int i, int j) => lift.Arithmetic(0x59, lift.Arithmetic(0x5A, a[i], b[j]), lift.Arithmetic(0x5A, a[j], b[i]));
                        return Vector(type, [Term(1, 2), Term(2, 0), Term(0, 1)]);
                    }
                    case "get_Zero": return Vector(type, Enumerable.Repeat<V>(Num.Float(0), type == typeof(Vector2) ? 2 : 3).ToArray());
                    case "get_One": return Vector(type, Enumerable.Repeat<V>(Num.Float(1), type == typeof(Vector2) ? 2 : 3).ToArray());
                    case "get_UnitX": case "get_UnitY": case "get_UnitZ":
                    {
                        var lanes = Enumerable.Repeat<V>(Num.Float(0), type == typeof(Vector2) ? 2 : 3).ToArray();
                        lanes[name[^1] - 'X'] = Num.Float(1);
                        return Vector(type, lanes);
                    }
                    default:
                        _ = parameters;
                        throw new Refusal($"calls {type.Name}.{name}, which is not a tape leaf");
                }
            }
        }
    }
}

/// <summary>
/// The browser host's entry point for rendering an author <see cref="IImplicit"/>: a registered tape, else a
/// tape lifted from the method's IL, else the per-voxel callback.
/// </summary>
internal static class BrowserImplicit
{
    private static int lifted;
    private static string? lastRefusal;

    /// <summary>How many implicit operations have run as a tape lifted from the method's IL.</summary>
    internal static int Lifted => Volatile.Read(ref lifted);

    /// <summary>Why the most recent field that was not lifted stayed on the callback, for diagnostics.</summary>
    internal static string? LastRefusal => Volatile.Read(ref lastRefusal);

    /// <summary>Forgets the counters, so a replaced author assembly leaves nothing behind.</summary>
    internal static void ResetCounters()
    {
        Volatile.Write(ref lifted, 0);
        Volatile.Write(ref lastRefusal, null);
    }

    /// <summary>Renders <paramref name="field"/> into freshly created (empty) voxels over <paramref name="bounds"/>.</summary>
    internal static void Render(LibHandle lib, VoxHandle vox, in BBox3 bounds, IImplicit field)
    {
        ArgumentNullException.ThrowIfNull(field);
        if (SdfTapeRegistry.TryRender(lib, vox, in bounds, field)) return;
        // A nonfinite sample (a lifted `throw` among them) leaves the target empty and returns 1: the
        // callback then renders the field and fails exactly where it always did.
        if (TryAdmit(field, in bounds, out var instructions, out var constants)
            && RenderCheckedNative(lib, vox, in bounds, instructions, instructions.Length / 2, constants, constants.Length) == 0)
        {
            Interlocked.Increment(ref lifted);
            return;
        }
        BrowserCallbacks.Render(lib, vox, in bounds, field);
    }

    /// <summary>Intersects existing voxels with <paramref name="field"/>.</summary>
    internal static void Intersect(LibHandle lib, VoxHandle vox, IImplicit field)
    {
        ArgumentNullException.ThrowIfNull(field);
        if (SdfTapeRegistry.TryIntersect(lib, vox, field)) return;
        // No bounds come with an intersection: a bounded field's own box, else a box around the origin,
        // which is only where the admission check samples — the native intersect uses the target's bounds.
        var sampled = field is IBoundedImplicit bounded ? bounded.oBounds : new BBox3(new Vector3(-64), new Vector3(64));
        if (TryAdmit(field, in sampled, out var instructions, out var constants)
            && IntersectCheckedNative(lib, vox, instructions, instructions.Length / 2, constants, constants.Length) == 0)
        {
            Interlocked.Increment(ref lifted);
            return;
        }
        BrowserCallbacks.Intersect(lib, vox, field);
    }

    /// <summary>How many points the admission check compares, besides the eight corners of the box.</summary>
    internal const int CheckedPoints = 256;

    /// <summary>
    /// Lifts a field the generator did not register, and admits the tape only when it is bit-identical to the
    /// method at the corners of <paramref name="bounds"/> and <see cref="CheckedPoints"/> fixed points inside it.
    /// </summary>
    /// <remarks>
    /// Only a field <see cref="SdfPurity"/> proves pure is lifted: the lift reads the live instance once, and the
    /// check calls the method off the render's own sequence, so neither may be observable.
    /// </remarks>
    internal static bool TryAdmit(IImplicit field, in BBox3 bounds, out uint[] instructions, out double[] constants)
    {
        instructions = [];
        constants = [];
        if (!SdfPurity.IsPure(field, out var impure))
        {
            Volatile.Write(ref lastRefusal, $"not proven pure: {impure}");
            return false;
        }
        if (!SdfIlTape.TryLift(field, out instructions, out constants, out var reason))
        {
            Volatile.Write(ref lastRefusal, reason);
            return false;
        }
        var points = CheckPoints(in bounds);
        var count = points.Length / 3;
        var values = new float[count];
        EvaluateNative(instructions, instructions.Length / 2, constants, constants.Length, points, count, values);
        for (var index = 0; index < count; index++)
        {
            var point = new Vector3(points[3 * index], points[(3 * index) + 1], points[(3 * index) + 2]);
            if (!SameOutcome(field, in point, values[index], out var expected))
            {
                Volatile.Write(ref lastRefusal, $"the lifted tape gives {values[index]:R} at {point}, the method {expected}");
                return false;
            }
        }
        Volatile.Write(ref lastRefusal, null);
        return true;
    }

    /// <summary>The method's outcome at a point equals the tape's: the same bits, or a failure where the tape is nonfinite.</summary>
    internal static bool SameOutcome(IImplicit field, in Vector3 point, float tape, out string expected)
    {
        float value;
        try { value = field.fSignedDistance(in point); }
        catch (Exception error)
        {
            expected = $"throws {error.GetType().Name}";
            return !float.IsFinite(tape);
        }
        expected = value.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        return float.IsFinite(value)
            ? BitConverter.SingleToInt32Bits(value) == BitConverter.SingleToInt32Bits(tape)
            : !float.IsFinite(tape);
    }

    /// <summary>The corners of the box, then fixed pseudo-random points inside it, as x, y, z triples.</summary>
    internal static float[] CheckPoints(in BBox3 bounds)
    {
        var points = new float[3 * (8 + CheckedPoints)];
        var min = bounds.vecMin;
        var max = bounds.vecMax;
        for (var corner = 0; corner < 8; corner++)
        {
            points[3 * corner] = (corner & 1) == 0 ? min.X : max.X;
            points[(3 * corner) + 1] = (corner & 2) == 0 ? min.Y : max.Y;
            points[(3 * corner) + 2] = (corner & 4) == 0 ? min.Z : max.Z;
        }
        // xorshift32 from a fixed seed: the same points every run, so an admission is reproducible.
        var state = 0x9E3779B9u;
        float Next(float low, float high)
        {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            return low + ((high - low) * (state >> 8) / (1 << 24));
        }
        for (var index = 8; index < 8 + CheckedPoints; index++)
        {
            points[3 * index] = Next(min.X, max.X);
            points[(3 * index) + 1] = Next(min.Y, max.Y);
            points[(3 * index) + 2] = Next(min.Z, max.Z);
        }
        return points;
    }

    // The checked tape entries: 0 rendered, 1 a sample was nonfinite and the target is unchanged.
    [DllImport(Config.strPicoGKLib, EntryPoint = "Voxels_RenderImplicitTapeChecked", CallingConvention = CallingConvention.Cdecl)]
    private static extern int RenderCheckedNative(
        LibHandle lib, VoxHandle vox, in BBox3 bounds, uint[] instructions, int instructionCount, double[] constants, int constantCount);

    [DllImport(Config.strPicoGKLib, EntryPoint = "Voxels_IntersectImplicitTapeChecked", CallingConvention = CallingConvention.Cdecl)]
    private static extern int IntersectCheckedNative(
        LibHandle lib, VoxHandle vox, uint[] instructions, int instructionCount, double[] constants, int constantCount);

    [DllImport(Config.strPicoGKLib, EntryPoint = "Tape_EvaluatePoints", CallingConvention = CallingConvention.Cdecl)]
    private static extern void EvaluateNative(
        uint[] instructions, int instructionCount, double[] constants, int constantCount, float[] points, int pointCount, [Out] float[] values);
}
#endif
