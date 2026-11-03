// SPDX-License-Identifier: Apache-2.0
// The PicoGK surface the purity walk needs, and author fields on both sides of its verdict.
using System.Numerics;

namespace PicoGK
{
    public interface IImplicit { float fSignedDistance(in Vector3 vecPt); }
    public interface IBoundedImplicit : IImplicit { BBox3 oBounds { get; } }
    public readonly struct BBox3(float minX, float minY, float minZ, float maxX, float maxY, float maxZ)
    {
        public readonly Vector3 vecMin = new(minX, minY, minZ);
        public readonly Vector3 vecMax = new(maxX, maxY, maxZ);
    }
}

namespace PicoVoxel.Tests
{
    using PicoGK;

    // ---- Pure: every one of these must be admitted. ----

    public sealed class Sphere(float radius) : IImplicit
    {
        private readonly float radius = radius;
        public float fSignedDistance(in Vector3 p) => p.Length() - radius;
    }

    // LEAP 71's ShapeKernel gyroid shape: double locals, Math calls, a cast at the root.
    public class Gyroid(float unit, float thickness) : IImplicit
    {
        protected float scale = 2f * MathF.PI / unit;
        protected float ratio = thickness;
        public float fSignedDistance(in Vector3 p)
        {
            double x = p.X, y = p.Y, z = p.Z;
            double d = Math.Sin(scale * x) * Math.Cos(scale * y) + Math.Sin(scale * y) * Math.Cos(scale * z)
                + Math.Sin(scale * z) * Math.Cos(scale * x);
            return (float)(Math.Abs(d) - 0.5f * ratio);
        }
    }

    // A combinator: children reached only through the interface, resolved on the live instance.
    public sealed class Union(IImplicit a, IImplicit b) : IImplicit
    {
        private readonly IImplicit a = a, b = b;
        public float fSignedDistance(in Vector3 p) => MathF.Min(a.fSignedDistance(p), b.fSignedDistance(p));
    }

    // A lambda field: the delegate's target method is analyzed.
    public sealed class Lambda(Func<Vector3, float> sdf) : IImplicit
    {
        private readonly Func<Vector3, float> sdf = sdf;
        public float fSignedDistance(in Vector3 p) => sdf(p);
    }

    // Allocation, a local array written and read, a struct mutated through its own address, a loop.
    public sealed class Scratch : IImplicit
    {
        private readonly float[] radii = [1f, 2f, 3f];
        public float fSignedDistance(in Vector3 p)
        {
            var local = new float[radii.Length];
            for (var i = 0; i < radii.Length; i++) local[i] = p.Length() - radii[i];
            var best = new Vector2(float.MaxValue, 0);
            foreach (var value in local) best.X = MathF.Min(best.X, value);
            return best.X;
        }
    }

    // Throwing is deterministic, so it is pure: the error is replayed where the serial loop raises it.
    public sealed class Throws(Exception error, float atX) : IImplicit
    {
        private readonly Exception error = error;
        private readonly float atX = atX;
        public float fSignedDistance(in Vector3 p) => p.X == atX && p.Y > 0 ? throw error : p.Length() - 2f;
    }

    // Nonfinite distances part-way through, which the plain upstream loop keeps rendering past.
    public sealed class NaNs : IImplicit
    {
        public float fSignedDistance(in Vector3 p) => p.Z > 1f && p.Y < 0 ? float.NaN : p.Length() - 2f;
    }

    // ---- Impure: every one of these must stay serial. ----

    public sealed class Counting : IImplicit
    {
        public int Count;
        public float fSignedDistance(in Vector3 p) { Count++; return p.Length() - 1f; }
    }

    public sealed class StaticCounting : IImplicit
    {
        public static int Count;
        public float fSignedDistance(in Vector3 p) { Count++; return p.Length() - 1f; }
    }

    public sealed class RandomJitter : IImplicit
    {
        private readonly Random random = new(1);
        public float fSignedDistance(in Vector3 p) => p.Length() - 1f + (float)random.NextDouble() * 1e-3f;
    }

    public sealed class Memoized : IImplicit
    {
        private readonly Dictionary<Vector3, float> cache = [];
        public float fSignedDistance(in Vector3 p)
        {
            if (!cache.TryGetValue(p, out var value)) cache[p] = value = p.Length() - 1f;
            return value;
        }
    }

    public sealed class WritesSharedArray : IImplicit
    {
        private readonly float[] last = new float[1];
        public float fSignedDistance(in Vector3 p) { last[0] = p.X; return p.Length() - 1f; }
    }

    public sealed class Logs : IImplicit
    {
        public float fSignedDistance(in Vector3 p) { Console.Write(""); return p.Length() - 1f; }
    }

    public sealed class Locks : IImplicit
    {
        private readonly object gate = new();
        public float fSignedDistance(in Vector3 p) { lock (gate) return p.Length() - 1f; }
    }

    public sealed class Recursive(int depth) : IImplicit
    {
        private readonly int depth = depth;
        public float fSignedDistance(in Vector3 p) => Fold(p.Length(), depth);
        private static float Fold(float value, int remaining) => remaining == 0 ? value : Fold(value - 0.1f, remaining - 1);
    }

    // An impure child behind a pure-looking combinator.
    public sealed class Wrapper(IImplicit inner) : IImplicit
    {
        private readonly IImplicit inner = inner;
        public float fSignedDistance(in Vector3 p) => inner.fSignedDistance(p);
    }

    // A struct field mutated in place: the field's storage belongs to the shared instance.
    public sealed class MutatesOwnStruct : IImplicit
    {
        private Vector2 state;
        public float fSignedDistance(in Vector3 p) { state.X = p.X; return p.Length() - state.X * 0f - 1f; }
    }
}
