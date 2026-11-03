// SPDX-License-Identifier: Apache-2.0
// Author fields that exercise each part of the IL lift: the leaf semantics that differ from the obvious
// tape form, control flow on the sample, traps, loops over known arrays, helpers, and structs.
using System.Numerics;
using PicoGK;

namespace PicoVoxel.Tests.Lift;

// .NET's Min/Max: NaN propagates and -0 orders below +0, unlike std::min/max.
public sealed class MinMax : IImplicit
{
    public float fSignedDistance(in Vector3 p) => MathF.Max(p.X, p.Y) + MathF.Min(p.Y, p.Z) * 0.5f + (float)Math.Max((double)p.Z, -0.0);
}

// Branches and early returns on the sample.
public sealed class Branches : IImplicit
{
    private readonly float radius = 1.25f;
    public float fSignedDistance(in Vector3 p)
    {
        if (p.X > 0.5f) return p.X - radius;
        if (p.Y < p.Z && p.Z >= 0f) { var d = p.Y - p.Z; return d * d - radius; }
        var q = p.Z;
        if (q < -1f || p.Y == 0f) q = -q;
        return q != 0f ? q : 0.25f;
    }
}

// Math.Clamp throws ArgumentException when min > max.
public sealed class ClampTrap : IImplicit
{
    public float fSignedDistance(in Vector3 p) => Math.Clamp(p.X, p.Y, p.Z);
}

// MathF.Sign throws ArithmeticException on NaN.
public sealed class SignTrap : IImplicit
{
    public float fSignedDistance(in Vector3 p) => MathF.Sign(MathF.Sqrt(p.X)) * p.Length() - 1f;
}

// An explicit throw with an interpolated message, behind a sample-dependent branch.
public sealed class ThrowsPastLimit : IImplicit
{
    private readonly float limit = 1.5f;
    public float fSignedDistance(in Vector3 p)
    {
        if (p.X > limit) throw new InvalidOperationException($"x {p.X} is past {limit}");
        return p.Length() - 1f;
    }
}

// A loop over a known array of structs, with a library distance.
public sealed class Spheres : IImplicit
{
    private readonly Vector3[] centres = [new(0, 0, 0), new(1.5f, 0, 0), new(0, -1.25f, 0.5f)];
    private readonly float radius = 0.75f;
    public float fSignedDistance(in Vector3 p)
    {
        var d = float.MaxValue;
        foreach (var centre in centres) d = MathF.Min(d, Vector3.Distance(p, centre) - radius);
        for (var i = 0; i < centres.Length; i++) d = MathF.Max(d, -10f - i);
        return d;
    }
}

// A user struct with a constructor and a method, and a static helper with a clamp of known bounds.
public readonly struct Capsule(Vector3 a, Vector3 b, float radius)
{
    private readonly Vector3 a = a, b = b;
    private readonly float radius = radius;
    public float Distance(Vector3 p)
    {
        var pa = p - a;
        var ba = b - a;
        var h = Math.Clamp(Vector3.Dot(pa, ba) / Vector3.Dot(ba, ba), 0f, 1f);
        return (pa - ba * h).Length() - radius;
    }
}

public sealed class Capsules : IImplicit
{
    public float fSignedDistance(in Vector3 p)
    {
        var first = new Capsule(new Vector3(-1, 0, 0), new Vector3(1, 0.5f, 0), 0.4f);
        var second = new Capsule(new Vector3(0, -1, -1), new Vector3(0, 1, 1), 0.3f);
        return Smooth(first.Distance(p), second.Distance(p), 0.2f);
    }

    private static float Smooth(float a, float b, float k)
    {
        var h = Math.Clamp(0.5f + 0.5f * (b - a) / k, 0f, 1f);
        return b + (a - b) * h - k * h * (1f - h);
    }
}

// Booleans as values, a ternary, a static readonly table, and Vector2 helpers.
public sealed class Mixed : IImplicit
{
    private static readonly float[] Weights = [0.5f, 0.25f, 2f];
    public float fSignedDistance(in Vector3 p)
    {
        var inside = p.X < 0 & p.Y < 0;
        var both = p.X < 0 && p.Z > 0;
        var v = Vector2.Abs(new Vector2(p.X, p.Z)) - new Vector2(0.5f);
        var box = Vector2.Max(v, Vector2.Zero).Length() + MathF.Min(MathF.Max(v.X, v.Y), 0f);
        return (inside ? -Weights[0] : Weights[1]) + (both ? box : box * Weights[2]);
    }
}

// Double arithmetic with library leaves, cast to float at the root.
public sealed class Doubles : IImplicit
{
    private readonly double scale = 1.7;
    public float fSignedDistance(in Vector3 p)
    {
        double x = p.X * scale, y = p.Y, z = p.Z;
        var r = Math.Sqrt(x * x + y * y) - 1.0;
        return (float)(Math.Max(Math.Abs(r) - 0.25, Math.Abs(z) - 0.5) + Math.Floor(z) * 1e-3 + Math.Ceiling(x) * 1e-4);
    }
}

// Unsigned integer comparisons of known values: the high bit is a large number, not a negative one.
public sealed class Unsigned : IImplicit
{
    private readonly uint big = 0x80000000u, one = 1u;
    private readonly ulong wide = 0x8000000000000000UL, small = 2UL;
    public float fSignedDistance(in Vector3 p)
    {
        var greater = big > one; // cgt.un
        var radius = big >= one ? 1f : 2f; // a .un branch
        if (wide < small) radius += 4f; // another
        return p.Length() - radius - (greater ? 0.25f : 0f);
    }
}

// ---- Refused: each must stay on the callback, with a reason. ----

// A loop whose trip count depends on the sample.
public sealed class SampleLoop : IImplicit
{
    public float fSignedDistance(in Vector3 p)
    {
        var d = p.Length();
        while (d > 1f) d -= 0.5f;
        return d;
    }
}

// An integer computed from the sample.
public sealed class Truncates : IImplicit
{
    public float fSignedDistance(in Vector3 p) => (int)(p.X * 4f) * 0.25f - p.Y;
}

// A library call that is not a leaf.
public sealed class Atan : IImplicit
{
    public float fSignedDistance(in Vector3 p) => MathF.Atan2(p.Y, p.X) - p.Z;
}
