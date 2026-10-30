// SPDX-License-Identifier: Apache-2.0
//
// Qualifies the signed-distance tape generator without a wasm build: each case compiles author source with
// the generator, then compares the lifted tape against the author's own method bit for bit through the
// reference evaluator. What a wasm build adds is the engine's own evaluation; what is settled here is the
// lifting decision and the arithmetic it rebuilds.
using System.Globalization;
using System.Reflection;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using PicoVoxel.Sdf.Generator;

namespace PicoVoxel.Tests;

internal static class Program
{
    private static int failures;

    /// <summary>The browser library's own registry source, so the test exercises the shipped encoder.</summary>
    private static readonly string RegistrySource =
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "SdfTape.cs"));

    /// <summary>The handles and types the registry references, which no browser archive is needed to supply.</summary>
    private const string Stubs = """
        using System.Numerics;
        namespace PicoGK
        {
            public interface IImplicit { float fSignedDistance(in Vector3 vec); }
            public readonly struct LibHandle { public readonly nint Value; }
            public readonly struct VoxHandle { public readonly nint Value; }
            public struct BBox3 { public Vector3 vecMin; public Vector3 vecMax; }
            internal static class Config { internal const string strPicoGKLib = "picogk"; }
        }
        public static class TapeProbe
        {
            public static object?[] Build(PicoGK.IImplicit field) =>
                PicoGK.SdfTapeRegistry.TryBuild(field, out var instructions, out var constants)
                    ? [instructions, constants]
                    : [];
        }
        """;

    private static readonly (float X, float Y, float Z)[] Samples =
    [
        (0f, 0f, 0f), (1f, 2f, 3f), (-7.25f, 0.5f, 19.75f), (0.1f, -0.2f, 0.3f),
        (123.456f, -98.765f, 54.321f), (-0.0f, 1e-7f, -1e7f),
    ];

    private static int Main()
    {
        // LEAP 71's own ShapeKernel gyroid, unchanged: each coordinate is widened into a double local and
        // the whole surface equation runs in double, so the author's one rounding is the (float) cast.
        Lifts(
            "the ShapeKernel gyroid, unchanged",
            """
            using System;
            using System.Numerics;
            using PicoGK;
            public class ImplicitGyroid : IImplicit
            {
                protected float m_fFrequencyScale;
                protected float m_fThicknessRatio;
                public ImplicitGyroid(float fUnitSize, float fThicknessRatio)
                {
                    m_fFrequencyScale = (2f * MathF.PI) / fUnitSize;
                    m_fThicknessRatio = fThicknessRatio;
                }
                public ImplicitGyroid() : this(10f, 0.4f) { }
                public float fSignedDistance(in Vector3 vecPt)
                {
                    double dX = vecPt.X;
                    double dY = vecPt.Y;
                    double dZ = vecPt.Z;

                    double fDist =   Math.Sin(m_fFrequencyScale * dX) * Math.Cos(m_fFrequencyScale * dY) +
                                     Math.Sin(m_fFrequencyScale * dY) * Math.Cos(m_fFrequencyScale * dZ) +
                                     Math.Sin(m_fFrequencyScale * dZ) * Math.Cos(m_fFrequencyScale * dX);

                    return (float)(Math.Abs(fDist) - 0.5f * m_fThicknessRatio);
                }
            }
            """,
            "ImplicitGyroid");

        // A sphere: sqrt and the arithmetic around it are exact, and an expression body is the same shape.
        Lifts(
            "sphere with an expression body",
            """
            using System.Numerics;
            using PicoGK;
            public class Sphere : IImplicit
            {
                private readonly double m_fRadius = 12.5;
                public float fSignedDistance(in Vector3 vec) => (float)(System.Math.Sqrt(
                    (double)vec.X * vec.X + (double)vec.Y * vec.Y + (double)vec.Z * vec.Z) - m_fRadius);
            }
            """,
            "Sphere");

        // Fields are read per invocation with the author's own arithmetic, including a private static const,
        // a static readonly field and a field a constructor computed.
        Lifts(
            "constants captured from fields at invocation",
            """
            using System.Numerics;
            using PicoGK;
            public class Slab : IImplicit
            {
                private const double Scale = 2.0;
                private static readonly double Offset = 0.75;
                private readonly double m_fHalf;
                public Slab() { m_fHalf = 3.5 * Scale + Offset; }
                public float fSignedDistance(in Vector3 vec)
                {
                    double dZ = vec.Z;
                    double dHalf = m_fHalf + Offset;
                    return (float)(System.Math.Abs(dZ * (Scale / 2.0)) - dHalf);
                }
            }
            """,
            "Slab");

        // A subclass that only picks the constructor's arguments reaches the very same method, so exact-type
        // dispatch covers it through the same builder rather than falling back.
        Lifts(
            "a subclass that inherits the lifted method",
            """
            using System;
            using System.Numerics;
            using PicoGK;
            public class Base : IImplicit
            {
                protected readonly double m_fThickness;
                public Base(double fThickness) { m_fThickness = fThickness; }
                public float fSignedDistance(in Vector3 vecPt)
                {
                    double dX = vecPt.X;
                    return (float)(Math.Abs(Math.Sin(dX)) - m_fThickness);
                }
            }
            public class Thin : Base { public Thin() : base(0.2) { } }
            """,
            "Thin");

        // Float arithmetic on a coordinate rounds at every step and the tape does not, so it falls back
        // rather than returning a near-enough answer.
        Refuses(
            "coordinate-dependent float arithmetic",
            """
            using System.Numerics;
            using PicoGK;
            public class FloatField : IImplicit
            {
                private readonly float m_fFrequency = 0.1f;
                public float fSignedDistance(in Vector3 vec) =>
                    System.MathF.Sin(vec.X * m_fFrequency) - 0.4f;
            }
            """);

        // Math.Min has a tape opcode, but std::min's NaN and signed-zero choices are not .NET's.
        Refuses(
            "Math.Min, whose tape opcode is not .NET's semantics",
            """
            using System.Numerics;
            using PicoGK;
            public class Intersection : IImplicit
            {
                public float fSignedDistance(in Vector3 vec) => (float)System.Math.Min(
                    (double)vec.X, (double)vec.Y);
            }
            """);

        // An arbitrary call could observe or change state, so a constant subtree admits only fields and Math.
        Refuses(
            "a constant subtree calling author code",
            """
            using System.Numerics;
            using PicoGK;
            public class Impure : IImplicit
            {
                private int m_nCalls;
                private double Next() { m_nCalls++; return m_nCalls; }
                public float fSignedDistance(in Vector3 vec) => (float)((double)vec.X - Next());
            }
            """);

        // The author's float result must come from one rounding at the root; a float-typed root has already
        // rounded where the tape would not.
        Refuses(
            "a result that is not a single root cast",
            """
            using System.Numerics;
            using PicoGK;
            public class NoCast : IImplicit
            {
                public float fSignedDistance(in Vector3 vec) => vec.X - 1f;
            }
            """);

        // A method a derived type may override cannot be dispatched by exact runtime type.
        Refuses(
            "a virtual signed-distance method",
            """
            using System.Numerics;
            using PicoGK;
            public class Overridable : IImplicit
            {
                public virtual float fSignedDistance(in Vector3 vec) => (float)(double)vec.X;
            }
            """);

        DesktopEmitsAnEmptyRegistry();

        Console.WriteLine(failures == 0 ? "RESULT pass" : $"RESULT fail {failures}");
        return failures == 0 ? 0 : 1;
    }

    private static void Lifts(string name, string author, string typeName)
    {
        var (assembly, generated) = Build(name, author, withRegistry: true);
        if (assembly is null)
        {
            return;
        }
        // The registration, not the builder: a subclass that inherits the method is registered through the
        // declaring type's builder.
        if (!generated.Contains($"Register<global::{typeName}>", StringComparison.Ordinal))
        {
            Fail(name, $"the generator did not lift {typeName}:\n{generated}");
            return;
        }
        var registry = assembly.GetType(SdfTapeGenerator.RegistryTypeName, throwOnError: true)!;
        registry.GetMethod(SdfTapeGenerator.RegistryMethodName)!.Invoke(null, null);
        var instance = Activator.CreateInstance(assembly.GetType(typeName, throwOnError: true)!)!;
        var signedDistance = instance.GetType().GetMethod("fSignedDistance")!;
        var built = (object?[])assembly.GetType("TapeProbe", throwOnError: true)!
            .GetMethod("Build")!.Invoke(null, [instance])!;
        if (built.Length != 2)
        {
            Fail(name, "the registration did not reach the registry");
            return;
        }
        var instructions = (uint[])built[0]!;
        var constants = (double[])built[1]!;
        foreach (var (x, y, z) in Samples)
        {
            var expected = (float)signedDistance.Invoke(instance, [new System.Numerics.Vector3(x, y, z)])!;
            var actual = TapeEvaluator.Evaluate(instructions, constants, x, y, z);
            // Bit comparison, not a tolerance: the point of the admitted shape is that these are the
            // same value, and a tolerance would hide the one case the lifter must refuse.
            if (BitConverter.SingleToInt32Bits(expected) != BitConverter.SingleToInt32Bits(actual))
            {
                Fail(name, string.Create(
                    CultureInfo.InvariantCulture,
                    $"at ({x}, {y}, {z}) the author returns {expected:R} and the tape {actual:R}"));
                return;
            }
        }
        Pass($"{name}: lifted, {instructions.Length / 2} operations, {constants.Length} constants");
    }

    private static void Refuses(string name, string author)
    {
        var (assembly, generated) = Build(name, author, withRegistry: true);
        if (assembly is null)
        {
            return;
        }
        if (generated.Contains("Register<", StringComparison.Ordinal))
        {
            Fail(name, $"the generator lifted a method it must refuse:\n{generated}");
            return;
        }
        Pass($"{name}: refused, callback path retained");
    }

    /// <summary>Without the browser registry in scope the entry point is still emitted, and still empty.</summary>
    private static void DesktopEmitsAnEmptyRegistry()
    {
        const string name = "desktop compilation without the browser registry";
        var (assembly, generated) = Build(
            name,
            """
            using System.Numerics;
            using PicoGK;
            public class Gyroid : IImplicit
            {
                private readonly double m_fThickness = 0.4;
                public float fSignedDistance(in Vector3 vec) =>
                    (float)(System.Math.Sin((double)vec.X) - m_fThickness);
            }
            """,
            withRegistry: false);
        if (assembly is null)
        {
            return;
        }
        if (generated.Contains("Register<", StringComparison.Ordinal))
        {
            Fail(name, $"the generator emitted a registration the desktop reference cannot satisfy:\n{generated}");
            return;
        }
        var registry = assembly.GetType(SdfTapeGenerator.RegistryTypeName, throwOnError: true)!;
        registry.GetMethod(SdfTapeGenerator.RegistryMethodName)!.Invoke(null, null);
        Pass($"{name}: entry point present and empty");
    }

    private static (Assembly? Assembly, string Generated) Build(string name, string author, bool withRegistry)
    {
        var sources = new List<string> { author };
        if (withRegistry)
        {
            // The library builds with implicit usings; the harness supplies the same set.
            sources.Add("""
                global using System;
                global using System.Collections.Generic;
                global using System.Linq;
                """);
            sources.Add(RegistrySource);
            sources.Add(Stubs);
        }
        else
        {
            // The desktop shape: IImplicit and the handles, but no tape registry.
            sources.Add("""
                using System.Numerics;
                namespace PicoGK { public interface IImplicit { float fSignedDistance(in Vector3 vec); } }
                """);
        }
        var options = new CSharpParseOptions(LanguageVersion.Latest);
        if (withRegistry)
        {
            options = options.WithPreprocessorSymbols("PICOGK_BROWSER");
        }
        var compilation = CSharpCompilation.Create(
            $"PicoVoxelGeneratorCase{Math.Abs(name.GetHashCode(StringComparison.Ordinal))}",
            sources.Select(source => CSharpSyntaxTree.ParseText(SourceText.From(source), options)),
            Net11References(),
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: OptimizationLevel.Release,
                deterministic: true,
                allowUnsafe: true));
        var driver = CSharpGeneratorDriver
            .Create(new SdfTapeGenerator())
            .WithUpdatedParseOptions(options)
            .RunGeneratorsAndUpdateCompilation(compilation, out var updated, out var generatorDiagnostics);
        _ = driver;
        var generated = string.Concat(updated.SyntaxTrees
            .Where(tree => tree.FilePath.EndsWith(".g.cs", StringComparison.Ordinal))
            .Select(tree => tree.ToString()));
        var errors = generatorDiagnostics
            .Concat(updated.GetDiagnostics())
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToArray();
        if (errors.Length > 0)
        {
            Fail(name, string.Join(
                Environment.NewLine,
                errors.Select(diagnostic => diagnostic.ToString()).Prepend("the case did not compile:")
                    .Append(generated)));
            return (null, generated);
        }
        using var image = new MemoryStream();
        var emitted = updated.Emit(image);
        if (!emitted.Success)
        {
            Fail(name, "the case did not emit");
            return (null, generated);
        }
        return (Assembly.Load(image.ToArray()), generated);
    }

    /// <summary>The running runtime's own reference set, which is the only one this harness needs.</summary>
    private static IEnumerable<MetadataReference> Net11References() =>
        ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Where(path => path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));

    private static void Pass(string message) => Console.WriteLine($"PASS {message}");

    private static void Fail(string name, string detail)
    {
        failures++;
        Console.WriteLine($"FAIL {name}: {detail}");
    }
}
