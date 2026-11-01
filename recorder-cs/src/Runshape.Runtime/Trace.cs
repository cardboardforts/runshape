// What instrumented C# code calls (the recorder's Instrumenter writes the calls): each test is
// a scenario in trace format version 2 (docs/trace-format.md), written to
// $RUNSHAPE_RUN_DIR/scenarios. Without that variable the code runs as written and nothing is
// recorded.
//
// Calls are placed by the async flow they run in (AsyncLocal), so tests running in parallel,
// and work a test awaits or hands to Task.Run, land in the right scenario under the right
// caller.
using System.Diagnostics;
using System.Text.Json;

namespace Runshape.Runtime;

public static class Trace
{
    /// <summary>The call in progress on this async flow: a test's root, a recorded call, or one a limit left out.</summary>
    internal static readonly AsyncLocal<Frame?> Current = new();

    private static readonly Lazy<Registry?> LoadedRegistry = new(Registry.FromEnvironment, LazyThreadSafetyMode.ExecutionAndPublication);

    internal static Registry? Registry => LoadedRegistry.Value;

    /// <summary>Opens a frame for catalogued function <paramref name="function"/>, called on <paramref name="self"/> (null for static code and structs).</summary>
    public static Frame Enter(int function, object? self) => Open(function, self, becomesCurrent: true);

    /// <summary>
    /// An iterator's frame: its body runs a piece at a time inside the caller's MoveNext, so it
    /// never becomes the caller's current call (it would stay current after the first yield).
    /// </summary>
    public static Frame EnterIterator(int function, object? self) => Open(function, self, becomesCurrent: false);

    /// <summary>Starts recording a test. Its methods' arguments name a theory's case.</summary>
    public static TestScope Scenario(int testFunction, object?[]? arguments)
    {
        var registry = Registry;
        if (registry is null) return TestScope.None;
        Boundaries.Listen();
        return registry.StartScenario(testFunction, arguments);
    }

    private static Frame Open(int function, object? self, bool becomesCurrent)
    {
        var parent = Current.Value;
        if (parent is null || parent.Scenario is not { } scenario) return Frame.None;
        var frame = scenario.Open(parent, function, self);
        if (becomesCurrent) Current.Value = frame;
        else frame.Detached = true;
        return frame;
    }
}

/// <summary>One call of an instrumented function.</summary>
public sealed class Frame : IDisposable
{
    internal static readonly Frame None = new(null, null, ScenarioState.NotRecorded, -1, null);

    internal readonly ScenarioState? Scenario;
    internal readonly Frame? Parent;
    internal readonly int Span;
    internal readonly int Function;
    internal readonly object? Self;
    internal bool Detached;
    private int _closed;

    internal Frame(ScenarioState? scenario, Frame? parent, int span, int function, object? self)
    {
        Scenario = scenario;
        Parent = parent;
        Span = span;
        Function = function;
        Self = self;
    }

    /// <summary>Line <paramref name="line"/> ran: recorded once per call.</summary>
    public void Line(int line)
    {
        if (Span != ScenarioState.NotRecorded) Scenario?.Line(Span, line);
    }

    public void Dispose()
    {
        if (Scenario is null || Interlocked.Exchange(ref _closed, 1) == 1) return;
        if (!Detached && ReferenceEquals(Trace.Current.Value, this)) Trace.Current.Value = Parent;
        if (Span != ScenarioState.NotRecorded) Scenario.Close(this);
    }
}

/// <summary>A test being recorded: its root span, ended (and written) on Dispose.</summary>
public sealed class TestScope : IDisposable
{
    internal static readonly TestScope None = new(null, null);

    private readonly ScenarioState? _scenario;
    private readonly Frame? _root;
    private bool _failed;

    internal TestScope(ScenarioState? scenario, Frame? root)
    {
        _scenario = scenario;
        _root = root;
        if (root is not null) Trace.Current.Value = root;
    }

    /// <summary>The test threw: an assertion, or an exception it didn't expect.</summary>
    public void Fail(Exception error) => _failed = true;

    public void Dispose()
    {
        if (_scenario is null) return;
        if (ReferenceEquals(Trace.Current.Value, _root)) Trace.Current.Value = null;
        _scenario.Registry.Finish(_scenario, _failed ? "failed" : "passed");
    }
}

/// <summary>A catalogued function, as the recorder wrote it to $RUNSHAPE_FUNCTIONS. A test has its nodeid, the name dotnet test gives it.</summary>
internal sealed record FunctionEntry(string Role, JsonElement Symbol, string File, int FirstLine, bool Constructor, string Name, string? Nodeid);

/// <summary>The functions the recorder instrumented, the project's types, and where scenarios go.</summary>
internal sealed class Registry
{
    private readonly string _directory;
    private int _written;
    private readonly Dictionary<string, int> _nodeids = new();
    internal readonly FunctionEntry[] Functions;
    internal readonly Dictionary<string, string[]> Types;
    internal readonly Limits Limits;

    private Registry(string directory, FunctionEntry[] functions, Dictionary<string, string[]> types, Limits limits)
    {
        _directory = directory;
        Functions = functions;
        Types = types;
        Limits = limits;
    }

    internal static Registry? FromEnvironment()
    {
        var directory = Environment.GetEnvironmentVariable("RUNSHAPE_RUN_DIR");
        var table = Environment.GetEnvironmentVariable("RUNSHAPE_FUNCTIONS");
        if (string.IsNullOrEmpty(directory) || string.IsNullOrEmpty(table)) return null;
        using var document = JsonDocument.Parse(File.ReadAllBytes(table));
        var functions = new List<FunctionEntry>();
        foreach (var entry in document.RootElement.GetProperty("functions").EnumerateArray())
        {
            var symbol = entry.GetProperty("symbol");
            var name = string.Join(".", symbol.GetProperty("container").EnumerateArray().Select(part => part.GetString()).Append(symbol.GetProperty("name").GetString()));
            functions.Add(new FunctionEntry(
                entry.GetProperty("role").GetString()!,
                symbol.Clone(),
                entry.GetProperty("file").GetString()!,
                entry.GetProperty("firstLine").GetInt32(),
                symbol.GetProperty("kind").GetString() == "constructor",
                name,
                entry.TryGetProperty("nodeid", out var nodeid) ? nodeid.GetString() : null));
        }
        var types = new Dictionary<string, string[]>();
        foreach (var type in document.RootElement.GetProperty("types").EnumerateObject())
        {
            types[type.Name] = type.Value.EnumerateArray().Select(part => part.GetString()!).ToArray();
        }
        return new Registry(directory, functions.ToArray(), types, Limits.Default);
    }

    internal TestScope StartScenario(int testFunction, object?[]? arguments)
    {
        var test = Functions[testFunction];
        var nodeid = test.Nodeid ?? test.Name;
        if (arguments is { Length: > 0 }) nodeid += "(" + string.Join(", ", arguments.Select(Describe)) + ")";
        lock (_nodeids)
        {
            // A theory's cases can describe alike (two objects of one type): kept apart, in run order.
            _nodeids[nodeid] = _nodeids.TryGetValue(nodeid, out var seen) ? seen + 1 : 1;
            if (_nodeids[nodeid] > 1) nodeid += $" #{_nodeids[nodeid]}";
        }
        var scenario = new ScenarioState(this, nodeid);
        return new TestScope(scenario, scenario.OpenRoot(testFunction));
    }

    /// <summary>A theory's argument as a test name shows it: values as written, anything else by its type's name.</summary>
    private static string Describe(object? value) => value switch
    {
        null => "null",
        string text => JsonSerializer.Serialize(text),
        char c => $"'{c}'",
        bool b => b ? "true" : "false",
        IFormattable number when value.GetType().IsPrimitive || value is decimal || value.GetType().IsEnum => number.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => value.GetType().Name,
    };

    internal void Finish(ScenarioState scenario, string outcome)
    {
        var file = scenario.Finish(outcome);
        var scenarios = Path.Combine(_directory, "scenarios");
        try
        {
            Directory.CreateDirectory(scenarios);
            // Named by when it ended, then by process: dotnet test runs each test project in its own.
            var name = $"{DateTime.UtcNow.Ticks:D20}-{Environment.ProcessId}-{Interlocked.Increment(ref _written):D6}.json";
            File.WriteAllBytes(Path.Combine(scenarios, name), file);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"runshape: writing {scenario.Nodeid}: {error.Message}");
        }
    }
}

/// <summary>Keep a hot loop from filling a scenario (the TypeScript and Go recorders' numbers).</summary>
internal sealed record Limits(int CallsPerCaller, int EventsPerScenario)
{
    internal static readonly Limits Default = new(50, 500_000);
}

/// <summary>One test's events, as they happen; every change under its lock (a test can run work in parallel).</summary>
internal sealed class ScenarioState
{
    internal const int NotRecorded = -1;
    internal const int RootSpan = 0;
    /// <summary>The test's flow, whatever thread each piece of it runs on: tasks hop threads, so a thread id would say nothing.</summary>
    private const int MainThread = 0;

    internal readonly Registry Registry;
    internal readonly string Nodeid;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly List<object?[]> _events = new();
    private readonly List<int> _functions = new();
    private readonly Dictionary<int, int> _localIndex = new();
    private readonly Dictionary<int, HashSet<int>> _linesBySpan = new();
    private readonly Dictionary<(int Caller, int Function), int> _calls = new();
    private readonly Dictionary<(int Caller, int Function), int> _skipped = new();
    private readonly List<(int Caller, int Function)> _skipOrder = new();
    private readonly Dictionary<int, int> _functionOfSpan = new();
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, object> _objects = new();
    private readonly Dictionary<int, object?[]> _objectEvents = new();
    private readonly HashSet<(int Object, string Attribute)> _wired = new();
    private int _nextSpan = RootSpan + 1;
    private int _nextObject = 1;
    private bool _full;
    private int _dropped;
    private bool _finished;

    internal ScenarioState(Registry registry, string nodeid)
    {
        Registry = registry;
        Nodeid = nodeid;
    }

    private long Now => _clock.ElapsedTicks * 1_000_000 / Stopwatch.Frequency;

    internal Frame OpenRoot(int testFunction)
    {
        lock (this)
        {
            _functionOfSpan[RootSpan] = testFunction;
            _events.Add(["P", 0L, "call"]);
            _events.Add(["S", 0L, RootSpan, LocalIndex(testFunction), null, MainThread, null]);
            return new Frame(this, null, RootSpan, testFunction, null);
        }
    }

    internal Frame Open(Frame parent, int function, object? self)
    {
        lock (this)
        {
            // Work a finished test left running belongs to no scenario.
            if (_finished || parent.Span == NotRecorded || !Admits(parent.Span, function)) return new Frame(this, parent, NotRecorded, function, self);
            var span = _nextSpan++;
            _functionOfSpan[span] = function;
            _events.Add(["S", Now, span, LocalIndex(function), parent.Span, MainThread, null]);
            var startEvent = _events[^1];
            startEvent[6] = ObjectId(self, function, null, wireIfNew: true);
            return new Frame(this, parent, span, function, self);
        }
    }

    internal void Line(int span, int line)
    {
        lock (this)
        {
            if (_finished || IsFull()) return;
            if (!_linesBySpan.TryGetValue(span, out var lines)) _linesBySpan[span] = lines = new HashSet<int>();
            if (lines.Add(line)) _events.Add(["L", span, line]);
        }
    }

    internal void Close(Frame frame)
    {
        lock (this)
        {
            if (_finished) return;
            if (Registry.Functions[frame.Function].Constructor && frame.Self is not null) Built(frame.Self, frame.Function, frame.Span);
            _events.Add(["X", Now, frame.Span]);
            _linesBySpan.Remove(frame.Span);
        }
    }

    /// <summary>The app called an external system from inside a recorded call (not from the test itself).</summary>
    internal void Boundary(int span, string system, string operation, string? statement)
    {
        lock (this)
        {
            if (_finished || IsFull()) return;
            _events.Add(["B", Now, span, system, operation, statement]);
        }
    }

    internal byte[] Finish(string outcome)
    {
        lock (this)
        {
            _finished = true;
            var duration = Now;
            _events.Add(["X", duration, RootSpan]);
            return ScenarioJson.Write(this, outcome, duration, _functions, _events, Omissions());
        }
    }

    private bool Admits(int parent, int function)
    {
        if (IsFull())
        {
            _dropped++;
            return false;
        }
        var key = (parent, function);
        _calls[key] = _calls.TryGetValue(key, out var calls) ? calls + 1 : 1;
        if (_calls[key] <= Registry.Limits.CallsPerCaller) return true;
        if (!_skipped.ContainsKey(key)) _skipOrder.Add(key);
        _skipped[key] = _skipped.TryGetValue(key, out var skipped) ? skipped + 1 : 1;
        return false;
    }

    private bool IsFull()
    {
        if (_events.Count >= Registry.Limits.EventsPerScenario) _full = true;
        return _full;
    }

    private int LocalIndex(int function)
    {
        if (_localIndex.TryGetValue(function, out var index)) return index;
        _localIndex[function] = _functions.Count;
        _functions.Add(function);
        return _functions.Count - 1;
    }

    /// <summary>
    /// The id of a project object, seen for the first time now if new: an instance of a type the
    /// source declares (its runtime type when that's one of them, else the method's own type).
    /// </summary>
    /// <param name="wireIfNew">
    /// An object first seen in one of its methods was built outside any recorded call (in a
    /// test's constructor, or by a primary constructor, which has no body to instrument): its
    /// fields then are the closest thing to its wiring, so they're read now.
    /// </param>
    private object? ObjectId(object? value, int function, int? builtBy, bool wireIfNew = false)
    {
        if (value is null) return null;
        if (_objects.TryGetValue(value, out var known)) return known;
        var type = TypeOf(value, function);
        if (type is null || IsFull()) return null;
        var id = _nextObject++;
        _objects.Add(value, id);
        object?[] seen = ["O", Now, id, type, builtBy];
        _objectEvents[id] = seen;
        _events.Add(seen);
        if (wireIfNew) Wire(value, id);
        return id;
    }

    private string[]? TypeOf(object value, int function)
    {
        var runtime = value.GetType();
        if (runtime.IsGenericType) runtime = runtime.GetGenericTypeDefinition();
        if (runtime.FullName is { } name && Registry.Types.TryGetValue(name, out var segments)) return segments;
        if (function < 0) return null;
        var symbol = Registry.Functions[function].Symbol;
        if (symbol.GetProperty("ownerType").ValueKind != JsonValueKind.String) return null;
        return symbol.GetProperty("namespace").EnumerateArray().Concat(symbol.GetProperty("container").EnumerateArray()).Select(part => part.GetString()!).ToArray();
    }

    /// <summary>A constructor finished: the object exists, and its fields say what it was wired to.</summary>
    private void Built(object self, int function, int span)
    {
        if (ObjectId(self, function, span) is not int id) return;
        // A base class's constructor finishes first; the most-derived one, last, built the object.
        _objectEvents[id][4] = span;
        Wire(self, id);
    }

    /// <summary>What an object's fields refer to among the project's objects: "W" events, once per field.</summary>
    private void Wire(object self, int id)
    {
        // Fields only: reading a property would run the app's code, outside any span.
        for (var type = self.GetType(); type is not null && type != typeof(object); type = type.BaseType)
        {
            foreach (var field in type.GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.DeclaredOnly))
            {
                if (field.FieldType.IsValueType) continue;
                var value = field.GetValue(self);
                if (value is null || ObjectId(value, -1, null, wireIfNew: true) is not int target) continue;
                var attribute = AttributeName(field.Name);
                if (!_wired.Add((id, attribute)) || IsFull()) continue;
                _events.Add(["W", Now, id, attribute, target]);
            }
        }
    }

    /// <summary>The name the source gave a field: an auto-property's backing field is the property, a primary constructor's capture is the parameter.</summary>
    private static string AttributeName(string field)
    {
        if (field.StartsWith('<') && field.IndexOf('>') is > 1 and var end) return field[1..end];
        return field;
    }

    private string[] Omissions()
    {
        var notes = new List<string>();
        string NameOfSpan(int span) => Registry.Functions[_functionOfSpan[span]].Name;
        foreach (var key in _skipOrder)
        {
            notes.Add($"{_skipped[key]} more calls of {Registry.Functions[key.Function].Name} from {NameOfSpan(key.Caller)} were not recorded (limit {Registry.Limits.CallsPerCaller} per caller)");
        }
        if (_full) notes.Add($"stopped recording after {Registry.Limits.EventsPerScenario} events: {_dropped} later calls were not recorded");
        return notes.ToArray();
    }
}
