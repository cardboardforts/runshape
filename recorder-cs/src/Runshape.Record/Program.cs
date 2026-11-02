// runshape-cs record [-out dir] [-run name] [-locked] <project> [what dotnet test runs...]
//
// Records a .NET project's tests (dotnet test) into <out>/<run> (default
// <project>/.runshape/traces/<time>) and makes it latest.json. The project itself is only read:
// a copy is instrumented and built. -locked restores only what the lock files pin.
using Runshape.Record;

const string Usage = "usage: runshape-cs record [-out <traces directory>] [-run <run name>] [-locked] <project root> [what dotnet test runs...]";

if (args.Length == 0 || args[0] != "record")
{
    Console.Error.WriteLine(Usage);
    return 2;
}
string? output = null;
var run = DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture);
var locked = false;
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
        case "-locked":
            locked = true;
            break;
        default:
            positional.Add(args[i]);
            break;
    }
}
if (positional.Count == 0)
{
    Console.Error.WriteLine(Usage);
    return 2;
}
// `npm run record-cs` runs this from the repository's root: paths are read from where it was typed.
var typedIn = Environment.GetEnvironmentVariable("INIT_CWD") ?? Directory.GetCurrentDirectory();
var project = Path.GetFullPath(positional[0], typedIn);
output = Path.GetFullPath(output ?? Path.Combine(project, ".runshape", "traces"), typedIn);
try
{
    var runtime = Path.Combine(AppContext.BaseDirectory, "Runshape.Runtime.dll");
    var options = new RecordOptions(project, output, run, positional.Skip(1).ToList(), runtime, locked);
    var recorded = Recording.Record(options, Console.Out);
    Console.Error.WriteLine($"runshape-cs: recorded {recorded} tests into {Path.Combine(options.Out, run)}");
    return 0;
}
catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException)
{
    Console.Error.WriteLine($"runshape-cs: {error.Message}");
    return 1;
}
