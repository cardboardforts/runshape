// Records a .NET solution's tests in trace format version 2: copies the project, instruments the
// copy (Instrumenter), points each instrumented project at the runtime's DLL, runs `dotnet test`
// and writes the run's manifest beside the scenarios the tests wrote.
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Runshape.Record;

public sealed record RecordOptions(
    /// <summary>The project's root: its solution or project files are there.</summary>
    string Root,
    /// <summary>The traces directory: the run goes in Out/Run, and latest.json points at it.</summary>
    string Out,
    string Run,
    /// <summary>What dotnet test runs (solutions, projects, folders), relative to the root; empty: the root's one solution or project.</summary>
    IReadOnlyList<string> Tests,
    /// <summary>The runtime's DLL, which each instrumented project references.</summary>
    string RuntimeAssembly,
    /// <summary>Restore only what the lock files pin (the sandbox: its packages were fetched by them).</summary>
    bool Locked = false);

public sealed record Problem(string File, string Reason);

public sealed record ScenarioEntry(string Nodeid, string File, string Outcome, long DurationUs, int EventCount, int RecorderErrors);

public static partial class Recording
{
    public const string Version = "recorder-cs 0.1.0";

    /// <summary>Folders never copied: build output, other tools' state, and anything hidden (.git, .vs, .runshape).</summary>
    private static readonly HashSet<string> SkippedFolders = new(StringComparer.OrdinalIgnoreCase) { "bin", "obj", "node_modules", "TestResults" };

    /// <summary>Packages that make a project a test project, as `dotnet test` itself decides (Microsoft.NET.Test.Sdk), or by its framework.</summary>
    private static readonly string[] TestPackages = ["Microsoft.NET.Test.Sdk", "xunit", "xunit.v3", "NUnit", "MSTest", "MSTest.TestFramework", "TUnit"];

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static int Record(RecordOptions options, TextWriter log)
    {
        // Before anything touches the disk: Out/Run is removed and rewritten.
        if (options.Run is "" or "." or ".." || options.Run.IndexOfAny(['/', '\\']) >= 0) throw new ArgumentException($"run name \"{options.Run}\" must be one directory name");
        var root = Path.GetFullPath(options.Root);
        var target = TestTarget(root, options.Tests);
        var work = Directory.CreateTempSubdirectory("runshape-cs-").FullName;
        try
        {
            var prepared = Prepare(root, work, options.RuntimeAssembly);
            var run = Path.Combine(options.Out, options.Run);
            if (Directory.Exists(run)) Directory.Delete(run, recursive: true);
            Directory.CreateDirectory(Path.Combine(run, "scenarios"));
            var table = Path.Combine(work, ".runshape-functions.json");
            File.WriteAllBytes(table, JsonSerializer.SerializeToUtf8Bytes(new { functions = prepared.Functions, types = prepared.Types }, Json));
            var createdAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:sszzz");
            var (exitCode, output) = DotnetTest(work, target, run, table, options.Locked);
            log.Write(output);
            var scenarios = ScenarioIndex(run);
            var sessionProblems = TestProblems(output);
            if (scenarios.Count == 0)
            {
                throw new InvalidOperationException($"no test was recorded (dotnet test exited with {exitCode}){(sessionProblems.Count > 0 ? ":\n  " + string.Join("\n  ", sessionProblems) : "")}");
            }
            var manifest = new Dictionary<string, object?>
            {
                ["format"] = "runshape-trace", ["version"] = 2, ["createdAt"] = createdAt, ["language"] = "csharp",
                ["runtime"] = $"dotnet {DotnetVersion(work)}", ["recorder"] = Version, ["backend"] = "instrument", ["root"] = root,
                ["framework"] = null, ["catalog"] = prepared.Catalog, ["sources"] = prepared.Sources, ["catalogProblems"] = prepared.Problems,
                ["sessionProblems"] = sessionProblems, ["scenarios"] = scenarios,
            };
            File.WriteAllBytes(Path.Combine(run, "manifest.json"), JsonSerializer.SerializeToUtf8Bytes(manifest, Json));
            MovePointers(options.Out, options.Run);
            return scenarios.Count;
        }
        finally
        {
            Directory.Delete(work, recursive: true);
        }
    }

    /// <summary>What dotnet test is given: the configured paths, else the root's one solution, else its one project.</summary>
    internal static IReadOnlyList<string> TestTarget(string root, IReadOnlyList<string> tests)
    {
        foreach (var test in tests)
        {
            if (Path.IsPathRooted(test) || test.Split('/', '\\').Contains("..") || test.StartsWith('-')) throw new ArgumentException($"test path \"{test}\" must be a path inside the project");
        }
        if (tests.Count > 0) return tests;
        var files = Directory.GetFiles(root).Select(Path.GetFileName).ToList();
        var solutions = files.Where(name => name!.EndsWith(".sln", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase)).ToList();
        if (solutions.Count == 1) return [solutions[0]!];
        var projects = files.Where(name => name!.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)).ToList();
        if (solutions.Count == 0 && projects.Count == 1) return [projects[0]!];
        throw new ArgumentException($"the root has {solutions.Count} solutions and {projects.Count} projects: name what to test in runshape.json's recorder.tests");
    }

    internal sealed record Prepared(List<object> Functions, Dictionary<string, string[]> Types, List<CatalogEntry> Catalog, SortedDictionary<string, string[]> Sources, List<Problem> Problems);

    /// <summary>Copies the project into <paramref name="work"/>, instrumenting the C# its projects compile.</summary>
    internal static Prepared Prepare(string root, string work, string runtimeAssembly)
    {
        var files = new List<string>();
        Copy(root, work, "", files);
        var projects = files.Where(file => file.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)).Select(file => ProjectFile.Read(work, file)).ToList();
        var functions = new List<object>();
        var tests = new List<object>();
        var types = new Dictionary<string, string[]>();
        var catalog = new List<CatalogEntry>();
        var sources = new SortedDictionary<string, string[]>(StringComparer.Ordinal);
        var problems = new List<Problem>();
        var instrumented = new HashSet<ProjectFile>();
        foreach (var project in projects.Where(project => project.Unsupported is not null)) problems.Add(new Problem(project.Path, project.Unsupported!));
        foreach (var file in files.Where(file => file.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)).Order(StringComparer.Ordinal))
        {
            var project = OwnerOf(file, projects);
            // Not under any project (a script, a sample), or under one the runtime can't join.
            if (project is null || project.Unsupported is not null) continue;
            var path = Path.Combine(work, file);
            var source = File.ReadAllText(path);
            try
            {
                if (project.IsTest)
                {
                    var result = Instrumenter.InstrumentTests(file, source, functions.Count);
                    if (result.Tests.Count == 0) continue;
                    foreach (var test in result.Tests) functions.Add(new { role = "test", symbol = test.Symbol, file = test.File, firstLine = test.FirstLine, nodeid = test.Nodeid });
                    File.WriteAllText(path, result.Code);
                }
                else
                {
                    var result = Instrumenter.Instrument(file, source, functions.Count);
                    foreach (var (clr, segments) in result.Types) types[clr] = segments;
                    if (result.Functions.Count == 0) continue;
                    foreach (var entry in result.Functions) functions.Add(new { role = "source", symbol = entry.Symbol, file = entry.File, firstLine = entry.FirstLine });
                    catalog.AddRange(result.Functions);
                    sources[file] = source.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
                    File.WriteAllText(path, result.Code);
                }
                instrumented.Add(project);
            }
            catch (Exception error)
            {
                problems.Add(new Problem(file, error.Message));
            }
        }
        foreach (var project in instrumented) project.ReferenceRuntime(runtimeAssembly);
        return new Prepared(functions, types, catalog, sources, problems);
    }

    /// <summary>The project a file is compiled into: the nearest folder above it with a .csproj (SDK projects compile everything under them).</summary>
    private static ProjectFile? OwnerOf(string file, List<ProjectFile> projects)
    {
        ProjectFile? best = null;
        foreach (var project in projects)
        {
            var folder = project.Folder == "" ? "" : project.Folder + "/";
            if (file.StartsWith(folder, StringComparison.Ordinal) && (best is null || project.Folder.Length > best.Folder.Length)) best = project;
        }
        return best;
    }

    /// <summary>Copies a folder, links as links (pointing where they pointed); <paramref name="files"/> gets each file's "/"-path.</summary>
    private static void Copy(string from, string to, string relative, List<string> files)
    {
        Directory.CreateDirectory(Path.Combine(to, relative));
        foreach (var entry in new DirectoryInfo(Path.Combine(from, relative)).EnumerateFileSystemInfos().OrderBy(entry => entry.Name, StringComparer.Ordinal))
        {
            var path = relative == "" ? entry.Name : relative + "/" + entry.Name;
            if (entry.LinkTarget is { } link)
            {
                var destination = Path.IsPathRooted(link) ? link : Path.GetFullPath(Path.Combine(Path.GetDirectoryName(entry.FullName)!, link));
                if (entry is DirectoryInfo) Directory.CreateSymbolicLink(Path.Combine(to, path), destination);
                else File.CreateSymbolicLink(Path.Combine(to, path), destination);
                continue;
            }
            if (entry is DirectoryInfo)
            {
                if (entry.Name.StartsWith('.') || SkippedFolders.Contains(entry.Name)) continue;
                Copy(from, to, path, files);
            }
            else
            {
                File.Copy(entry.FullName, Path.Combine(to, path));
                files.Add(path);
            }
        }
    }

    /// <summary>
    /// Runs the copy's tests. Node reuse and the shared compiler server are off, so nothing is
    /// left running; DOTNET_ROLL_FORWARD lets a test project for an older .NET run on the
    /// installed one (said in docs/design.md: it's the one difference from running them yourself).
    /// </summary>
    private static (int ExitCode, string Output) DotnetTest(string work, IReadOnlyList<string> targets, string run, string table, bool locked)
    {
        var output = new System.Text.StringBuilder();
        var exitCode = 0;
        foreach (var target in targets)
        {
            var start = new ProcessStartInfo("dotnet") { WorkingDirectory = work, RedirectStandardOutput = true, RedirectStandardError = true };
            string[] arguments = ["test", target, "--nologo", "-nodeReuse:false", "-p:UseSharedCompilation=false", .. locked ? new[] { "-p:RestoreLockedMode=true" } : []];
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            start.Environment["RUNSHAPE_RUN_DIR"] = Path.GetFullPath(run);
            start.Environment["RUNSHAPE_FUNCTIONS"] = table;
            start.Environment["DOTNET_ROLL_FORWARD"] = "Major";
            start.Environment["MSBUILDDISABLENODEREUSE"] = "1";
            start.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
            start.Environment["DOTNET_NOLOGO"] = "1";
            using var process = Process.Start(start)!;
            process.OutputDataReceived += (_, line) => { if (line.Data is not null) lock (output) output.AppendLine(line.Data); };
            process.ErrorDataReceived += (_, line) => { if (line.Data is not null) lock (output) output.AppendLine(line.Data); };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            if (process.ExitCode != 0) exitCode = process.ExitCode;
        }
        return (exitCode, output.ToString());
    }

    private static string DotnetVersion(string work)
    {
        var start = new ProcessStartInfo("dotnet", "--version") { WorkingDirectory = work, RedirectStandardOutput = true };
        using var process = Process.Start(start)!;
        var version = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();
        return version;
    }

    [GeneratedRegex(@"^\s*(?<file>[^\s(][^(]*)\(\d+,\d+\): error (?<code>[A-Z]+\d+): ", RegexOptions.Multiline)]
    private static partial Regex BuildError();

    /// <summary>
    /// What dotnet test said that means tests are missing rather than removed: projects that
    /// didn't build, and test runs that were aborted (a crash, a stack overflow).
    /// </summary>
    internal static List<string> TestProblems(string output)
    {
        var problems = new List<string>();
        var failedBuilds = BuildError().Matches(output).Select(match => $"{Path.GetFileName(match.Groups["file"].Value.Trim())}: {match.Groups["code"].Value}").Distinct().ToList();
        if (failedBuilds.Count > 0) problems.Add($"the build failed ({string.Join(", ", failedBuilds.Take(5))}{(failedBuilds.Count > 5 ? ", ..." : "")}), so its tests are missing from this recording");
        if (output.Contains("The active test run was aborted", StringComparison.Ordinal)) problems.Add("a test run was aborted (the test host crashed), so the tests after it didn't run");
        return problems;
    }

    /// <summary>The scenarios the tests wrote, in the order they ended (their names start with the time).</summary>
    private static List<ScenarioEntry> ScenarioIndex(string run)
    {
        var index = new List<ScenarioEntry>();
        foreach (var path in Directory.GetFiles(Path.Combine(run, "scenarios"), "*.json").Order(StringComparer.Ordinal))
        {
            using var scenario = JsonDocument.Parse(File.ReadAllBytes(path));
            var data = scenario.RootElement;
            index.Add(new ScenarioEntry(
                data.GetProperty("nodeid").GetString()!, "scenarios/" + Path.GetFileName(path), data.GetProperty("outcome").GetString()!,
                data.GetProperty("durationUs").GetInt64(), data.GetProperty("events").GetArrayLength(), data.GetProperty("recorderErrors").GetArrayLength()));
        }
        return index;
    }

    /// <summary>Makes the new run latest, and the run that was latest previous.</summary>
    private static void MovePointers(string output, string run)
    {
        var latest = Path.Combine(output, "latest.json");
        if (File.Exists(latest))
        {
            var text = File.ReadAllText(latest);
            try
            {
                if (JsonDocument.Parse(text).RootElement.GetProperty("run").GetString() != run) File.WriteAllText(Path.Combine(output, "previous.json"), text);
            }
            catch (Exception error) when (error is JsonException or KeyNotFoundException)
            {
            }
        }
        File.WriteAllText(latest, JsonSerializer.Serialize(new { run }));
    }

    /// <summary>A .csproj in the copy: whether it holds tests, whether the runtime can join it, and how to point it at the runtime.</summary>
    internal sealed class ProjectFile
    {
        internal required string Path { get; init; }
        internal required string Folder { get; init; }
        internal required bool IsTest { get; init; }
        /// <summary>Why it's copied as written, uninstrumented; null when it can be instrumented.</summary>
        internal string? Unsupported { get; init; }
        private string FullPath { get; init; } = "";

        internal static ProjectFile Read(string work, string path)
        {
            var full = System.IO.Path.Combine(work, path);
            var folder = path.Contains('/') ? path[..path.LastIndexOf('/')] : "";
            XDocument document;
            try
            {
                document = XDocument.Load(full);
            }
            catch (Exception error)
            {
                return new ProjectFile { Path = path, Folder = folder, IsTest = false, Unsupported = $"not read as a project: {error.Message}", FullPath = full };
            }
            var elements = document.Descendants().ToList();
            var packages = elements.Where(e => e.Name.LocalName == "PackageReference").Select(e => (string?)e.Attribute("Include") ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
            var isTest = TestPackages.Any(packages.Contains) || elements.Any(e => e.Name.LocalName == "IsTestProject" && e.Value.Trim().Equals("true", StringComparison.OrdinalIgnoreCase));
            var frameworks = elements.Where(e => e.Name.LocalName is "TargetFramework" or "TargetFrameworks").SelectMany(e => e.Value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)).ToList();
            var older = frameworks.Where(framework => !framework.StartsWith("$(", StringComparison.Ordinal) && !RuntimeCanJoin(framework)).ToList();
            var unsupported = older.Count > 0 ? $"targets {string.Join(", ", older)}: the recorder's runtime needs .NET 8 or later, so this project isn't recorded" : null;
            return new ProjectFile { Path = path, Folder = folder, IsTest = isTest, Unsupported = unsupported, FullPath = full };
        }

        /// <summary>net8.0 and later (net10.0-windows too); not .NET Framework, .NET Standard, or .NET 5-7.</summary>
        private static bool RuntimeCanJoin(string framework)
        {
            var match = Regex.Match(framework, @"^net(\d+)\.\d+");
            return match.Success && int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) >= 8;
        }

        /// <summary>
        /// References the runtime's DLL, and lets the build through what instrumenting adds:
        /// warnings (an analyzer's, a style rule's) that the project treats as errors.
        /// </summary>
        internal void ReferenceRuntime(string runtimeAssembly)
        {
            var document = XDocument.Load(FullPath, LoadOptions.PreserveWhitespace);
            var ns = document.Root!.Name.Namespace;
            document.Root.Add(
                new XElement(ns + "ItemGroup",
                    new XElement(ns + "Reference", new XAttribute("Include", "Runshape.Runtime"), new XElement(ns + "HintPath", runtimeAssembly))),
                new XElement(ns + "PropertyGroup",
                    new XElement(ns + "TreatWarningsAsErrors", "false"),
                    new XElement(ns + "WarningsAsErrors", ""),
                    new XElement(ns + "RunAnalyzers", "false"),
                    new XElement(ns + "EnforceCodeStyleInBuild", "false")));
            document.Save(FullPath);
        }
    }
}
