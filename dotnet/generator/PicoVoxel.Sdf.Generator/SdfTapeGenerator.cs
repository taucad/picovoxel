// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace PicoVoxel.Sdf.Generator;

/// <summary>
/// Emits the registry that lets an unchanged author's signed-distance method run as a tape instead of as a
/// per-voxel managed callback.
/// </summary>
/// <remarks>
/// <para>
/// Nothing the author wrote is rewritten. A source generator cannot add to a type it does not own, and
/// requiring every author to mark their fields <c>partial</c> is not a migration anyone would accept, so the
/// generated code is a separate registry: one build method per eligible type, reading that type's fields
/// through <c>UnsafeAccessor</c> and rebuilding the method's arithmetic with <see cref="SdfLifter"/>'s
/// builder calls. A type the lifter refuses is simply absent, and the callback path still serves it.
/// </para>
/// <para>
/// The registry's <c>Register</c> method is invoked explicitly once the author's assembly is loaded, so no
/// author static constructor runs to install it, and the same assembly behaves identically whether it was
/// built by MSBuild with this analyzer or by the browser worker's own generator driver.
/// </para>
/// </remarks>
[Generator(LanguageNames.CSharp)]
public sealed class SdfTapeGenerator : IIncrementalGenerator
{
    /// <summary>
    /// Changes whenever generated output could differ for the same author source. The compiler's cache key
    /// carries it, so a generator change never serves a stale compilation.
    /// </summary>
    public const string ContractVersion = "1";

    /// <summary>The generated registry's fully qualified type name, as the host resolves it after load.</summary>
    public const string RegistryTypeName = "PicoVoxel.Generated.SdfTapeRegistration";

    /// <summary>The generated registry's entry point, which registers every lifted type.</summary>
    public const string RegistryMethodName = "Register";

    private const string GeneratedFile = "PicoVoxel.SdfTapeRegistration.g.cs";

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var candidates = context.SyntaxProvider.CreateSyntaxProvider(
                static (node, _) => node is ClassDeclarationSyntax { BaseList: not null },
                static (syntax, cancellation) =>
                    syntax.SemanticModel.GetDeclaredSymbol(syntax.Node, cancellation) as INamedTypeSymbol)
            .Where(static symbol => symbol is not null)
            .Collect();

        context.RegisterSourceOutput(
            candidates.Combine(context.CompilationProvider),
            static (production, input) => Emit(production, input.Left, input.Right));
    }

    private static void Emit(
        SourceProductionContext context,
        ImmutableArray<INamedTypeSymbol?> candidates,
        Compilation compilation)
    {
        var lifted = new List<LiftedMethod>();
        var refused = new List<string>();
        // The tape operations are a browser-archive capability: the desktop native payload is unchanged and
        // exports none of them, so its PicoGK reference carries no registry. The generated entry point is
        // still emitted there, empty, which is what keeps one author source compiling against both.
        if (compilation.GetTypeByMetadataName("PicoGK.SdfTapeRegistry") is not null
            && compilation.GetTypeByMetadataName("PicoGK.SdfTapeBuilder") is not null)
        {
        // A type may be declared once but reached through several candidates; keep the first of each.
        var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        foreach (var candidate in candidates)
        {
            context.CancellationToken.ThrowIfCancellationRequested();
            if (candidate is null || !seen.Add(candidate))
            {
                continue;
            }
            if (SdfLifter.TryLift(candidate, compilation, context.CancellationToken, out var reason) is { } method)
            {
                lifted.Add(method);
            }
            else if (reason is not null)
            {
                refused.Add($"{candidate.ToDisplayString()}: {reason}");
            }
        }
        }
        // Deterministic order, so the same sources always produce the same bytes.
        lifted.Sort(static (left, right) => string.CompareOrdinal(
            left.Owner.ToDisplayString(), right.Owner.ToDisplayString()));
        refused.Sort(StringComparer.Ordinal);
        context.AddSource(GeneratedFile, SourceText.From(Render(lifted, refused), Encoding.UTF8));
    }

    private static string Render(IReadOnlyList<LiftedMethod> lifted, IReadOnlyList<string> refused)
    {
        var source = new StringBuilder();
        source.AppendLine("// <auto-generated/>");
        // Why a field kept the callback path belongs where whoever wonders will look: in the output.
        foreach (var refusal in refused)
        {
            source.AppendLine($"// Evaluated as a callback — {refusal.Replace("\r", " ").Replace("\n", " ")}");
        }
        source.AppendLine("#nullable enable");
        source.AppendLine("namespace PicoVoxel.Generated");
        source.AppendLine("{");
        source.AppendLine("    /// <summary>Registers the signed-distance methods PicoVoxel can evaluate as a tape.</summary>");
        source.AppendLine("    public static class SdfTapeRegistration");
        source.AppendLine("    {");
        source.AppendLine("        /// <summary>Invoked explicitly once the containing assembly is loaded.</summary>");
        source.AppendLine($"        public static void {RegistryMethodName}()");
        source.AppendLine("        {");
        foreach (var method in lifted)
        {
            var owner = method.Owner.ToDisplayString(FullyQualified);
            source.AppendLine(
                $"            global::PicoGK.SdfTapeRegistry.Register<{owner}>(Build_{Identifier(method.Owner)});");
            foreach (var inheritor in method.Inheritors)
            {
                // A subclass that adds only a constructor reaches the same method with the same fields, so
                // exact-type dispatch covers it through the same builder.
                source.AppendLine(
                    $"            global::PicoGK.SdfTapeRegistry.Register<{inheritor.ToDisplayString(FullyQualified)}>("
                    + $"(self, builder) => Build_{Identifier(method.Owner)}(self, builder));");
            }
        }
        source.AppendLine("        }");
        foreach (var method in lifted)
        {
            Render(source, method);
        }
        source.AppendLine("    }");
        source.AppendLine("}");
        return source.ToString();
    }

    private static void Render(StringBuilder source, LiftedMethod method)
    {
        var owner = method.Owner.ToDisplayString(FullyQualified);
        source.AppendLine();
        foreach (var field in method.Captured)
        {
            // The author's own fields, read without reflection and without asking the author to open them
            // up. UnsafeAccessor resolves at compile and AOT time, so this works in the wasm host too.
            var declaring = field.Field.ContainingType.ToDisplayString(FullyQualified);
            var type = field.Field.Type.ToDisplayString(FullyQualified);
            var kind = field.Field.IsStatic ? "StaticField" : "Field";
            source.AppendLine(
                "        [global::System.Runtime.CompilerServices.UnsafeAccessor("
                + $"global::System.Runtime.CompilerServices.UnsafeAccessorKind.{kind}, Name = "
                + $"{Literal(field.Field.Name)})]");
            source.AppendLine($"        private static extern ref {type} {field.Accessor}({declaring} self);");
        }
        source.AppendLine($"        private static int Build_{Identifier(method.Owner)}(");
        source.AppendLine($"            {owner} self, global::PicoGK.SdfTapeBuilder tape)");
        source.AppendLine("        {");
        foreach (var statement in method.Statements)
        {
            source.AppendLine($"            {statement}");
        }
        source.AppendLine($"            return {method.Result};");
        source.AppendLine("        }");
    }

    private static string Identifier(INamedTypeSymbol type) =>
        new([.. type.ToDisplayString().Select(character => char.IsLetterOrDigit(character) ? character : '_')]);

    private static string Literal(string value) =>
        SyntaxFactory.Literal(value).ToFullString();

    private static readonly SymbolDisplayFormat FullyQualified =
        SymbolDisplayFormat.FullyQualifiedFormat.WithMiscellaneousOptions(
            SymbolDisplayMiscellaneousOptions.UseSpecialTypes);
}
