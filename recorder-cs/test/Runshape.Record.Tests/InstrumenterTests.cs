// What the rewrite does to C# source, shown on the source itself: each test instruments a
// snippet, compiles the result against the runtime (so a rewrite that breaks the code fails
// here, not in someone's build), and shows the rewritten text or the catalog it describes.
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Runshape.Record.Tests;

public class InstrumenterTests
{
    [Fact]
    public void A_method_opens_a_frame_and_marks_each_statement_on_its_own_line()
    {
        var source = """
            namespace Shop.Domain;

            public class Order
            {
                public int Total(int[] prices)
                {
                    var total = 0;
                    foreach (var price in prices)
                        total += price;
                    return total;
                }
            }
            """;
        var result = Instrumenter.Instrument("src/Order.cs", source, firstId: 7);

        Assert.Equal("""
            namespace Shop.Domain;

            public class Order
            {
                public int Total(int[] prices)
                { using var __rsF = global::Runshape.Runtime.Trace.Enter(7, this);
                    __rsF.Line(7); var total = 0;
                    __rsF.Line(8); foreach (var price in prices)
                        { __rsF.Line(9); total += price; }
                    __rsF.Line(10); return total;
                }
            }
            """, result.Code);
        var total = Assert.Single(result.Functions);
        Assert.Equal(("Total", "method", "Order"), (total.Symbol.Name, total.Symbol.Kind, total.Symbol.OwnerType));
        Assert.Equal(["Shop", "Domain"], total.Symbol.Namespace);
        Assert.Equal(["Order"], total.Symbol.Container);
        Assert.Equal((5, 11), (total.FirstLine, total.LastLine));
        Assert.Equal([7, 8, 9, 10], total.Lines);
        Assert.Equal(["Shop", "Domain", "Order"], result.Types["Shop.Domain.Order"]);
        Compiles(result.Code);
    }

    [Fact]
    public void Expression_bodies_become_blocks_on_the_same_line()
    {
        var source = """
            using System.Collections.Generic;
            namespace Shop;
            public class Cart
            {
                private readonly List<int> _items = new();
                public int Count => _items.Count;
                public void Add(int item) => _items.Add(item);
                public int this[int index] => _items[index];
                public int Last { get => _items[^1]; set => _items[^1] = value; }
                public void Fail() => throw new System.InvalidOperationException();
                public async System.Threading.Tasks.Task Wait() => await System.Threading.Tasks.Task.Yield();
                public static Cart operator +(Cart cart, int item) { cart.Add(item); return cart; }
                public static implicit operator int(Cart cart) => cart.Count;
            }
            """;
        var result = Instrumenter.Instrument("Cart.cs", source, firstId: 0);

        Assert.Equal(
            ["get_Count", "Add", "get_Item", "get_Last", "set_Last", "Fail", "Wait", "operator +", "implicit operator int"],
            result.Functions.Select(f => f.Symbol.Name));
        Assert.Contains("public int Count { get { using var __rsF = global::Runshape.Runtime.Trace.Enter(0, this); __rsF.Line(6); return _items.Count; } }", result.Code);
        Assert.Contains("public void Add(int item) { using var __rsF = global::Runshape.Runtime.Trace.Enter(1, this); __rsF.Line(7); _items.Add(item); }", result.Code);
        Assert.Contains("public void Fail() { using var __rsF = global::Runshape.Runtime.Trace.Enter(5, this); __rsF.Line(10); throw new System.InvalidOperationException(); }", result.Code);
        Assert.Contains("operator +(Cart cart, int item) { using var __rsF = global::Runshape.Runtime.Trace.Enter(7, null);", result.Code);
        Assert.Equal(source.Split('\n').Length, result.Code.Split('\n').Length);
        Compiles(result.Code);
    }

    [Fact]
    public void Overloads_are_told_apart_by_their_parameters_constructors_and_nesting_by_their_kind_and_container()
    {
        var source = """
            namespace Shop;
            public class Box<T>
            {
                static Box() { }
                public Box(T value) { Value = value; }
                public T Value { get; }
                public void Put(T value) { }
                public void Put(T value, int times) { }
                public class Lid { public void Close() { } }
            }
            public struct Point { public int X; public int Length() { return X; } }
            """;
        var result = Instrumenter.Instrument("Box.cs", source, firstId: 0);

        Assert.Equal(
            ["Box<T>.static constructor initializer", "Box<T>.constructor constructor", "Box<T>.Put(T) method", "Box<T>.Put(T, int) method", "Box<T>.Lid.Close method", "Point.Length method"],
            result.Functions.Select(f => $"{string.Join(".", f.Symbol.Container)}.{f.Symbol.Name} {f.Symbol.Kind}"));
        Assert.Equal(["Shop", "Box<T>", "Lid"], result.Types["Shop.Box`1+Lid"]);
        // A static constructor and a struct's method have no receiver worth naming: a struct's `this` is a copy.
        Assert.Contains("static Box() { using var __rsF = global::Runshape.Runtime.Trace.Enter(0, null); }", result.Code);
        Assert.Contains("public int Length() { using var __rsF = global::Runshape.Runtime.Trace.Enter(5, null);", result.Code);
        Compiles(result.Code);
    }

    [Fact]
    public void Lambdas_and_local_functions_mark_lines_through_their_method_and_iterators_never_become_the_callers_call()
    {
        var source = """
            using System;
            using System.Collections.Generic;
            using System.Linq;
            namespace Shop;
            public class Report
            {
                public int Sum(IEnumerable<int> values)
                {
                    int Twice(int x) { return x * 2; }
                    var total = values.Select(v => { return Twice(v); }).Sum();
                    Func<int, int> pure = static x => { return x; };
                    if (total > 10) if (total > 20) return 20; else return 15;
                    switch (total) { case 1: return 1; default: break; }
                    return total;
                }
                public IEnumerable<int> Evens(int upTo)
                {
                    for (var i = 0; i < upTo; i += 2) yield return i;
                }
            }
            """;
        var result = Instrumenter.Instrument("Report.cs", source, firstId: 0);

        Assert.Equal([9, 10, 11, 12, 13, 14], result.Functions[0].Lines);
        Assert.Contains("int Twice(int x) { __rsF.Line(9); return x * 2; }", result.Code);
        Assert.Contains("static x => { return x; }", result.Code);
        Assert.Contains("if (total > 10) { __rsF.Line(12); if (total > 20) { __rsF.Line(12); return 20; } else { __rsF.Line(12); return 15; } }", result.Code);
        Assert.Contains("case 1: __rsF.Line(13); return 1; default: __rsF.Line(13); break;", result.Code);
        Assert.Contains("Trace.EnterIterator(1, this);", result.Code);
        Compiles(result.Code);
    }

    [Fact]
    public void A_test_method_is_a_scenario_that_fails_when_it_throws()
    {
        var source = """
            namespace Shop.Tests;
            public class FactAttribute : System.Attribute { }
            public class TheoryAttribute : System.Attribute { }
            public class CartTests
            {
                [Fact]
                public void Adds() { var x = 1; }

                [Theory]
                public System.Threading.Tasks.Task Counts(int n, string label) => System.Threading.Tasks.Task.CompletedTask;

                public void Helper() { }
            }
            """;
        var result = Instrumenter.InstrumentTests("tests/CartTests.cs", source, firstId: 3);

        Assert.Equal(["Shop.Tests.CartTests.Adds", "Shop.Tests.CartTests.Counts"], result.Tests.Select(t => t.Nodeid));
        Assert.Equal([7, 10], result.Tests.Select(t => t.FirstLine));
        Assert.Contains(
            "public void Adds() { var __rsS = global::Runshape.Runtime.Trace.Scenario(3, null); try { var x = 1; } catch (global::System.Exception __rsE) { __rsS.Fail(__rsE); throw; } finally { __rsS.Dispose(); } }",
            result.Code);
        Assert.Contains("Trace.Scenario(4, new object[] { @n, @label }); try { return System.Threading.Tasks.Task.CompletedTask;", result.Code);
        Assert.Contains("public void Helper() { }", result.Code);
        Compiles(result.Code);
    }

    /// <summary>The rewritten code compiles against the runtime: the rewrite never breaks a build.</summary>
    private static void Compiles(string code)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(typeof(Runshape.Runtime.Trace).Assembly.Location));
        var compilation = CSharpCompilation.Create(
            "Probe",
            [CSharpSyntaxTree.ParseText(code, new CSharpParseOptions(LanguageVersion.Preview))],
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString()).ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors) + "\n" + code);
    }
}
