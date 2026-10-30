using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.Loader;
if (args.Length != 4) throw new ArgumentException("Expected dotnet, patcher DLL, original Roslyn DLL, and fresh output directory.");
var original = File.ReadAllBytes(args[2]);
if (Directory.Exists(args[3])) throw new IOException("Test output must be fresh.");
Directory.CreateDirectory(args[3]);
var first = Path.GetFullPath(Path.Combine(args[3], "first.dll"));
var second = Path.GetFullPath(Path.Combine(args[3], "second.dll"));
void Patch(string input, string output, string? expectedError = null)
{
    var start = new System.Diagnostics.ProcessStartInfo(args[0]) { RedirectStandardOutput = true, RedirectStandardError = true };
    start.ArgumentList.Add(args[1]); start.ArgumentList.Add(input); start.ArgumentList.Add(output);
    using var process = System.Diagnostics.Process.Start(start)!;
    var stdout = process.StandardOutput.ReadToEndAsync();
    var stderr = process.StandardError.ReadToEndAsync();
    process.WaitForExit();
    var error = stderr.GetAwaiter().GetResult();
    if (expectedError is null ? process.ExitCode != 0 : process.ExitCode == 0 || !error.Contains(expectedError, StringComparison.Ordinal))
        throw new Exception($"Unexpected patch result: {process.ExitCode} {stdout.GetAwaiter().GetResult()} {error}");
}
Patch(args[2], first);
Patch(args[2], second);
var patched = File.ReadAllBytes(first);
if (!patched.SequenceEqual(File.ReadAllBytes(second))) throw new Exception("Patch is not deterministic.");
Patch(args[2], first, "IOException");
if (!patched.SequenceEqual(File.ReadAllBytes(first))) throw new Exception("Existing output was modified.");
var rejected = Path.Combine(args[3], "rejected.dll");
Patch(first, rejected, "InvalidDataException");
if (File.Exists(rejected)) throw new Exception("Rejected input created an output.");
if (!original.SequenceEqual(File.ReadAllBytes(args[2]))) throw new Exception("Input assembly was modified.");
var context = new AssemblyLoadContext("patched");
var assembly = context.LoadFromAssemblyPath(first);
var type = assembly.GetType("Microsoft.Cci.DebugSourceDocument", true)!;
var method = type.GetMethod("CreateChecksumTask", BindingFlags.NonPublic | BindingFlags.Static)!;
var functionType = method.GetParameters()[0].ParameterType;
var resultType = functionType.GenericTypeArguments[0];
var success = Expression.Lambda(functionType, Expression.Default(resultType)).Compile();
var task = (Task)method.Invoke(null, new object[]{success})!;
if (!task.IsCompletedSuccessfully) throw new Exception("Checksum did not complete eagerly");
var failure = new InvalidOperationException("checksum failure");
var broken = Expression.Lambda(functionType, Expression.Throw(Expression.Constant(failure), resultType)).Compile();
var failed = (Task)method.Invoke(null, new object[]{broken})!;
if (!failed.IsFaulted || !ReferenceEquals(failed.Exception!.InnerException, failure)) throw new Exception("Checksum fault identity changed");
Console.WriteLine("Checksum determinism, input guards, success and faulted-task identity passed.");
