// SPDX-License-Identifier: Apache-2.0
//
// Qualifies the parallel callback path without a wasm build: SdfPurity must admit every pure field
// and refuse every impure one, and SdfColumnPrefetch, driven exactly as the native per-voxel loop
// drives the callback, must hand back the serial loop's own values and failures, bit for bit.
using System.Numerics;
using System.Runtime.ExceptionServices;
using PicoGK;
using PicoVoxel.Tests;
using Planter = PicoVoxel.Tests.Planter;

var failures = 0;
void Pass(string message) => Console.WriteLine($"PASS {message}");
void Fail(string message) { failures++; Console.WriteLine($"FAIL {message}"); }

void ExpectPure(string name, IImplicit field)
{
    if (SdfPurity.IsPure(field, out var reason)) Pass($"{name}: pure");
    else Fail($"{name}: expected pure, refused because {reason}");
}

void ExpectImpure(string name, IImplicit field)
{
    if (!SdfPurity.IsPure(field, out var reason)) Pass($"{name}: serial ({reason})");
    else Fail($"{name}: expected serial, admitted as pure");
}

ExpectPure("sphere", new Sphere(2));
ExpectPure("ShapeKernel gyroid", new Gyroid(4, 0.3f));
ExpectPure("union of sphere and gyroid", new Union(new Sphere(2), new Gyroid(4, 0.3f)));
ExpectPure("lambda", new Lambda(p => p.Length() - 1f));
ExpectPure("owned scratch arrays and structs", new Scratch());
ExpectPure("throwing field", new Throws(new InvalidOperationException("x"), 0));
ExpectPure("planter pot (original source)", new Planter.PotField(2.4f));
ExpectPure("planter saucer (original source)", new Planter.SaucerField(0f));

ExpectImpure("instance counter", new Counting());
ExpectImpure("static counter", new StaticCounting());
ExpectImpure("Random", new RandomJitter());
ExpectImpure("memoizing dictionary", new Memoized());
ExpectImpure("writes a shared array", new WritesSharedArray());
ExpectImpure("console output", new Logs());
ExpectImpure("lock", new Locks());
ExpectImpure("recursion", new Recursive(3));
ExpectImpure("impure child behind a combinator", new Wrapper(new Counting()));
ExpectImpure("mutates its own struct field", new MutatesOwnStruct());
ExpectImpure("mutates its own struct through an indexer", new MutatesThroughIndexer());
{
    var swappable = new Swappable(new Sphere(1));
    ExpectPure("reassignable child, pure now", swappable);
    swappable.Child = new Counting();
    ExpectImpure("the same field after its child is reassigned", swappable);
}
ExpectImpure("impure lambda", new Lambda(p => { StaticCounting.Count++; return p.Length(); }));

// The native per-voxel loop: x, then y, then z, each point vecToMM of its index, and an error from the
// callback ends the render there. `prefetch` is null for the serial reference.
(float[] Values, int Calls, Exception? Error) Drive(IImplicit field, SdfColumnPrefetch? prefetch, int half, float voxel)
{
    var values = new List<float>();
    var calls = 0;
    for (var x = -half; x <= half; x++)
    for (var y = -half; y <= half; y++)
    for (var z = -half; z <= half; z++)
    {
        var point = new Vector3(x * voxel, y * voxel, z * voxel);
        calls++;
        float value;
        if (prefetch is not null && prefetch.TryServe(in point, out var served, out var error))
        {
            if (error is not null) return (values.ToArray(), calls, error.SourceException);
            value = served;
        }
        else
        {
            try { value = field.fSignedDistance(in point); }
            catch (Exception thrown) { return (values.ToArray(), calls, thrown); }
        }
        values.Add(value);
    }
    return (values.ToArray(), calls, null);
}

void ExpectSameAsSerial(string name, IImplicit field, int half, float voxel)
{
    SdfColumnPrefetch.ResetCounters();
    var serial = Drive(field, null, half, voxel);
    var prefetch = SdfColumnPrefetch.For(field);
    if (prefetch is null && Environment.ProcessorCount < 2) { Pass($"{name}: serial only on one core, nothing to compare"); return; }
    if (prefetch is null) { Fail($"{name}: no prefetch (cores {Environment.ProcessorCount})"); return; }
    var parallel = Drive(field, prefetch, half, voxel);
    var side = 2 * half + 1;
    if (parallel.Calls != serial.Calls) { Fail($"{name}: {parallel.Calls} calls, serial made {serial.Calls}"); return; }
    if (!ReferenceEquals(parallel.Error, serial.Error)) { Fail($"{name}: error {parallel.Error?.Message} differs from serial {serial.Error?.Message}"); return; }
    if (parallel.Values.Length != serial.Values.Length) { Fail($"{name}: {parallel.Values.Length} values, serial {serial.Values.Length}"); return; }
    for (var i = 0; i < serial.Values.Length; i++)
    {
        if (BitConverter.SingleToInt32Bits(serial.Values[i]) != BitConverter.SingleToInt32Bits(parallel.Values[i]))
        { Fail($"{name}: sample {i} is {parallel.Values[i]:R}, serial {serial.Values[i]:R}"); return; }
    }
    // Every column but the first, which teaches the prefetch the row and column shape, is served.
    var expected = serial.Error is null ? (long)(side - 1) * side * side : -1;
    if (expected >= 0 && SdfColumnPrefetch.Served != expected)
    { Fail($"{name}: served {SdfColumnPrefetch.Served} samples, expected {expected}"); return; }
    if (SdfColumnPrefetch.Discarded != 0) { Fail($"{name}: discarded {SdfColumnPrefetch.Discarded} columns"); return; }
    Pass($"{name}: {serial.Values.Length} samples bit-identical, {SdfColumnPrefetch.Served} served from {SdfColumnPrefetch.Columns} parallel columns");
}

ExpectSameAsSerial("sphere", new Sphere(2), 12, 0.25f);
ExpectSameAsSerial("planter saucer", new Planter.SaucerField(0f), 40, 1.5f);
ExpectSameAsSerial("planter pot", new Planter.PotField(2.4f), 30, 2.5f);
ExpectSameAsSerial("nonfinite distances", new NaNs(), 10, 0.5f);
ExpectSameAsSerial("throwing field", new Throws(new InvalidOperationException("author failure"), 1f), 10, 0.5f);

// An impure field never gets a prefetch.
if (SdfColumnPrefetch.For(new Counting()) is null) Pass("impure field: no prefetch");
else Fail("impure field: prefetch created");

// A loop whose order differs from the learned shape is served nothing wrong: mismatches fall back.
if (Environment.ProcessorCount < 2) Pass("mismatched loop: serial only on one core, nothing to compare");
else
{
    var field = new Sphere(1.5f);
    var prefetch = SdfColumnPrefetch.For(field)!;
    SdfColumnPrefetch.ResetCounters();
    var wrong = 0;
    for (var x = -4; x <= 4; x++)
    for (var y = -4; y <= 4; y++)
    for (var z = -4; z <= 4; z++)
    {
        // The second half of every column asks for shifted points, which no precomputed sample matches.
        var point = new Vector3(x * 0.5f, y * 0.5f + (y > 0 && x > -4 ? 0.125f : 0f), z * 0.5f);
        var expected = field.fSignedDistance(in point);
        var value = prefetch.TryServe(in point, out var served, out _) ? served : field.fSignedDistance(in point);
        if (BitConverter.SingleToInt32Bits(value) != BitConverter.SingleToInt32Bits(expected)) wrong++;
    }
    if (wrong == 0 && SdfColumnPrefetch.Discarded > 0) Pass($"mismatched loop: no wrong sample, {SdfColumnPrefetch.Discarded} columns discarded");
    else Fail($"mismatched loop: {wrong} wrong samples, {SdfColumnPrefetch.Discarded} discarded");
}

Console.WriteLine(failures == 0 ? "All parallel-callback checks passed." : $"{failures} check(s) failed.");
return failures == 0 ? 0 : 1;
