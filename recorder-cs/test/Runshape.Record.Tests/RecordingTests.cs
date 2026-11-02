// The recorder end to end on testdata/probe: copied, instrumented, built and run by dotnet test,
// each test's calls drawn as the tree the scenario holds. Slow (a real build), so one test
// shows everything a recording says.
using System.Text;
using System.Text.Json;
using Xunit;

namespace Runshape.Record.Tests;

public class RecordingTests
{
    private static readonly string Probe = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../testdata/probe"));

    [Fact]
    public void Records_each_test_as_a_tree_of_calls_placed_by_async_flow()
    {
        var output = Directory.CreateTempSubdirectory("runshape-cs-test-").FullName;
        try
        {
            var log = new StringWriter();
            var recorded = Recording.Record(new RecordOptions(Probe, output, "run", ["tests/Probe.Tests"], typeof(Runshape.Runtime.Trace).Assembly.Location), log);
            Assert.True(recorded == 3, log.ToString());

            var run = Path.Combine(output, "run");
            using var manifest = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(run, "manifest.json")));
            var root = manifest.RootElement;
            Assert.Equal(("runshape-trace", 2, "csharp"), (root.GetProperty("format").GetString(), root.GetProperty("version").GetInt32(), root.GetProperty("language").GetString()));
            Assert.Equal(
                ["Counter.Tick", "Counter.get_Value", "Pipeline.constructor", "Pipeline.RunAsync", "Pipeline.Step", "Pipeline.Evens", "Pipeline.Twice", "Pipeline.Explode"],
                root.GetProperty("catalog").EnumerateArray().Select(entry => NameOf(entry.GetProperty("symbol"))));
            Assert.True(root.GetProperty("sources").TryGetProperty("src/Probe/Pipeline.cs", out _));
            Assert.Equal("{\"run\":\"run\"}", File.ReadAllText(Path.Combine(output, "latest.json")));

            var drawn = string.Join("\n", root.GetProperty("scenarios").EnumerateArray()
                .OrderBy(entry => entry.GetProperty("nodeid").GetString(), StringComparer.Ordinal)
                .Select(entry => Draw(Path.Combine(run, entry.GetProperty("file").GetString()!))));
            // - Step runs on the thread pool (Task.Run), and is still RunAsync's call: the async flow carries it.
            // - 60 ticks from one caller: the first 50 are recorded, the rest counted (the TypeScript and Go recorders' limit).
            // - An iterator's body runs inside the caller's MoveNext: Twice is the test's call, not Evens'.
            // - A test that throws is failed, and the method it threw from still ends.
            // - Objects: the Pipeline, built by its constructor, is wired to its Counter through _counter.
            Assert.Equal("""
                Probe.Tests.PipelineTests.Fails failed
                  Pipeline.constructor [object 1 Probe.Pipeline built here; 1._counter -> 2]
                  Pipeline.Explode
                Probe.Tests.PipelineTests.Iterates passed
                  Pipeline.constructor [object 1 Probe.Pipeline built here; 1._counter -> 2]
                  Pipeline.Evens
                  Pipeline.Twice x3
                Probe.Tests.PipelineTests.Runs_async_work_under_its_caller passed
                  Pipeline.constructor [object 1 Probe.Pipeline built here; 1._counter -> 2]
                  Pipeline.RunAsync
                    Pipeline.Step
                    Counter.Tick x50
                    Counter.get_Value
                  ! 10 more calls of Counter.Tick from Pipeline.RunAsync were not recorded (limit 50 per caller)
                """, drawn);
        }
        finally
        {
            Directory.Delete(output, recursive: true);
        }
    }

    [Fact]
    public void A_linked_source_file_is_copied_as_a_link_and_never_read_or_rewritten_through()
    {
        // The copy keeps a link pointing where the original pointed (the Go recorder's rule): a
        // rewrite written through it would land outside the copy, in the person's files.
        var root = Directory.CreateTempSubdirectory("runshape-cs-link-").FullName;
        var work = Directory.CreateTempSubdirectory("runshape-cs-work-").FullName;
        var outside = Path.Combine(Directory.CreateTempSubdirectory("runshape-cs-outside-").FullName, "Elsewhere.cs");
        try
        {
            var original = "namespace X; public class Elsewhere { public void Run() { } }";
            File.WriteAllText(outside, original);
            File.WriteAllText(Path.Combine(root, "Lib.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
            File.WriteAllText(Path.Combine(root, "Own.cs"), "namespace X; public class Own { public void Run() { } }");
            File.CreateSymbolicLink(Path.Combine(root, "Linked.cs"), outside);

            var prepared = Recording.Prepare(root, Directory.CreateDirectory(Path.Combine(work, "copy")).FullName, "/runtime/Runshape.Runtime.dll");

            Assert.Equal(["Own.Run"], prepared.Catalog.Select(entry => $"{entry.Symbol.Container[0]}.{entry.Symbol.Name}"));
            Assert.Equal(original, File.ReadAllText(outside));
            Assert.NotNull(new FileInfo(Path.Combine(work, "copy", "Linked.cs")).LinkTarget);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
            Directory.Delete(work, recursive: true);
            Directory.Delete(Path.GetDirectoryName(outside)!, recursive: true);
        }
    }

    [Fact]
    public void A_project_file_with_a_DTD_is_not_read_as_a_project()
    {
        // An entity could expand without bound, or read another file into the project's text.
        var root = Directory.CreateTempSubdirectory("runshape-cs-dtd-").FullName;
        var work = Directory.CreateTempSubdirectory("runshape-cs-work-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(root, "Lib.csproj"), "<!DOCTYPE Project [<!ENTITY x SYSTEM \"/etc/passwd\">]><Project>&x;</Project>");
            File.WriteAllText(Path.Combine(root, "Own.cs"), "namespace X; public class Own { public void Run() { } }");

            var prepared = Recording.Prepare(root, work, "/runtime/Runshape.Runtime.dll");

            Assert.Empty(prepared.Catalog);
            Assert.StartsWith("not read as a project: ", Assert.Single(prepared.Problems).Reason);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
            Directory.Delete(work, recursive: true);
        }
    }

    private static string NameOf(JsonElement symbol) =>
        string.Join(".", symbol.GetProperty("container").EnumerateArray().Select(part => part.GetString()).Append(symbol.GetProperty("name").GetString()));

    /// <summary>A scenario as its call tree: repeated calls folded ("x50"), objects and wiring beside the call they happened in.</summary>
    private static string Draw(string path)
    {
        using var scenario = JsonDocument.Parse(File.ReadAllBytes(path));
        var data = scenario.RootElement;
        var functions = data.GetProperty("functions").EnumerateArray().Select(f => NameOf(f.GetProperty("symbol"))).ToList();
        var children = new Dictionary<int, List<int>>();
        var name = new Dictionary<int, string>();
        var notes = new Dictionary<int, List<string>>();
        var builtBy = new Dictionary<int, int>();
        foreach (var e in data.GetProperty("events").EnumerateArray())
        {
            var tag = e[0].GetString();
            if (tag == "S")
            {
                var span = e[2].GetInt32();
                name[span] = functions[e[3].GetInt32()];
                if (e[4].ValueKind == JsonValueKind.Number) (children.TryGetValue(e[4].GetInt32(), out var list) ? list : children[e[4].GetInt32()] = []).Add(span);
            }
            else if (tag == "O" && e[4].ValueKind == JsonValueKind.Number)
            {
                builtBy[e[2].GetInt32()] = e[4].GetInt32();
                Note(e[4].GetInt32(), $"object {e[2]} {string.Join(".", e[3].EnumerateArray().Select(s => s.GetString()))} built here");
            }
            else if (tag == "W")
            {
                Note(builtBy.GetValueOrDefault(e[2].GetInt32()), $"{e[2]}.{e[3].GetString()} -> {e[4]}");
            }
        }
        var text = new StringBuilder($"{data.GetProperty("nodeid").GetString()} {data.GetProperty("outcome").GetString()}");
        void Walk(int span, int depth)
        {
            if (!children.TryGetValue(span, out var spans)) return;
            for (var i = 0; i < spans.Count; i++)
            {
                var repeats = 1;
                while (i + repeats < spans.Count && name[spans[i + repeats]] == name[spans[i]] && !children.ContainsKey(spans[i]) && !children.ContainsKey(spans[i + repeats])) repeats++;
                var suffix = repeats > 1 ? $" x{repeats}" : "";
                var note = notes.TryGetValue(spans[i], out var n) ? $" [{string.Join("; ", n)}]" : "";
                text.Append('\n').Append(new string(' ', depth * 2)).Append(name[spans[i]]).Append(suffix).Append(note);
                Walk(spans[i], depth + 1);
                i += repeats - 1;
            }
        }
        Walk(0, 1);
        foreach (var error in data.GetProperty("recorderErrors").EnumerateArray()) text.Append("\n  ! ").Append(error.GetString());
        return text.ToString();

        void Note(int span, string note) => (notes.TryGetValue(span, out var list) ? list : notes[span] = []).Add(note);
    }
}
