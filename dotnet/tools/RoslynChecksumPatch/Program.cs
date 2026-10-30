using System.Security.Cryptography;
using Mono.Cecil;
using Mono.Cecil.Cil;

if (args.Length != 2) throw new ArgumentException("Expected pinned Roslyn input and new output path.");
const string expected = "163529561bc8aa19b22067764a74fbf5432954ce1158d1988a6ef1b0f5a87a94";
var bytes = File.ReadAllBytes(args[0]);
if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(expected, StringComparison.OrdinalIgnoreCase))
    throw new InvalidDataException("Roslyn checksum adaptation requires the pinned 5.9.0 assembly.");
using var input = new MemoryStream(bytes, writable: false);
using var assembly = AssemblyDefinition.ReadAssembly(input);
var type = assembly.MainModule.Types.Single(t => t.FullName == "Microsoft.Cci.DebugSourceDocument");
var fromResult = type.Methods.Where(m => m.HasBody).SelectMany(m => m.Body.Instructions)
    .Select(i => i.Operand).OfType<GenericInstanceMethod>().Single(m => m.Name == "FromResult");
var sites = type.Methods.Where(m => m.HasBody)
    .SelectMany(method => method.Body.Instructions.Select(instruction => (method, instruction)))
    .Where(site => site.instruction.Operand is GenericInstanceMethod called &&
        called.Name == "Run" && called.DeclaringType.FullName == "System.Threading.Tasks.Task").ToArray();
if (sites.Length != 1) throw new InvalidDataException("Expected exactly one checksum scheduling site.");
var (method, instruction) = sites[0];
var parameter = method.Parameters.Single(p => p.ParameterType is GenericInstanceType g &&
    g.ElementType.FullName == "System.Func`1");
var invoke = new MethodReference("Invoke", ((GenericInstanceType)parameter.ParameterType).ElementType.GenericParameters[0],
    parameter.ParameterType) { HasThis = true };
// Eager execution must preserve Task.Run's faulted-task behavior if checksum production throws.
var resultType = fromResult.GenericArguments.Single();
var taskType = new GenericInstanceType(((GenericInstanceType)fromResult.ElementMethod.ReturnType).ElementType);
taskType.GenericArguments.Add(resultType);
var helper = new MethodDefinition("CreateChecksumTask", MethodAttributes.Private | MethodAttributes.Static, taskType);
helper.Parameters.Add(new ParameterDefinition("produce", ParameterAttributes.None, parameter.ParameterType));
helper.Body.InitLocals = true;
helper.Body.Variables.Add(new VariableDefinition(taskType));
var exceptionType = new TypeReference("System", "Exception", assembly.MainModule, assembly.MainModule.TypeSystem.Object.Scope);
var fromException = new MethodReference("FromException", assembly.MainModule.TypeSystem.Void, fromResult.DeclaringType);
var generic = new GenericParameter("TResult", fromException);
fromException.GenericParameters.Add(generic);
var genericTask = new GenericInstanceType(taskType.ElementType);
genericTask.GenericArguments.Add(generic);
fromException.ReturnType = genericTask;
fromException.Parameters.Add(new ParameterDefinition(exceptionType));
var faulted = new GenericInstanceMethod(fromException);
faulted.GenericArguments.Add(resultType);
var il = helper.Body.GetILProcessor();
var start = Instruction.Create(OpCodes.Ldarg_0);
var handler = Instruction.Create(OpCodes.Call, faulted);
var done = Instruction.Create(OpCodes.Ldloc_0);
il.Append(start);
il.Append(Instruction.Create(OpCodes.Callvirt, invoke));
il.Append(Instruction.Create(OpCodes.Call, fromResult));
il.Append(Instruction.Create(OpCodes.Stloc_0));
il.Append(Instruction.Create(OpCodes.Leave, done));
il.Append(handler);
il.Append(Instruction.Create(OpCodes.Stloc_0));
il.Append(Instruction.Create(OpCodes.Leave, done));
il.Append(done);
il.Append(Instruction.Create(OpCodes.Ret));
helper.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch) {
    CatchType = exceptionType, TryStart = start, TryEnd = handler, HandlerStart = handler, HandlerEnd = done,
});
type.Methods.Add(helper);
instruction.Operand = helper;
using var output = new FileStream(args[1], FileMode.CreateNew, FileAccess.Write);
assembly.Write(output);
Console.WriteLine("Adapted the single pinned Roslyn source-checksum scheduler.");
