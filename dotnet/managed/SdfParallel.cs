// SPDX-License-Identifier: Apache-2.0
#if PICOGK_BROWSER
using System.Collections.Concurrent;
using System.Numerics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;

namespace PicoGK;

// Parallel evaluation of an author's signed-distance callback, without changing a byte of output.
//
// The browser fallback for a field the tape cannot express calls the author's method once per voxel,
// on the thread that asked for the render, in x, y, z order. A pure method returns the same value
// whatever thread runs it and whenever, so its samples can be computed ahead of the native loop on
// every core and handed back in that loop's own order. "Pure" is not assumed: SdfPurity reads the
// method's IL (and everything it calls) on the live instance and admits it only when no reachable
// instruction can write state another sample could observe. Anything it cannot prove stays serial.
//
// Exactness does not depend on predicting the native loop correctly either. SdfColumnPrefetch learns
// the row's z values and the column's y values from the points native actually asks for, evaluates the
// next column in parallel, and serves a precomputed sample only when the requested point is bit-equal to
// the one it was computed for. A thrown exception or a nonfinite value is returned at exactly the index
// where the serial loop would have produced it, so native stops at the same voxel with the same error.

/// <summary>Conservative proof that an author's signed-distance method has no observable side effects.</summary>
internal static class SdfPurity
{
    private const int MaximumDepth = 24;
    private const int MaximumInstructions = 200_000;

    private static readonly ConditionalWeakTable<object, StrongBox<(bool Pure, string? Reason)>> Cache = new();

    /// <summary>Whether every call of <paramref name="field"/>'s signed-distance method is free of side effects.</summary>
    /// <param name="field">The live instance about to be rendered.</param>
    /// <param name="reason">Why it is not, naming the first instruction or call that could not be proven.</param>
    internal static bool IsPure(IImplicit field, out string? reason)
    {
        if (Cache.TryGetValue(field, out var cached))
        {
            reason = cached.Value.Reason;
            return cached.Value.Pure;
        }
        var (pure, why, settled) = Analyze(field);
        // A verdict that read a reassignable reference field is about the objects that field held then;
        // the author may assign another before the next render, so only a settled verdict is kept.
        if (settled) Cache.AddOrUpdate(field, new((pure, why)));
        reason = why;
        return pure;
    }

    private static (bool Pure, string? Reason, bool Settled) Analyze(IImplicit field)
    {
        try
        {
            var method = Implementation(field.GetType(), typeof(IImplicit).GetMethod(nameof(IImplicit.fSignedDistance))!);
            if (method is null) return (false, "the signed-distance implementation could not be resolved", true);
            var walk = new Walk();
            var receiver = field.GetType().IsValueType ? Value.Other : Value.Of(field);
            walk.Method(method, [receiver, Value.Point], 0);
            return walk.Reason is null ? (true, null, walk.Settled) : (false, walk.Reason, walk.Settled);
        }
        catch (Exception error)
        {
            // An analysis failure is never a reason to run in parallel.
            return (false, $"analysis failed: {error.GetType().Name}: {error.Message}", false);
        }
    }

    /// <summary>The method <paramref name="type"/> actually runs for an interface or virtual <paramref name="method"/>.</summary>
    internal static MethodInfo? Implementation(Type type, MethodInfo method)
    {
        if (method.DeclaringType is { IsInterface: true } contract)
        {
            if (!contract.IsAssignableFrom(type)) return null;
            for (var current = type; current is not null; current = current.BaseType)
            {
                var map = current.GetInterfaceMap(contract);
                for (var index = 0; index < map.InterfaceMethods.Length; index++)
                {
                    if (map.InterfaceMethods[index] == method || SameSlot(map.InterfaceMethods[index], method))
                        return map.TargetMethods[index].IsAbstract ? null : map.TargetMethods[index];
                }
            }
            return null;
        }
        if (!method.IsVirtual || method.IsFinal) return method;
        var definition = method.GetBaseDefinition();
        for (var current = type; current is not null; current = current.BaseType)
        {
            foreach (var candidate in current.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            {
                if (candidate.GetBaseDefinition() == definition) return candidate.IsAbstract ? null : candidate;
            }
        }
        return null;
    }

    private static bool SameSlot(MethodInfo left, MethodInfo right) =>
        left.MetadataToken == right.MetadataToken && left.Module == right.Module;

    /// <summary>An abstract value: where a stack slot, local or argument came from.</summary>
    internal readonly record struct Value(Value.Kinds Kind, object? Known)
    {
        internal enum Kinds
        {
            /// <summary>A number, or anything that cannot be written through.</summary>
            Scalar,
            /// <summary>The address of storage this evaluation owns: a local, an argument slot, or an object or array it allocated.</summary>
            Owned,
            /// <summary>A reference to an object that existed before the evaluation, with its identity known.</summary>
            Object,
            /// <summary>The address of the native sample point.</summary>
            PointAddress,
            /// <summary>Anything else: readable, never writable, and not resolvable for a virtual call.</summary>
            Shared,
        }

        internal static readonly Value Number = new(Kinds.Scalar, null);
        internal static readonly Value Local = new(Kinds.Owned, null);
        internal static readonly Value Point = new(Kinds.PointAddress, null);
        internal static readonly Value Other = new(Kinds.Shared, null);

        internal static Value Of(object? instance) => instance is null ? Number : new(Kinds.Object, instance);

        internal static Value Join(Value left, Value right)
        {
            if (left.Kind == right.Kind && ReferenceEquals(left.Known, right.Known)) return left;
            if (left.Kind == Kinds.Scalar && right.Kind == Kinds.Scalar) return Number;
            // Joining an owned address with anything else could be either, so it may not be written.
            return Other;
        }
    }

    private sealed class Walk
    {
        internal string? Reason;
        /// <summary>False once the walk read a reference field that is not readonly.</summary>
        internal bool Settled = true;
        private int instructions;
        private readonly HashSet<(MethodBase, object?)> active = new();
        private readonly Dictionary<(MethodBase, Arguments), Value> finished = new();

        private void Refuse(MethodBase method, string because) =>
            Reason ??= $"{method.DeclaringType?.FullName}.{method.Name}: {because}";

        /// <summary>Analyzes one method body for the given argument values and returns the value it returns.</summary>
        internal Value Method(MethodBase method, Value[] arguments, int depth)
        {
            if (Reason is not null) return Value.Other;
            if (depth > MaximumDepth) { Refuse(method, "calls nest too deeply to analyze"); return Value.Other; }
            var key = new Arguments(arguments);
            if (finished.TryGetValue((method, key), out var known)) return known;
            var receiver = arguments.Length > 0 ? arguments[0].Known : null;
            // Recursion cannot be bounded statically; it is not admitted.
            if (!active.Add((method, receiver))) { Refuse(method, "is recursive"); return Value.Other; }
            try
            {
                var result = Body(method, arguments, depth);
                finished[(method, key)] = result;
                return result;
            }
            finally { active.Remove((method, receiver)); }
        }

        /// <summary>A memo key that compares known objects by identity, never by a hash code that two can share.</summary>
        private sealed class Arguments(Value[] values) : IEquatable<Arguments>
        {
            private readonly Value[] values = values;

            public bool Equals(Arguments? other)
            {
                if (other is null || other.values.Length != values.Length) return false;
                for (var index = 0; index < values.Length; index++)
                {
                    if (values[index].Kind != other.values[index].Kind || !ReferenceEquals(values[index].Known, other.values[index].Known))
                        return false;
                }
                return true;
            }

            public override bool Equals(object? obj) => Equals(obj as Arguments);

            public override int GetHashCode()
            {
                var hash = new HashCode();
                foreach (var value in values)
                {
                    hash.Add(value.Kind);
                    hash.Add(value.Known is null ? 0 : RuntimeHelpers.GetHashCode(value.Known));
                }
                return hash.ToHashCode();
            }
        }

        private Value Body(MethodBase method, Value[] arguments, int depth)
        {
            MethodBody? body;
            byte[]? il;
            try { body = method.GetMethodBody(); il = body?.GetILAsByteArray(); }
            catch (Exception) { body = null; il = null; }
            if (body is null || il is null || il.Length == 0)
            {
                Refuse(method, "has no readable IL body");
                return Value.Other;
            }
            var decoded = IlReader.Decode(il);
            if (decoded is null) { Refuse(method, "contains an instruction this reader does not decode"); return Value.Other; }
            var locals = body.LocalVariables.Count;
            var frame = new Frame(method, arguments, locals, decoded, depth, this);
            return frame.Run(body.ExceptionHandlingClauses);
        }

        /// <summary>One method's abstract interpretation over its basic blocks, to a fixed point.</summary>
        private sealed class Frame(MethodBase method, Value[] arguments, int localCount, IlReader.Instruction[] code, int depth, Walk walk)
        {
            private readonly Dictionary<int, State> entries = new();
            private readonly Dictionary<int, int> indexOf = code.Select((instruction, index) => (instruction.Offset, index))
                .ToDictionary(pair => pair.Offset, pair => pair.index);
            private Value returned = Value.Number;
            private bool returnedAny;

            private sealed record State(Value[] Stack, Value[] Locals, Value[] Arguments)
            {
                internal State Copy() => new((Value[])Stack.Clone(), (Value[])Locals.Clone(), (Value[])Arguments.Clone());
            }

            internal Value Run(IList<ExceptionHandlingClause> clauses)
            {
                var start = new State([], Enumerable.Repeat(Value.Number, localCount).ToArray(), (Value[])arguments.Clone());
                var work = new Stack<int>();
                Merge(0, start, work);
                foreach (var clause in clauses)
                {
                    // A handler begins with the exception object (catch, filter) or an empty stack.
                    var stack = clause.Flags is ExceptionHandlingClauseOptions.Clause or ExceptionHandlingClauseOptions.Filter
                        ? new[] { Value.Other } : [];
                    Merge(clause.HandlerOffset, start with { Stack = stack }, work);
                    if (clause.Flags == ExceptionHandlingClauseOptions.Filter)
                        Merge(clause.FilterOffset, start with { Stack = [Value.Other] }, work);
                }
                while (work.Count > 0 && walk.Reason is null)
                {
                    var offset = work.Pop();
                    Execute(offset, entries[offset].Copy(), work);
                }
                return returnedAny ? returned : Value.Number;
            }

            private void Merge(int offset, State state, Stack<int> work)
            {
                if (!indexOf.ContainsKey(offset)) { walk.Refuse(method, $"branches to IL_{offset:x4}, which is not an instruction"); return; }
                if (!entries.TryGetValue(offset, out var existing))
                {
                    entries[offset] = state.Copy();
                    work.Push(offset);
                    return;
                }
                if (existing.Stack.Length != state.Stack.Length) { walk.Refuse(method, "has an inconsistent stack depth"); return; }
                var changed = false;
                changed |= JoinInto(existing.Stack, state.Stack);
                changed |= JoinInto(existing.Locals, state.Locals);
                changed |= JoinInto(existing.Arguments, state.Arguments);
                if (changed) work.Push(offset);
            }

            private static bool JoinInto(Value[] target, Value[] source)
            {
                var changed = false;
                for (var index = 0; index < target.Length; index++)
                {
                    var joined = Value.Join(target[index], source[index]);
                    if (joined != target[index]) { target[index] = joined; changed = true; }
                }
                return changed;
            }

            private void Execute(int offset, State state, Stack<int> work)
            {
                var stack = new Stack<Value>(state.Stack);
                Type? constrained = null;
                for (var index = indexOf[offset]; index < code.Length && walk.Reason is null; index++)
                {
                    if (++walk.instructions > MaximumInstructions) { walk.Refuse(method, "is too large to analyze"); return; }
                    var instruction = code[index];
                    var next = index + 1 < code.Length ? code[index + 1].Offset : -1;
                    var flow = Step(instruction, stack, state, ref constrained);
                    if (walk.Reason is not null) return;
                    State Snapshot() => new(stack.Reverse().ToArray(), state.Locals, state.Arguments);
                    switch (flow)
                    {
                        case Flow.Next:
                            if (next >= 0 && entries.ContainsKey(next) && index + 1 < code.Length && IsJoin(next))
                            {
                                Merge(next, Snapshot(), work);
                                return;
                            }
                            continue;
                        case Flow.Branch:
                            Merge(instruction.Targets[0], Snapshot(), work);
                            return;
                        case Flow.Conditional:
                            foreach (var target in instruction.Targets) Merge(target, Snapshot(), work);
                            if (next >= 0) Merge(next, Snapshot(), work);
                            return;
                        case Flow.Leave:
                            // Leaving a protected region empties the stack.
                            Merge(instruction.Targets[0], new State([], state.Locals, state.Arguments), work);
                            return;
                        case Flow.End:
                            return;
                    }
                }
            }

            private bool IsJoin(int offset) => entries.ContainsKey(offset);

            private enum Flow { Next, Branch, Conditional, Leave, End }

            private Value Pop(Stack<Value> stack)
            {
                if (stack.Count == 0) { walk.Refuse(method, "pops an empty stack"); return Value.Other; }
                return stack.Pop();
            }

            private void Write(Value target, string what)
            {
                if (target.Kind != Value.Kinds.Owned)
                    walk.Refuse(method, $"{what} writes to storage the evaluation does not own");
            }

            private Flow Step(IlReader.Instruction instruction, Stack<Value> stack, State state, ref Type? constrained)
            {
                var op = instruction.Code;
                switch (op)
                {
                    case 0x00: case 0xFE13: case 0xFE1E: case 0xFE12: case 0xFE19: case 0xFE14: return Flow.Next; // nop and prefixes
                    case 0xFE16: constrained = Module.ResolveType(instruction.Token, GenericTypes, GenericMethods); return Flow.Next;
                    // Arguments and locals: their slots belong to this evaluation.
                    case 0x02: case 0x03: case 0x04: case 0x05: stack.Push(Argument(state, op - 0x02)); return Flow.Next;
                    case 0x0E: case 0xFE09: stack.Push(Argument(state, instruction.Index)); return Flow.Next;
                    case 0x0F: case 0xFE0A: stack.Push(Value.Local); return Flow.Next;
                    case 0x10: case 0xFE0B: SetArgument(state, instruction.Index, Pop(stack)); return Flow.Next;
                    case 0x06: case 0x07: case 0x08: case 0x09: stack.Push(Local(state, op - 0x06)); return Flow.Next;
                    case 0x11: case 0xFE0C: stack.Push(Local(state, instruction.Index)); return Flow.Next;
                    case 0x12: case 0xFE0D: stack.Push(Value.Local); return Flow.Next;
                    case 0x0A: case 0x0B: case 0x0C: case 0x0D: SetLocal(state, op - 0x0A, Pop(stack)); return Flow.Next;
                    case 0x13: case 0xFE0E: SetLocal(state, instruction.Index, Pop(stack)); return Flow.Next;
                    // Constants.
                    case 0x14: case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: case 0x1A: case 0x1B: case 0x1C:
                    case 0x1D: case 0x1E: case 0x1F: case 0x20: case 0x21: case 0x22: case 0x23: case 0x72: case 0xD0:
                        stack.Push(Value.Number); return Flow.Next;
                    case 0x25: { var top = Pop(stack); stack.Push(top); stack.Push(top); return Flow.Next; }
                    case 0x26: Pop(stack); return Flow.Next;
                    case 0x2A:
                        if (stack.Count > 0) { var value = stack.Pop(); returned = returnedAny ? Value.Join(returned, value) : value; returnedAny = true; }
                        return Flow.End;
                    case 0x7A: Pop(stack); return Flow.End; // throw: a deterministic outcome, replayed in order
                    case 0xFE1A: return Flow.End; // rethrow
                    case 0xDC: case 0xFE11: if (op == 0xFE11) Pop(stack); return Flow.End; // endfinally, endfilter
                    case 0x2B: case 0x38: return Flow.Branch;
                    case 0x2C: case 0x2D: case 0x39: case 0x3A: Pop(stack); return Flow.Conditional;
                    case >= 0x2E and <= 0x37: case >= 0x3B and <= 0x44: Pop(stack); Pop(stack); return Flow.Conditional;
                    case 0x45: Pop(stack); return Flow.Conditional; // switch
                    case 0xDD: case 0xDE: stack.Clear(); return Flow.Leave;
                    // Loads through an address read; a loaded reference is not one this evaluation owns.
                    case >= 0x46 and <= 0x4F: Pop(stack); stack.Push(Value.Number); return Flow.Next;
                    case 0x50: Pop(stack); stack.Push(Value.Other); return Flow.Next;
                    case 0x71: Pop(stack); stack.Push(Value.Number); return Flow.Next; // ldobj
                    // Stores through an address must target owned storage.
                    case 0x51: case >= 0x52 and <= 0x57: case 0xDF: case 0x81:
                        { Pop(stack); Write(Pop(stack), "a store through an address"); return Flow.Next; }
                    case 0xFE15: Write(Pop(stack), "initobj"); return Flow.Next;
                    case 0x70: { Pop(stack); Write(Pop(stack), "cpobj"); return Flow.Next; }
                    // Arithmetic, comparison and conversion: values in, a value out.
                    case >= 0x58 and <= 0x64: case 0xD6: case 0xD7: case 0xD8: case 0xD9: case 0xDA: case 0xDB:
                    case 0xFE01: case 0xFE02: case 0xFE03: case 0xFE04: case 0xFE05:
                        Pop(stack); Pop(stack); stack.Push(Value.Number); return Flow.Next;
                    case 0x65: case 0x66: case >= 0x67 and <= 0x6E: case 0x76: case >= 0x82 and <= 0x8B: case >= 0xB3 and <= 0xBA:
                    case 0xC3: case 0xD1: case 0xD2: case 0xD3: case 0xD4: case 0xD5: case 0xE0:
                        Pop(stack); stack.Push(Value.Number); return Flow.Next;
                    // Fields.
                    case 0x7B: return LoadField(instruction, stack, address: false);
                    case 0x7C: return LoadField(instruction, stack, address: true);
                    case 0x7D:
                        { Pop(stack); Write(Pop(stack), "stfld"); return Flow.Next; }
                    case 0x7E: stack.Push(Value.Other); return Flow.Next; // ldsfld: read, identity not resolved
                    case 0x7F: stack.Push(Value.Other); return Flow.Next; // ldsflda: readable only
                    case 0x80: walk.Refuse(method, "writes a static field"); return Flow.End;
                    // Objects and arrays.
                    case 0x8D: Pop(stack); stack.Push(Value.Local); return Flow.Next; // newarr: owned
                    case 0x8E: Pop(stack); stack.Push(Value.Number); return Flow.Next; // ldlen
                    case 0x8F: { Pop(stack); var array = Pop(stack); stack.Push(array.Kind == Value.Kinds.Owned ? Value.Local : Value.Other); return Flow.Next; }
                    case >= 0x90 and <= 0x99: case 0xA3:
                        {
                            Pop(stack); var array = Pop(stack);
                            stack.Push(op == 0xA3 && array.Known is Array known ? Element(known, instruction) : Value.Number);
                            return Flow.Next;
                        }
                    case 0x9A:
                        { Pop(stack); var array = Pop(stack); stack.Push(Value.Other); _ = array; return Flow.Next; }
                    case >= 0x9B and <= 0xA2: case 0xA4:
                        { Pop(stack); Pop(stack); Write(Pop(stack), "an array store"); return Flow.Next; }
                    case 0x8C: Pop(stack); stack.Push(Value.Local); return Flow.Next; // box: a fresh object
                    case 0x79: case 0xA5: Pop(stack); stack.Push(op == 0x79 ? Value.Other : Value.Number); return Flow.Next;
                    case 0x74: case 0x75: return Flow.Next; // castclass, isinst keep the reference
                    case 0xFE1C: stack.Push(Value.Number); return Flow.Next; // sizeof
                    case 0xFE0F: Pop(stack); stack.Push(Value.Local); return Flow.Next; // localloc: owned
                    case 0xFE06: stack.Push(Value.Other); return Flow.Next; // ldftn
                    case 0xFE07: Pop(stack); stack.Push(Value.Other); return Flow.Next;
                    case 0x28: case 0x6F: case 0x73:
                        {
                            var flow = Call(instruction, stack, op, constrained);
                            constrained = null;
                            return flow;
                        }
                    default:
                        walk.Refuse(method, $"uses IL opcode 0x{op:x} that is not admitted");
                        return Flow.End;
                }
            }

            private Module Module => method.Module;
            private Type[]? GenericTypes => method.DeclaringType is { IsGenericType: true } type ? type.GetGenericArguments() : null;
            private Type[]? GenericMethods => method.IsGenericMethod ? method.GetGenericArguments() : null;

            private Value Argument(State state, int index) =>
                index < state.Arguments.Length ? state.Arguments[index] : Fault("reads an argument it was not given");

            private void SetArgument(State state, int index, Value value)
            {
                if (index < state.Arguments.Length) state.Arguments[index] = value; else Fault("writes an argument it was not given");
            }

            private Value Local(State state, int index) =>
                index < state.Locals.Length ? state.Locals[index] : Fault("reads a local it does not declare");

            private void SetLocal(State state, int index, Value value)
            {
                if (index < state.Locals.Length) state.Locals[index] = value; else Fault("writes a local it does not declare");
            }

            private Value Fault(string because)
            {
                walk.Refuse(method, because);
                return Value.Other;
            }

            private static Value Element(Array array, IlReader.Instruction instruction)
            {
                _ = instruction;
                // A reference element of a pre-existing array is shared; its identity is not tracked.
                return array.GetType().GetElementType() is { IsValueType: true } ? Value.Number : Value.Other;
            }

            private Flow LoadField(IlReader.Instruction instruction, Stack<Value> stack, bool address)
            {
                var field = Module.ResolveField(instruction.Token, GenericTypes, GenericMethods)!;
                var owner = Pop(stack);
                if (address)
                {
                    stack.Push(owner.Kind switch
                    {
                        Value.Kinds.Owned => Value.Local,
                        Value.Kinds.PointAddress => Value.Point,
                        _ => Value.Other,
                    });
                    return Flow.Next;
                }
                if (field.FieldType.IsValueType && !field.FieldType.IsByRefLike)
                {
                    stack.Push(Value.Number);
                    return Flow.Next;
                }
                // A reference field of a known object is read now: render is synchronous and only a pure
                // callback runs during it, so this is the value every sample would read.
                if (owner.Kind == Value.Kinds.Object && owner.Known is { } instance && !field.IsStatic)
                {
                    if (!field.IsInitOnly) walk.Settled = false;
                    stack.Push(Value.Of(field.GetValue(instance)));
                    return Flow.Next;
                }
                stack.Push(Value.Other);
                return Flow.Next;
            }

            private Flow Call(IlReader.Instruction instruction, Stack<Value> stack, int op, Type? constrained)
            {
                var callee = Module.ResolveMethod(instruction.Token, GenericTypes, GenericMethods)!;
                var parameters = callee.GetParameters();
                // newobj supplies `this` itself; a call or callvirt pops it with the arguments.
                var hasThis = !callee.IsStatic && op != 0x73;
                var values = new Value[parameters.Length + (hasThis ? 1 : 0)];
                for (var index = values.Length - 1; index >= 0; index--) values[index] = Pop(stack);
                if (op == 0x73)
                {
                    // newobj: `this` is the fresh object or value-type temporary.
                    var constructed = new Value[values.Length + 1];
                    constructed[0] = Value.Local;
                    Array.Copy(values, 0, constructed, 1, values.Length);
                    values = constructed;
                }
                var target = callee;
                if (op == 0x6F && callee is MethodInfo virtualMethod && (virtualMethod.IsVirtual && !virtualMethod.IsFinal || callee.DeclaringType!.IsInterface))
                {
                    Type? runtime = constrained ?? (values[0].Known?.GetType());
                    if (values[0].Known is Delegate dispatch && callee.Name == "Invoke" && callee.DeclaringType!.IsSubclassOf(typeof(Delegate)))
                    {
                        var invocations = dispatch.GetInvocationList();
                        if (invocations.Length != 1) { walk.Refuse(method, "invokes a multicast delegate"); return Flow.End; }
                        var bound = new Value[values.Length - 1 + (invocations[0].Method.IsStatic ? 0 : 1)];
                        var offset = 0;
                        if (!invocations[0].Method.IsStatic) bound[offset++] = Value.Of(invocations[0].Target);
                        Array.Copy(values, 1, bound, offset, values.Length - 1);
                        var delegated = walk.Method(invocations[0].Method, bound, depth + 1);
                        Push(stack, callee, delegated);
                        return Flow.Next;
                    }
                    if (runtime is null || runtime.IsInterface || runtime.IsAbstract)
                    {
                        if (!PureLeaf(callee)) { walk.Refuse(method, $"makes a virtual call to {callee.DeclaringType?.Name}.{callee.Name} on an object it cannot identify"); return Flow.End; }
                    }
                    else
                    {
                        target = Implementation(runtime, virtualMethod) ?? callee;
                    }
                }
                if (PureLeaf(target))
                {
                    // A leaf reads its arguments and writes only through a by-reference argument it was given,
                    // or, for a mutating member of a struct (an indexer's setter, say), through its receiver.
                    if (op != 0x73 && !target.IsStatic && target.DeclaringType!.IsValueType && !ReadOnlyMember(target))
                        Write(values[0], $"{target.Name} on its receiver");
                    var leafParameters = target.GetParameters();
                    for (var index = 0; index < leafParameters.Length; index++)
                    {
                        if (leafParameters[index].ParameterType.IsByRef && !leafParameters[index].IsIn)
                            Write(values[index + (target.IsStatic ? 0 : 1)], $"{target.Name}'s out argument");
                    }
                    Push(stack, target, Value.Number, op == 0x73);
                    return Flow.Next;
                }
                var result = walk.Method(target, values, depth + 1);
                Push(stack, target, result, op == 0x73);
                return Flow.Next;
            }

            private static void Push(Stack<Value> stack, MethodBase callee, Value result, bool constructed = false)
            {
                if (constructed) { stack.Push(callee.DeclaringType!.IsValueType ? Value.Number : Value.Local); return; }
                if (callee is MethodInfo info && info.ReturnType != typeof(void))
                    stack.Push(info.ReturnType.IsValueType ? Value.Number : result.Kind == Value.Kinds.Owned ? Value.Local : result.Kind == Value.Kinds.Object ? result : Value.Other);
            }
        }
    }

    // Library methods whose bodies the browser host may not keep as IL (ahead-of-time compiled, then
    // stripped) and which are documented as pure: they read their arguments and write nothing else.
    private static readonly HashSet<Type> PureTypes =
    [
        typeof(Math), typeof(MathF), typeof(Vector2), typeof(Vector3), typeof(Vector4), typeof(Quaternion),
        typeof(Matrix3x2), typeof(Matrix4x4), typeof(Plane), typeof(float), typeof(double), typeof(int),
        typeof(long), typeof(uint), typeof(ulong), typeof(short), typeof(ushort), typeof(byte), typeof(sbyte),
        typeof(bool), typeof(Half), typeof(decimal), typeof(System.Numerics.Vector),
    ];

    private static readonly HashSet<string> Mutators = ["CopyTo", "TryCopyTo"];

    /// <summary>A struct member that cannot write its receiver: declared readonly, or on a readonly struct.</summary>
    private static bool ReadOnlyMember(MethodBase method) =>
        method.IsDefined(typeof(IsReadOnlyAttribute), false)
        || method.DeclaringType!.IsDefined(typeof(IsReadOnlyAttribute), false);

    private static bool PureLeaf(MethodBase method)
    {
        var type = method.DeclaringType;
        if (type is null) return false;
        if (PureTypes.Contains(type) || type.IsGenericType && PureTypes.Contains(type.GetGenericTypeDefinition()))
        {
            if (Mutators.Contains(method.Name) || method.Name.StartsWith("Write", StringComparison.Ordinal)
                || method.Name.StartsWith("Store", StringComparison.Ordinal)) return false;
            // A pointer or a writable span can address storage whose owner the walk cannot see.
            return method.GetParameters().All(static parameter =>
                !parameter.ParameterType.IsPointer
                && !(parameter.ParameterType.IsGenericType && parameter.ParameterType.GetGenericTypeDefinition() == typeof(Span<>)));
        }
        // Building an exception to throw allocates and writes only the new object.
        if (method.IsConstructor && typeof(Exception).IsAssignableFrom(type) && type.Assembly == typeof(Exception).Assembly) return true;
        if (type == typeof(string) && method.Name == nameof(string.Concat)) return true;
        if (type == typeof(object) && method.IsConstructor) return true;
        return false;
    }
}

/// <summary>Decodes the method-body IL the purity walk reads.</summary>
internal static class IlReader
{
    /// <param name="Integer">The ldc.i4 or ldc.i8 constant.</param>
    /// <param name="Real">The ldc.r4 or ldc.r8 constant (an ldc.r4 value is exactly representable as a double).</param>
    internal readonly record struct Instruction(int Offset, int Code, int Token, int Index, int[] Targets, long Integer = 0, double Real = 0);

    private enum Operand { None, Byte, Short, Int, Long, Token, Branch8, Branch32, Switch, Int8, Float32, Float64, UShort }

    internal static Instruction[]? Decode(byte[] il)
    {
        var result = new List<Instruction>();
        var position = 0;
        while (position < il.Length)
        {
            var offset = position;
            int code = il[position++];
            if (code == 0xFE)
            {
                if (position >= il.Length) return null;
                code = 0xFE00 | il[position++];
            }
            var operand = OperandOf(code);
            if (operand is null) return null;
            int token = 0, index = 0;
            long integer = 0;
            double real = 0;
            int[] targets = [];
            switch (operand)
            {
                case Operand.None: break;
                case Operand.Byte: index = il[position]; position += 1; break;
                case Operand.Int8: index = il[position]; integer = (sbyte)il[position]; position += 1; break;
                case Operand.UShort: index = BitConverter.ToUInt16(il, position); position += 2; break;
                case Operand.Int: integer = BitConverter.ToInt32(il, position); position += 4; break;
                case Operand.Float32: real = BitConverter.ToSingle(il, position); position += 4; break;
                case Operand.Long: integer = BitConverter.ToInt64(il, position); position += 8; break;
                case Operand.Float64: real = BitConverter.ToDouble(il, position); position += 8; break;
                case Operand.Token: token = BitConverter.ToInt32(il, position); position += 4; break;
                case Operand.Branch8:
                    { var delta = (sbyte)il[position]; position += 1; targets = [position + delta]; break; }
                case Operand.Branch32:
                    { var delta = BitConverter.ToInt32(il, position); position += 4; targets = [position + delta]; break; }
                case Operand.Switch:
                    {
                        var count = BitConverter.ToInt32(il, position); position += 4;
                        var end = position + 4 * count;
                        targets = new int[count];
                        for (var i = 0; i < count; i++) targets[i] = end + BitConverter.ToInt32(il, position + 4 * i);
                        position = end;
                        break;
                    }
            }
            if (position > il.Length) return null;
            result.Add(new Instruction(offset, code, token, index, targets, integer, real));
        }
        return [.. result];
    }

    private static Operand? OperandOf(int code) => code switch
    {
        >= 0x00 and <= 0x0D => Operand.None,
        >= 0x0E and <= 0x13 => Operand.Byte,
        >= 0x14 and <= 0x1E => Operand.None,
        0x1F => Operand.Int8,
        0x20 => Operand.Int,
        0x21 => Operand.Long,
        0x22 => Operand.Float32,
        0x23 => Operand.Float64,
        0x25 or 0x26 => Operand.None,
        0x27 or 0x28 or 0x29 => Operand.Token,
        0x2A => Operand.None,
        >= 0x2B and <= 0x37 => Operand.Branch8,
        >= 0x38 and <= 0x44 => Operand.Branch32,
        0x45 => Operand.Switch,
        >= 0x46 and <= 0x6E => Operand.None,
        >= 0x6F and <= 0x75 => Operand.Token,
        0x76 => Operand.None,
        0x79 => Operand.Token,
        0x7A => Operand.None,
        >= 0x7B and <= 0x81 => Operand.Token,
        >= 0x82 and <= 0x8B => Operand.None,
        0x8C or 0x8D => Operand.Token,
        0x8E => Operand.None,
        0x8F => Operand.Token,
        >= 0x90 and <= 0xA2 => Operand.None,
        0xA3 or 0xA4 or 0xA5 => Operand.Token,
        >= 0xB3 and <= 0xBA => Operand.None,
        0xC2 => Operand.Token,
        0xC3 => Operand.None,
        0xC6 => Operand.Token,
        0xD0 => Operand.Token,
        >= 0xD1 and <= 0xDC => Operand.None,
        0xDD => Operand.Branch32,
        0xDE => Operand.Branch8,
        0xDF or 0xE0 => Operand.None,
        >= 0xFE00 and <= 0xFE05 => Operand.None,
        0xFE06 or 0xFE07 => Operand.Token,
        >= 0xFE09 and <= 0xFE0E => Operand.UShort,
        0xFE0F or 0xFE11 => Operand.None,
        0xFE12 => Operand.Byte,
        0xFE13 or 0xFE14 => Operand.None,
        0xFE15 or 0xFE16 => Operand.Token,
        0xFE17 or 0xFE18 => Operand.None,
        0xFE19 => Operand.Byte,
        0xFE1A => Operand.None,
        0xFE1C => Operand.Token,
        0xFE1D or 0xFE1E => Operand.None,
        _ => null,
    };
}

/// <summary>
/// Computes an author's pure signed-distance samples ahead of the native fill, one column of rows at a
/// time on every core, and serves each only when native asks for exactly the point it was computed for.
/// </summary>
internal sealed class SdfColumnPrefetch(IImplicit field, int parallelism)
{
    private static int served;
    private static int columns;
    private static int discarded;

    /// <summary>Samples served from a precomputed column (diagnostic only).</summary>
    internal static int Served => Volatile.Read(ref served);

    /// <summary>Columns evaluated in parallel (diagnostic only).</summary>
    internal static int Columns => Volatile.Read(ref columns);

    /// <summary>Columns dropped because native asked for a point other than the predicted one.</summary>
    internal static int Discarded => Volatile.Read(ref discarded);

    internal static void ResetCounters()
    {
        Volatile.Write(ref served, 0);
        Volatile.Write(ref columns, 0);
        Volatile.Write(ref discarded, 0);
    }

    /// <summary>Whether a render of <paramref name="field"/> should prefetch, and with how many workers.</summary>
    internal static SdfColumnPrefetch? For(IImplicit field)
    {
        // The serial browser build has one thread and cannot block on another; it keeps the plain callback.
        var workers = Environment.ProcessorCount;
        if (!RuntimeFeature.IsMultithreadingSupported || workers < 2) return null;
        return SdfPurity.IsPure(field, out _) ? new SdfColumnPrefetch(field, workers) : null;
    }

    private const int GiveUpAfterDiscards = 4;

    // What the native loop has shown so far: the z values of one row, then the y values of one column.
    private readonly List<float> zs = [];
    private readonly List<float> ys = [];
    private bool rowKnown;
    private bool columnKnown;
    private float firstX;
    private float rowY;
    private bool started;
    private bool disabled;
    private int drops;

    // The column currently precomputed.
    private float columnX;
    private float[]? values;
    private ExceptionDispatchInfo?[]? errors;
    private int cursor;

    /// <summary>
    /// Returns true and the precomputed outcome when <paramref name="point"/> is the next point of the
    /// current column; returns false when the caller must evaluate it itself.
    /// </summary>
    internal bool TryServe(in Vector3 point, out float value, out ExceptionDispatchInfo? error)
    {
        value = 0;
        error = null;
        if (disabled) return false;
        Learn(point);
        if (values is null && columnKnown && Starts(point)) Compute(point.X);
        if (values is null) return false;
        var length = zs.Count;
        var expected = new Vector3(columnX, ys[cursor / length], zs[cursor % length]);
        if (!SameBits(point, expected))
        {
            Drop();
            // The point may begin a new column whose shape still matches; try once more.
            if (columnKnown && Starts(point)) { Compute(point.X); return TryServe(point, out value, out error); }
            return false;
        }
        value = values[cursor];
        error = errors![cursor];
        cursor++;
        Interlocked.Increment(ref served);
        if (cursor == values.Length) values = null;
        return true;
    }

    private bool Starts(in Vector3 point) =>
        BitConverter.SingleToInt32Bits(point.Y) == BitConverter.SingleToInt32Bits(ys[0])
        && BitConverter.SingleToInt32Bits(point.Z) == BitConverter.SingleToInt32Bits(zs[0]);

    private static bool SameBits(in Vector3 left, in Vector3 right) =>
        BitConverter.SingleToInt32Bits(left.X) == BitConverter.SingleToInt32Bits(right.X)
        && BitConverter.SingleToInt32Bits(left.Y) == BitConverter.SingleToInt32Bits(right.Y)
        && BitConverter.SingleToInt32Bits(left.Z) == BitConverter.SingleToInt32Bits(right.Z);

    private void Learn(in Vector3 point)
    {
        if (columnKnown) return;
        if (!started)
        {
            started = true; firstX = point.X; rowY = point.Y;
            zs.Add(point.Z); ys.Add(point.Y);
            return;
        }
        var sameX = BitConverter.SingleToInt32Bits(point.X) == BitConverter.SingleToInt32Bits(firstX);
        var sameY = BitConverter.SingleToInt32Bits(point.Y) == BitConverter.SingleToInt32Bits(rowY);
        if (!rowKnown)
        {
            if (sameX && sameY) { zs.Add(point.Z); return; }
            rowKnown = true;
        }
        if (sameX && !sameY) { rowY = point.Y; ys.Add(point.Y); return; }
        if (!sameX) columnKnown = true;
    }

    private void Compute(float x)
    {
        var rows = ys.Count;
        var length = zs.Count;
        var total = (long)rows * length;
        if (total > 64L * 1024 * 1024) { disabled = true; return; }
        float[] computed;
        ExceptionDispatchInfo?[] failures;
        try
        {
            computed = values is not null && values.Length == total ? values : new float[total];
            failures = errors is not null && errors.Length == total ? errors : new ExceptionDispatchInfo?[total];
            Array.Clear(failures);
            Fill(x, rows, length, computed, failures);
        }
        catch (Exception)
        {
            // The method's own exceptions are captured per sample, so this is the prefetch itself failing
            // (memory, the thread pool): serve nothing more, and the native loop calls the method directly.
            disabled = true;
            values = null;
            errors = null;
            return;
        }
        values = computed;
        errors = failures;
        columnX = x;
        cursor = 0;
        Interlocked.Increment(ref columns);
    }

    private void Fill(float x, int rows, int length, float[] computed, ExceptionDispatchInfo?[] failures)
    {
        var rowZs = zs.ToArray();
        var columnYs = ys.ToArray();
        Parallel.For(0, rows, new ParallelOptions { MaxDegreeOfParallelism = parallelism }, row =>
        {
            var start = row * length;
            for (var index = 0; index < length; index++)
            {
                var sample = new Vector3(x, columnYs[row], rowZs[index]);
                // Every sample is computed, even after a failure: whether native stops there (a thrown
                // error always stops it; a nonfinite distance stops only the checked adapter) is native's
                // decision, and a pure method has no other way to observe the extra calls.
                try { computed[start + index] = field.fSignedDistance(in sample); }
                catch (Exception failure) { failures[start + index] = ExceptionDispatchInfo.Capture(failure); }
            }
        });
    }

    private void Drop()
    {
        values = null;
        Interlocked.Increment(ref discarded);
        if (++drops >= GiveUpAfterDiscards) disabled = true;
    }
}
#endif
