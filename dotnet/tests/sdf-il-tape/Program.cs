// SPDX-License-Identifier: Apache-2.0
//
// Qualifies the IL lift without a wasm build: each corpus field reaches its expected outcome, and every
// lifted tape, run through the reference evaluator, equals the author's own method at every sample of a
// dense grid, bit for bit, or is nonfinite exactly where the method throws or returns a nonfinite value.
// Run with float-trig preloaded (test-generator.mjs does), so MathF trigonometry is the browser's.
using System.Numerics;
using PicoGK;
using PicoVoxel.Tests;
using Lift = PicoVoxel.Tests.Lift;
using Planter = PicoVoxel.Tests.Planter;

var failures = 0;
void Pass(string message) => Console.WriteLine($"PASS {message}");
void Fail(string message) { failures++; Console.WriteLine($"FAIL {message}"); }

// The browser's MathF trigonometry is the double function rounded once (dotnet/float-trig.c); without it,
// the comparison below would test the host's sinf instead of the lift.
if (MathF.Sin(1e4f) != (float)Math.Sin(1e4) || MathF.Cos(-73.25f) != (float)Math.Cos(-73.25))
    Console.WriteLine("NOTE host MathF.Sin/Cos are not float-trig's; float trigonometry samples may differ");

IEnumerable<Vector3> Grid(Vector3 min, Vector3 max, int steps)
{
    for (var i = 0; i <= steps; i++)
    for (var j = 0; j <= steps; j++)
    for (var k = 0; k <= steps; k++)
        yield return new Vector3(min.X + (max.X - min.X) * i / steps, min.Y + (max.Y - min.Y) * j / steps, min.Z + (max.Z - min.Z) * k / steps);
}

IEnumerable<Vector3> Specials()
{
    float[] values = [0f, -0f, 1f, -1f, 0.5f, -0.5f, 2f, float.Epsilon, -float.Epsilon, 1e-30f];
    foreach (var x in values) foreach (var y in values) foreach (var z in values) yield return new Vector3(x, y, z);
}

void ExpectLifted(string name, IImplicit field, Vector3 min, Vector3 max, int steps, bool expectNonfinite = false)
{
    if (!SdfIlTape.TryLift(field, out var instructions, out var constants, out var reason))
    { Fail($"{name}: expected a lift, refused because {reason}"); return; }
    var samples = 0;
    var nonfinite = 0;
    foreach (var point in Grid(min, max, steps).Concat(Specials()))
    {
        var tape = TapeEvaluator.Evaluate(instructions, constants, point.X, point.Y, point.Z);
        if (!BrowserImplicit.SameOutcome(field, in point, tape, out var expected))
        { Fail($"{name}: at {point} the tape gives {tape:R}, the method {expected}"); return; }
        if (!float.IsFinite(tape)) nonfinite++;
        samples++;
    }
    if (expectNonfinite != (nonfinite > 0))
    { Fail($"{name}: {nonfinite} nonfinite samples, expected {(expectNonfinite ? "some" : "none")}"); return; }
    Pass($"{name}: {instructions.Length / 2} instructions, {samples} samples identical ({nonfinite} nonfinite where the method fails)");
}

void ExpectRefused(string name, IImplicit field, string because)
{
    if (SdfIlTape.TryLift(field, out _, out _, out var reason))
    { Fail($"{name}: expected a refusal, lifted"); return; }
    if (reason is null || !reason.Contains(because, StringComparison.Ordinal))
    { Fail($"{name}: refused because \"{reason}\", expected a reason containing \"{because}\""); return; }
    Pass($"{name}: refused ({reason})");
}

var unit = new Vector3(3);
ExpectLifted("sphere", new Sphere(2), -unit, unit, 24);
ExpectLifted("ShapeKernel gyroid", new Gyroid(4, 0.3f), -unit, unit, 24);
ExpectLifted("union of sphere and gyroid", new Union(new Sphere(2), new Gyroid(4, 0.3f)), -unit, unit, 24);
ExpectLifted("lambda", new Lambda(p => p.Length() - 1f), -unit, unit, 16);
ExpectLifted("throwing field", new Throws(new InvalidOperationException("x"), 1f), -unit, unit, 24, expectNonfinite: true);
ExpectLifted("nonfinite distances", new NaNs(), -unit, unit, 16, expectNonfinite: true);
ExpectLifted(".NET Min and Max", new Lift.MinMax(), -unit, unit, 16);
ExpectLifted("branches and early returns", new Lift.Branches(), -unit, unit, 30);
ExpectLifted("Math.Clamp with min > max", new Lift.ClampTrap(), -unit, unit, 16, expectNonfinite: true);
ExpectLifted("MathF.Sign of NaN", new Lift.SignTrap(), -unit, unit, 16, expectNonfinite: true);
ExpectLifted("throw with an interpolated message", new Lift.ThrowsPastLimit(), -unit, unit, 16, expectNonfinite: true);
ExpectLifted("loop over a known array", new Lift.Spheres(), -unit, unit, 24);
ExpectLifted("user struct and helper", new Lift.Capsules(), -unit, unit, 24);
ExpectLifted("booleans, ternary, static table, Vector2", new Lift.Mixed(), -unit, unit, 24);
ExpectLifted("double arithmetic", new Lift.Doubles(), -unit, unit, 24);

var pot = new Planter.PotField(2.4f);
ExpectLifted("planter pot (original source)", pot, pot.oBounds.vecMin, pot.oBounds.vecMax, 90);
var saucer = new Planter.SaucerField(0f);
ExpectLifted("planter saucer (original source)", saucer, saucer.oBounds.vecMin, saucer.oBounds.vecMax, 90);

ExpectRefused("sample-dependent loop", new Lift.SampleLoop(), "");
ExpectRefused("integer from the sample", new Lift.Truncates(), "integer");
ExpectRefused("MathF.Atan2", new Lift.Atan(), "Atan2");
ExpectRefused("owned scratch array", new Scratch(), "0x8D");
ExpectRefused("instance counter", new Counting(), "");

// The load-time check's points: the box's corners first, then fixed points inside it.
{
    var bounds = new BBox3(new Vector3(-1, -2, -3), new Vector3(1, 2, 3));
    var points = BrowserImplicit.CheckPoints(in bounds);
    var inside = true;
    for (var index = 0; index < points.Length / 3; index++)
    {
        inside &= points[3 * index] >= -1 && points[3 * index] <= 1 && points[(3 * index) + 1] >= -2 && points[(3 * index) + 1] <= 2
            && points[(3 * index) + 2] >= -3 && points[(3 * index) + 2] <= 3;
    }
    var again = BrowserImplicit.CheckPoints(in bounds);
    if (points.Length == 3 * (8 + BrowserImplicit.CheckedPoints) && inside && points.SequenceEqual(again) && points[0] == -1 && points[^3] != points[^6])
        Pass($"check points: {points.Length / 3} deterministic points in the box");
    else Fail("check points are not the corners and fixed points inside the box");
}

Console.WriteLine(failures == 0 ? "All IL-lift checks passed." : $"{failures} check(s) failed.");
return failures == 0 ? 0 : 1;
