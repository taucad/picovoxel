using System.Diagnostics;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

// W0: the page supplies original source and reference DLL bytes. No compiler server.
public static class Authoring
{
    public static Assembly Compile(string directory)
    {
        var sw = Stopwatch.StartNew();
        var references = Directory.GetFiles("/refs", "*.dll")
            .Select(path => MetadataReference.CreateFromFile(path)).ToArray();
        var sources = Directory.GetFiles(directory, "*.cs", SearchOption.AllDirectories)
            .Select(path => CSharpSyntaxTree.ParseText(File.ReadAllText(path), path: path)).ToArray();
        Console.WriteLine($"authoring: {sources.Length} source files, {references.Length} references; prepare {sw.Elapsed.TotalMilliseconds:F1} ms");
        sw.Restart();
        var implicitUsings = CSharpSyntaxTree.ParseText("global using System; global using System.Collections.Generic; global using System.IO; global using System.Linq; global using System.Net.Http; global using System.Threading; global using System.Threading.Tasks;");
        var compilation = CSharpCompilation.Create("Authored" + Guid.NewGuid().ToString("N"), sources.Append(implicitUsings), references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: OptimizationLevel.Release, allowUnsafe: true, concurrentBuild: false));
        using var image = new MemoryStream();
        var result = compilation.Emit(image);
        if (!result.Success)
            throw new InvalidOperationException(string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        Console.WriteLine($"authoring: compile {sw.Elapsed.TotalMilliseconds:F1} ms; IL {image.Length} bytes");
        sw.Restart();
        var assembly = Assembly.Load(image.ToArray());
        Console.WriteLine($"authoring: load {sw.Elapsed.TotalMilliseconds:F1} ms; assembly {assembly.GetName().Name}");
        return assembly;
    }

    public static Action Task(Assembly assembly, string type) =>
        assembly.GetType(type, throwOnError: true).GetMethod("Task").CreateDelegate<Action>();
}
