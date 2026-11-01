// runshape-cs record -out <traces> -run <name> <project> [tests...]
//
// Records a .NET project's tests (dotnet test) into <traces>/<name> and makes it latest.json.
// The project itself is only read: a copy is instrumented and built.
using Runshape.Record;

const string Usage = "usage: runshape-cs record -out <traces directory> -run <run name> <project root> [what dotnet test runs...]";

if (args.Length == 0 || args[0] != "record")
{
    Console.Error.WriteLine(Usage);
    return 2;
}
string? output = null;
var run = "run";
var positional = new List<string>();
for (var i = 1; i < args.Length; i++)
{
    switch (args[i])
    {
        case "-out" when i + 1 < args.Length:
            output = args[++i];
            break;
        case "-run" when i + 1 < args.Length:
            run = args[++i];
            break;
        default:
            positional.Add(args[i]);
            break;
    }
}
if (output is null || positional.Count == 0)
{
    Console.Error.WriteLine(Usage);
    return 2;
}
try
{
    var runtime = Path.Combine(AppContext.BaseDirectory, "Runshape.Runtime.dll");
    var options = new RecordOptions(positional[0], Path.GetFullPath(output), run, positional.Skip(1).ToList(), runtime);
    var recorded = Recording.Record(options, Console.Out);
    Console.Error.WriteLine($"runshape-cs: recorded {recorded} tests into {Path.Combine(options.Out, run)}");
    return 0;
}
catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException)
{
    Console.Error.WriteLine($"runshape-cs: {error.Message}");
    return 1;
}
