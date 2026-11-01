// Calls to external systems, as the libraries making them announce them on DiagnosticListener:
// Entity Framework Core's commands (any provider: SQLite, Postgres, SQL Server...), SqlClient's
// commands, and HttpClient's requests. Each is a "B" event under the app's call that made it.
// Plain ADO.NET over a provider that announces nothing (Microsoft.Data.Sqlite, Npgsql without
// EF) isn't seen: docs/design.md lists it.
//
// What's kept is the statement only: SQL text as the command holds it (EF and SqlClient send
// parameters separately; they're never read) and a URL without its query string.
using System.Data.Common;
using System.Diagnostics;

namespace Runshape.Runtime;

internal static class Boundaries
{
    private const string EntityFramework = "Microsoft.EntityFrameworkCore";
    private const string EntityFrameworkCommand = "Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting";
    private static readonly HashSet<string> SqlClients = ["SqlClientDiagnosticListener", "Microsoft.Data.SqlClient"];
    private static readonly HashSet<string> SqlClientCommands = ["Microsoft.Data.SqlClient.WriteCommandBefore", "System.Data.SqlClient.WriteCommandBefore"];
    private const string HttpClient = "HttpHandlerDiagnosticListener";
    private const string HttpRequest = "System.Net.Http.Request";

    private static int _listening;

    /// <summary>Subscribes once, when the first test starts: listeners made earlier are announced too.</summary>
    internal static void Listen()
    {
        if (Interlocked.Exchange(ref _listening, 1) == 1) return;
        DiagnosticListener.AllListeners.Subscribe(new Observer<DiagnosticListener>(listener =>
        {
            if (listener.Name == EntityFramework) listener.Subscribe(new Observer<KeyValuePair<string, object?>>(OnEntityFramework), name => name == EntityFrameworkCommand);
            else if (SqlClients.Contains(listener.Name)) listener.Subscribe(new Observer<KeyValuePair<string, object?>>(OnSqlClient), name => SqlClientCommands.Contains(name));
            else if (listener.Name == HttpClient) listener.Subscribe(new Observer<KeyValuePair<string, object?>>(OnHttp), name => name == HttpRequest);
        }));
    }

    private static void OnEntityFramework(KeyValuePair<string, object?> e)
    {
        if (e.Key != EntityFrameworkCommand || e.Value is null) return;
        if (Property(e.Value, "Command") is not DbCommand command) return;
        var method = Property(e.Value, "ExecuteMethod")?.ToString() ?? "Execute";
        Record(SystemOf(command), $"{command.GetType().Name}.{method}", command.CommandText);
    }

    private static void OnSqlClient(KeyValuePair<string, object?> e)
    {
        if (!SqlClientCommands.Contains(e.Key) || e.Value is null) return;
        if (Property(e.Value, "Command") is not DbCommand command) return;
        var operation = Property(e.Value, "Operation")?.ToString() ?? "Execute";
        Record(SystemOf(command), $"{command.GetType().Name}.{operation}", command.CommandText);
    }

    private static void OnHttp(KeyValuePair<string, object?> e)
    {
        if (e.Key != HttpRequest || e.Value is null) return;
        if (Property(e.Value, "Request") is not HttpRequestMessage request || request.RequestUri is null) return;
        var uri = request.RequestUri;
        var withoutQuery = uri.IsAbsoluteUri ? uri.GetLeftPart(UriPartial.Path) : uri.OriginalString.Split('?')[0];
        Record("http", "HttpClient.Send", $"{request.Method} {withoutQuery}");
    }

    /// <summary>Under the app's innermost recorded call; the test's own setup and assertions aren't the app's doing.</summary>
    private static void Record(string system, string operation, string? statement)
    {
        var frame = Trace.Current.Value;
        while (frame is not null && frame.Span == ScenarioState.NotRecorded) frame = frame.Parent;
        if (frame?.Scenario is null || frame.Span == ScenarioState.RootSpan) return;
        frame.Scenario.Boundary(frame.Span, system, operation, statement);
    }

    /// <summary>The database a command talks to, by its provider's command type.</summary>
    internal static string SystemOf(DbCommand command) => command.GetType().Name switch
    {
        "SqliteCommand" => "sqlite",
        "NpgsqlCommand" => "postgres",
        "SqlCommand" => "sqlserver",
        "MySqlCommand" => "mysql",
        "OracleCommand" => "oracle",
        var other => other.EndsWith("Command", StringComparison.Ordinal) ? other[..^"Command".Length].ToLowerInvariant() : other.ToLowerInvariant(),
    };

    /// <summary>A payload's property: the payloads are each library's own types, read by name.</summary>
    private static object? Property(object payload, string name)
    {
        try
        {
            return payload.GetType().GetProperty(name)?.GetValue(payload);
        }
        catch
        {
            return null;
        }
    }

    private sealed class Observer<T>(Action<T> next) : IObserver<T>
    {
        public void OnCompleted() { }
        public void OnError(Exception error) { }
        public void OnNext(T value)
        {
            // The app's call is in progress: a recorder failure must never become the app's.
            try
            {
                next(value);
            }
            catch
            {
            }
        }
    }
}
