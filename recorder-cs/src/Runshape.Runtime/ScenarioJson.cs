// A finished scenario as trace format version 2's scenarios/NNNN.json (docs/trace-format.md).
using System.Text.Json;

namespace Runshape.Runtime;

internal static class ScenarioJson
{
    internal static byte[] Write(ScenarioState scenario, string outcome, long durationUs, List<int> functions, List<object?[]> events, string[] recorderErrors)
    {
        var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteString("nodeid", scenario.Nodeid);
            json.WriteString("outcome", outcome);
            json.WriteNumber("durationUs", durationUs);
            json.WriteStartArray("functions");
            foreach (var id in functions)
            {
                var entry = scenario.Registry.Functions[id];
                json.WriteStartObject();
                json.WriteString("role", entry.Role);
                json.WritePropertyName("symbol");
                entry.Symbol.WriteTo(json);
                json.WriteString("file", entry.File);
                json.WriteNumber("firstLine", entry.FirstLine);
                json.WriteNull("landmarkKind");
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteStartArray("events");
            foreach (var e in events) WriteValue(json, e);
            json.WriteEndArray();
            json.WriteStartArray("recorderErrors");
            foreach (var error in recorderErrors) json.WriteStringValue(error);
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    private static void WriteValue(Utf8JsonWriter json, object? value)
    {
        switch (value)
        {
            case null: json.WriteNullValue(); break;
            case string text: json.WriteStringValue(text); break;
            case int number: json.WriteNumberValue(number); break;
            case long number: json.WriteNumberValue(number); break;
            case string[] segments:
                json.WriteStartArray();
                foreach (var segment in segments) json.WriteStringValue(segment);
                json.WriteEndArray();
                break;
            case object?[] items:
                json.WriteStartArray();
                foreach (var item in items) WriteValue(json, item);
                json.WriteEndArray();
                break;
            default: throw new InvalidOperationException($"runshape: no JSON for {value.GetType()}");
        }
    }
}
