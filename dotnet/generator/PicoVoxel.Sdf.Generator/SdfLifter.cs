// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace PicoVoxel.Sdf.Generator;

/// <summary>One instance field a lifted method reads, and the accessor the emitted code needs for it.</summary>
internal sealed class CapturedField
{
    internal CapturedField(IFieldSymbol field, string accessor)
    {
        Field = field;
        Accessor = accessor;
    }

    internal IFieldSymbol Field { get; }

    /// <summary>The generated accessor method's name.</summary>
    internal string Accessor { get; }
}

/// <summary>A signed-distance method the tape can evaluate bit-identically, and how to rebuild it.</summary>
internal sealed class LiftedMethod
{
    internal LiftedMethod(
        INamedTypeSymbol owner,
        IReadOnlyList<INamedTypeSymbol> inheritors,
        IReadOnlyList<string> statements,
        string result,
        IReadOnlyList<CapturedField> captured)
    {
        Owner = owner;
        Inheritors = inheritors;
        Statements = statements;
        Result = result;
        Captured = captured;
    }

    /// <summary>The type that declares the method.</summary>
    internal INamedTypeSymbol Owner { get; }

    /// <summary>Concrete types that inherit this exact method without shadowing or overriding it.</summary>
    internal IReadOnlyList<INamedTypeSymbol> Inheritors { get; }

    /// <summary>Generated statements, in order: the author's own locals, as C# values or as registers.</summary>
    internal IReadOnlyList<string> Statements { get; }

    /// <summary>A C# expression returning the register that holds the signed distance.</summary>
    internal string Result { get; }

    internal IReadOnlyList<CapturedField> Captured { get; }
}

/// <summary>
/// Decides whether an author's <c>fSignedDistance</c> can be rebuilt as a tape with identical results, and
/// if so emits the builder calls that rebuild it.
/// </summary>
/// <remarks>
/// <para>
/// The evaluator in <c>src/pico-tape.cpp</c> reads each coordinate as <c>(double) fToMM(voxel)</c>, evaluates
/// every operation in <c>double</c>, and rounds the final register to <c>float</c> once. An author's method
/// has exactly those semantics when its coordinate-dependent arithmetic is <c>double</c> throughout and its
/// result is cast to <c>float</c> at the root — which is how LEAP 71's own ShapeKernel fields are written:
/// they widen each coordinate into a <c>double</c> local and then use <c>Math.Sin</c> and friends, which take
/// and return <c>double</c>.
/// </para>
/// <para>
/// So the admitted shape is narrow on purpose. A coordinate-dependent step whose converted type is
/// <c>float</c> rounds at that step and the tape does not, so it is refused rather than approximated, which
/// is what "coordinate-dependent f32 arithmetic falls back unless an exact representation is proven" asks
/// for. Giving the tape a round-to-float opcode would admit that whole class, and would change picovoxel's
/// published expression ABI, so it is not this program's to make. The admitted operations are the ones whose
/// equality is established rather than assumed:
/// </para>
/// <list type="bullet">
/// <item><description><c>+ - * /</c> and unary <c>-</c>: IEEE-754 correctly rounded in both.</description></item>
/// <item><description><c>Math.Abs</c>, <c>Math.Floor</c>: exact in both.</description></item>
/// <item><description><c>Math.Sqrt</c>: IEEE-754 correctly rounded in both.</description></item>
/// <item><description><c>Math.Sin</c>, <c>Math.Cos</c>: the same musl routines back both sides of the wasm
/// build, and the recorded gyroid witness reproduces the historical mesh digest through them.</description></item>
/// </list>
/// <para>
/// <c>Math.Min</c>, <c>Math.Max</c>, <c>Math.Pow</c>, <c>Math.Exp</c>, <c>Math.Log</c> and <c>%</c> have tape
/// opcodes but are NOT admitted: the tape's min/max follow <c>std::min</c>'s NaN and signed-zero choices
/// rather than .NET's, its <c>mod</c> is the floored GLSL form rather than C#'s truncated <c>%</c>, and no
/// witness yet establishes identity for the remaining transcendentals. Widening the set is an evidence
/// change, not a code change.
/// </para>
/// <para>
/// Coordinate-independent subtrees are a different matter: they are evaluated once per invocation by the
/// author's own C# arithmetic and enter the tape as constants, so nothing about them has to be mirrored. They
/// are restricted to literals, locals, the author's fields and <c>System.Math</c>/<c>System.MathF</c> calls,
/// which keeps an invocation from running arbitrary author code.
/// </para>
/// </remarks>
internal static class SdfLifter
{
    internal const string SignedDistanceMethod = "fSignedDistance";

    private static readonly HashSet<string> Coordinates = new(StringComparer.Ordinal) { "X", "Y", "Z" };

    /// <summary>Exact <c>double</c> operations of <c>System.Math</c>, mapped to their builder methods.</summary>
    private static readonly Dictionary<string, string> Intrinsics = new(StringComparer.Ordinal)
    {
        ["Abs"] = "Absolute",
        ["Sqrt"] = "SquareRoot",
        ["Sin"] = "Sine",
        ["Cos"] = "Cosine",
        ["Floor"] = "Floor",
    };

    internal static bool IsMathMethod(IMethodSymbol method) =>
        method.IsStatic
        && method.ContainingType is { } type
        && type.ContainingNamespace?.ToDisplayString() == "System"
        && (type.Name == "Math" || type.Name == "MathF");

    /// <summary>Lifts <paramref name="type"/>'s signed-distance method, or explains why it stays a callback.</summary>
    internal static LiftedMethod? TryLift(
        INamedTypeSymbol type, Compilation compilation, CancellationToken cancellation, out string? reason)
    {
        reason = null;
        var implicitInterface = compilation.GetTypeByMetadataName("PicoGK.IImplicit");
        if (implicitInterface is null
            || !type.AllInterfaces.Any(candidate => SymbolEqualityComparer.Default.Equals(candidate, implicitInterface)))
        {
            return null;
        }
        if (type.IsStatic || type.TypeKind != TypeKind.Class || type.IsGenericType)
        {
            return null;
        }
        var method = type.GetMembers(SignedDistanceMethod)
            .OfType<IMethodSymbol>()
            .FirstOrDefault(candidate => candidate.Parameters.Length == 1
                && candidate.ReturnType.SpecialType == SpecialType.System_Single);
        // Dispatch is by exact runtime type, so a method the type inherits belongs to its declaring type's
        // own registration, and one that may still be overridden cannot be dispatched this way at all.
        if (method is null
            || !SymbolEqualityComparer.Default.Equals(method.ContainingType, type)
            || method.IsVirtual || method.IsAbstract || method.IsOverride
            || method.DeclaringSyntaxReferences.Length != 1)
        {
            return null;
        }
        reason = $"declares no {SignedDistanceMethod}(in Vector3) of its own that the tape can rebuild";
        if (method.DeclaringSyntaxReferences[0].GetSyntax(cancellation) is not MethodDeclarationSyntax declaration)
        {
            return null;
        }
        var body = StraightLine(declaration);
        if (body is null)
        {
            reason = "its body is more than straight-line locals and one return";
            return null;
        }
        var (locals, returned) = body.Value;
        var model = compilation.GetSemanticModel(declaration.SyntaxTree);
        var walker = new Walker(model, type, method.Parameters[0]);
        if (!walker.Prepare(locals, cancellation))
        {
            reason = walker.Rejection;
            return null;
        }
        // The method returns float and the tape rounds once at its root, so the author must too: an explicit
        // (float) cast of a double expression is the only shape with that single rounding.
        if (Unwrap(returned) is not CastExpressionSyntax cast
            || model.GetTypeInfo(cast.Type, cancellation).Type?.SpecialType != SpecialType.System_Single)
        {
            reason = "its result is not one (float) cast of a double expression, so it rounds where the tape does not";
            return null;
        }
        var result = walker.Lift(cast.Expression, cancellation);
        if (result is null)
        {
            reason = walker.Rejection ?? "it uses an operation the tape cannot reproduce exactly";
            return null;
        }
        reason = null;
        return new LiftedMethod(
            type, Inheritors(type, method, compilation), walker.Statements, result, walker.Captured);
    }

    /// <summary>
    /// Concrete types that reach this very method, so a subclass that adds nothing but a constructor is
    /// covered too. A type that declares its own <c>fSignedDistance</c>, by override or by shadowing, is not.
    /// </summary>
    private static IReadOnlyList<INamedTypeSymbol> Inheritors(
        INamedTypeSymbol owner, IMethodSymbol method, Compilation compilation)
    {
        var inheritors = new List<INamedTypeSymbol>();
        foreach (var candidate in Descendants(compilation.Assembly.GlobalNamespace))
        {
            if (candidate.IsAbstract || candidate.IsGenericType || candidate.TypeKind != TypeKind.Class
                || SymbolEqualityComparer.Default.Equals(candidate, owner))
            {
                continue;
            }
            if (!Inherits(candidate, owner))
            {
                continue;
            }
            var reached = candidate.GetMembers(SignedDistanceMethod).OfType<IMethodSymbol>()
                .FirstOrDefault(member => member.Parameters.Length == 1);
            if (reached is null)
            {
                inheritors.Add(candidate);
            }
        }
        inheritors.Sort(static (left, right) =>
            string.CompareOrdinal(left.ToDisplayString(), right.ToDisplayString()));
        return inheritors;
    }

    private static bool Inherits(INamedTypeSymbol candidate, INamedTypeSymbol owner)
    {
        for (var baseType = candidate.BaseType; baseType is not null; baseType = baseType.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(baseType, owner))
            {
                return true;
            }
        }
        return false;
    }

    private static IEnumerable<INamedTypeSymbol> Descendants(INamespaceOrTypeSymbol scope)
    {
        foreach (var member in scope.GetMembers())
        {
            if (member is INamespaceSymbol space)
            {
                foreach (var nested in Descendants(space))
                {
                    yield return nested;
                }
            }
            else if (member is INamedTypeSymbol type)
            {
                yield return type;
                foreach (var nested in Descendants(type))
                {
                    yield return nested;
                }
            }
        }
    }

    /// <summary>
    /// A body of single-assignment locals followed by one return, which is what a field written for
    /// readability looks like. Anything that branches, loops, reassigns or writes through a reference is not
    /// straight-line and is refused.
    /// </summary>
    private static (IReadOnlyList<VariableDeclaratorSyntax> Locals, ExpressionSyntax Returned)? StraightLine(
        MethodDeclarationSyntax declaration)
    {
        if (declaration.ExpressionBody is { } arrow)
        {
            return ([], arrow.Expression);
        }
        if (declaration.Body is not { } block || block.Statements.Count == 0)
        {
            return null;
        }
        var locals = new List<VariableDeclaratorSyntax>();
        for (var index = 0; index < block.Statements.Count - 1; index++)
        {
            if (block.Statements[index] is not LocalDeclarationStatementSyntax { Declaration.Variables.Count: 1 } local
                || local.UsingKeyword != default
                || local.Declaration.Variables[0].Initializer is null)
            {
                return null;
            }
            locals.Add(local.Declaration.Variables[0]);
        }
        if (block.Statements[block.Statements.Count - 1] is not ReturnStatementSyntax { Expression: { } returned })
        {
            return null;
        }
        return (locals, returned);
    }

    private static ExpressionSyntax Unwrap(ExpressionSyntax expression)
    {
        while (expression is ParenthesizedExpressionSyntax parenthesized)
        {
            expression = parenthesized.Expression;
        }
        return expression;
    }

    private sealed class Walker
    {
        private readonly SemanticModel model;
        private readonly INamedTypeSymbol owner;
        private readonly IParameterSymbol coordinate;
        private readonly List<CapturedField> captured = [];
        private readonly Dictionary<string, string> accessors = new(StringComparer.Ordinal);
        private readonly List<string> statements = [];

        /// <summary>Each author local, as the generated name of a register or of a plain C# value.</summary>
        private readonly Dictionary<ISymbol, (string Name, bool IsRegister)> locals =
            new(SymbolEqualityComparer.Default);

        internal Walker(SemanticModel model, INamedTypeSymbol owner, IParameterSymbol coordinate)
        {
            this.model = model;
            this.owner = owner;
            this.coordinate = coordinate;
        }

        internal IReadOnlyList<CapturedField> Captured => captured;

        internal IReadOnlyList<string> Statements => statements;

        /// <summary>Why the first refusal happened, so an author can see which step fell back.</summary>
        internal string? Rejection { get; private set; }

        private string? Refuse(string because)
        {
            Rejection ??= because;
            return null;
        }

        /// <summary>
        /// Rebuilds the author's locals in order. A local that depends on the coordinate becomes a register,
        /// evaluated once exactly as the author evaluates it once; one that does not stays a C# value, so a
        /// constant subtree can keep using the author's own arithmetic.
        /// </summary>
        internal bool Prepare(IReadOnlyList<VariableDeclaratorSyntax> declarators, CancellationToken cancellation)
        {
            foreach (var declarator in declarators)
            {
                cancellation.ThrowIfCancellationRequested();
                if (model.GetDeclaredSymbol(declarator, cancellation) is not ILocalSymbol local)
                {
                    Refuse($"`{declarator}` is not a plain local");
                    return false;
                }
                if (local.RefKind != RefKind.None)
                {
                    Refuse($"`{declarator}` is a reference local");
                    return false;
                }
                var initializer = declarator.Initializer!.Value;
                var name = $"{(ReadsCoordinate(initializer) ? "r_" : "c_")}{Sanitize(local.Name)}";
                if (ReadsCoordinate(initializer))
                {
                    var lifted = Lift(initializer, cancellation);
                    if (lifted is null)
                    {
                        return false;
                    }
                    locals[local] = (name, true);
                    statements.Add($"var {name} = {lifted};");
                }
                else
                {
                    var rewritten = Constant(initializer);
                    if (rewritten is null)
                    {
                        return false;
                    }
                    locals[local] = (name, false);
                    statements.Add($"{local.Type.ToDisplayString(FullyQualified)} {name} = {rewritten};");
                }
            }
            return true;
        }

        /// <summary>The builder calls rebuilding <paramref name="expression"/>, or null if it is not liftable.</summary>
        internal string? Lift(ExpressionSyntax expression, CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            var node = Unwrap(expression);
            if (!ReadsCoordinate(node))
            {
                var rewritten = Constant(node);
                return rewritten is null ? null : $"tape.Constant((double)({rewritten}))";
            }
            // A coordinate is float and the tape reads it as double; that widening is exact, whatever the
            // surrounding context does with it. Its consumer is what has to be in double.
            if (node is MemberAccessExpressionSyntax coordinateAccess && CoordinateAxis(coordinateAccess) is { } onlyAxis)
            {
                return $"tape.{onlyAxis}()";
            }
            // Every other coordinate-dependent step must land in double, or it rounds where the tape does not.
            if (model.GetTypeInfo(node, cancellation).ConvertedType?.SpecialType != SpecialType.System_Double)
            {
                return Refuse($"`{node}` depends on the coordinate but is not evaluated in double");
            }
            switch (node)
            {
                case IdentifierNameSyntax identifier
                    when Local(identifier) is { IsRegister: true } register:
                    return register.Name;
                case CastExpressionSyntax cast
                    when model.GetTypeInfo(cast.Type, cancellation).Type?.SpecialType == SpecialType.System_Double:
                    // (double) of a coordinate-dependent subtree is exact where that subtree is already
                    // double or is a bare coordinate; a float subtree has rounded before the cast, and the
                    // recursive call refuses it.
                    return Lift(cast.Expression, cancellation);
                case PrefixUnaryExpressionSyntax unary when unary.IsKind(SyntaxKind.UnaryMinusExpression):
                    return Lift(unary.Operand, cancellation) is { } operand ? $"tape.Negate({operand})" : null;
                case PrefixUnaryExpressionSyntax unary when unary.IsKind(SyntaxKind.UnaryPlusExpression):
                    return Lift(unary.Operand, cancellation);
                case BinaryExpressionSyntax binary when Operator(binary) is { } op:
                    var left = Lift(binary.Left, cancellation);
                    var right = Lift(binary.Right, cancellation);
                    return left is null || right is null ? null : $"tape.{op}({left}, {right})";
                case InvocationExpressionSyntax invocation:
                    return LiftIntrinsic(invocation, cancellation);
                default:
                    return Refuse($"`{node}` is not an operation the tape reproduces exactly");
            }
        }

        private (string Name, bool IsRegister)? Local(IdentifierNameSyntax identifier) =>
            model.GetSymbolInfo(identifier).Symbol is ILocalSymbol local && locals.TryGetValue(local, out var found)
                ? found
                : null;

        private static string? Operator(BinaryExpressionSyntax binary) => binary.Kind() switch
        {
            SyntaxKind.AddExpression => "Add",
            SyntaxKind.SubtractExpression => "Subtract",
            SyntaxKind.MultiplyExpression => "Multiply",
            SyntaxKind.DivideExpression => "Divide",
            _ => null,
        };

        private string? LiftIntrinsic(InvocationExpressionSyntax invocation, CancellationToken cancellation)
        {
            if (model.GetSymbolInfo(invocation, cancellation).Symbol is not IMethodSymbol method
                || !IsMathMethod(method)
                || method.ContainingType.Name != "Math"
                || method.Parameters.Length != 1
                || method.Parameters[0].Type.SpecialType != SpecialType.System_Double
                || method.ReturnType.SpecialType != SpecialType.System_Double
                || !Intrinsics.TryGetValue(method.Name, out var builder)
                || invocation.ArgumentList.Arguments.Count != 1)
            {
                return Refuse($"`{invocation}` is not one of System.Math's exactly reproduced double operations");
            }
            var argument = Lift(invocation.ArgumentList.Arguments[0].Expression, cancellation);
            return argument is null ? null : $"tape.{builder}({argument})";
        }

        /// <summary>
        /// A coordinate-independent subtree, as C# the generated code evaluates once per invocation: the
        /// author's own text, with its field reads routed through generated accessors.
        /// </summary>
        private string? Constant(ExpressionSyntax node)
        {
            var replacements = new Dictionary<SyntaxNode, string>();
            foreach (var descendant in node.DescendantNodesAndSelf())
            {
                if (!IsPure(descendant))
                {
                    return Refuse($"`{descendant}` is not a literal, a local, a field read or a System.Math call, "
                        + "so capturing it would run author code per invocation");
                }
                if (descendant is not IdentifierNameSyntax and not MemberAccessExpressionSyntax)
                {
                    continue;
                }
                var expression = (ExpressionSyntax)descendant;
                switch (model.GetSymbolInfo(descendant).Symbol)
                {
                    case ILocalSymbol local when locals.TryGetValue(local, out var found):
                        if (found.IsRegister)
                        {
                            return Refuse($"`{descendant}` is a register, which C# arithmetic cannot read");
                        }
                        replacements[expression] = found.Name;
                        break;
                    case IFieldSymbol field:
                        var reference = FieldReference(field);
                        if (reference is null)
                        {
                            return Refuse($"`{descendant}` reads a field the generated accessor cannot reach");
                        }
                        replacements[expression] = reference;
                        break;
                    default:
                        break;
                }
            }
            return Replace(node, replacements);
        }

        /// <summary>The syntax a coordinate-independent subtree may contain, so an invocation stays pure.</summary>
        private bool IsPure(SyntaxNode node)
        {
            switch (node)
            {
                case LiteralExpressionSyntax:
                case ThisExpressionSyntax:
                case ParenthesizedExpressionSyntax:
                case CastExpressionSyntax:
                case PredefinedTypeSyntax:
                case ArgumentListSyntax:
                case ArgumentSyntax:
                    return true;
                case PrefixUnaryExpressionSyntax unary:
                    return unary.IsKind(SyntaxKind.UnaryMinusExpression) || unary.IsKind(SyntaxKind.UnaryPlusExpression);
                case BinaryExpressionSyntax binary:
                    return binary.IsKind(SyntaxKind.AddExpression)
                        || binary.IsKind(SyntaxKind.SubtractExpression)
                        || binary.IsKind(SyntaxKind.MultiplyExpression)
                        || binary.IsKind(SyntaxKind.DivideExpression)
                        || binary.IsKind(SyntaxKind.ModuloExpression);
                case IdentifierNameSyntax:
                case MemberAccessExpressionSyntax:
                {
                    var symbol = model.GetSymbolInfo(node).Symbol;
                    // A field or local read, the type or namespace qualifying one, or a Math call's target.
                    return symbol is IFieldSymbol or ILocalSymbol or ITypeSymbol or INamespaceSymbol
                        || (symbol is IMethodSymbol method && IsMathMethod(method));
                }
                case InvocationExpressionSyntax invocation:
                    return model.GetSymbolInfo(invocation).Symbol is IMethodSymbol target && IsMathMethod(target);
                default:
                    return false;
            }
        }

        private string? FieldReference(IFieldSymbol field)
        {
            // A const has no storage: the author's own use site is the literal, so emit the literal.
            if (field.IsConst)
            {
                var literal = SymbolDisplay.FormatPrimitive(
                    field.ConstantValue!, quoteStrings: false, useHexadecimalNumbers: false);
                return $"(({field.Type.ToDisplayString(FullyQualified)})({literal}))";
            }
            // An accessible static field needs no accessor.
            if (field.IsStatic && IsOutwardlyAccessible(field))
            {
                return field.ToDisplayString(QualifiedMember);
            }
            // An inherited field is reachable: the accessor takes the declaring type, which the owner
            // converts to implicitly. A field of some unrelated type is not worth a special case.
            if (!Inherits(owner, field.ContainingType)
                && !SymbolEqualityComparer.Default.Equals(field.ContainingType, owner))
            {
                return null;
            }
            return $"{Accessor(field)}(self)";
        }

        private static bool IsOutwardlyAccessible(IFieldSymbol field) =>
            field.DeclaredAccessibility is Accessibility.Public or Accessibility.Internal
                or Accessibility.ProtectedOrInternal
            && field.ContainingType.DeclaredAccessibility is Accessibility.Public or Accessibility.Internal
                or Accessibility.NotApplicable;

        private static readonly SymbolDisplayFormat QualifiedMember = new(
            globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Included,
            typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
            memberOptions: SymbolDisplayMemberOptions.IncludeContainingType,
            miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

        private static readonly SymbolDisplayFormat FullyQualified =
            SymbolDisplayFormat.FullyQualifiedFormat.WithMiscellaneousOptions(
                SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

        private string Accessor(IFieldSymbol field)
        {
            var key = $"{field.ContainingType.ToDisplayString()}.{field.Name}";
            if (accessors.TryGetValue(key, out var existing))
            {
                return existing;
            }
            var name = $"Field_{captured.Count.ToString(CultureInfo.InvariantCulture)}_{Sanitize(field.Name)}";
            accessors[key] = name;
            captured.Add(new CapturedField(field, name));
            return name;
        }

        private static string Sanitize(string name) =>
            new([.. name.Select(character => char.IsLetterOrDigit(character) ? character : '_')]);

        private static string Replace(ExpressionSyntax node, Dictionary<SyntaxNode, string> replacements)
        {
            if (replacements.Count == 0)
            {
                return node.ToString();
            }
            return node.ReplaceNodes(
                    replacements.Keys.Cast<ExpressionSyntax>(),
                    (original, _) => SyntaxFactory.ParseExpression(replacements[original]).WithTriviaFrom(original))
                .ToString();
        }

        private string? CoordinateAxis(MemberAccessExpressionSyntax access)
        {
            if (!Coordinates.Contains(access.Name.Identifier.ValueText))
            {
                return null;
            }
            if (model.GetSymbolInfo(access).Symbol is not IFieldSymbol and not IPropertySymbol)
            {
                return null;
            }
            return IsCoordinate(access.Expression) ? access.Name.Identifier.ValueText : null;
        }

        private bool IsCoordinate(ExpressionSyntax expression) =>
            Unwrap(expression) is IdentifierNameSyntax identifier
            && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(identifier).Symbol, coordinate);

        /// <summary>A reference to the coordinate, or to a local that already carries it.</summary>
        private bool ReadsCoordinate(SyntaxNode node) =>
            node.DescendantNodesAndSelf()
                .OfType<IdentifierNameSyntax>()
                .Any(identifier => model.GetSymbolInfo(identifier).Symbol switch
                {
                    IParameterSymbol parameter => SymbolEqualityComparer.Default.Equals(parameter, coordinate),
                    ILocalSymbol local => locals.TryGetValue(local, out var found) && found.IsRegister,
                    _ => false,
                });
    }
}
