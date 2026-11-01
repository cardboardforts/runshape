// Rewrites C# source so its methods report to the runtime (Runshape.Runtime.Trace): each method,
// constructor, accessor and operator opens a frame on entry (a `using` declaration, so it closes
// however the body ends) and each statement marks its line through that frame. Every insertion
// stays on the line it belongs to, so recorded line numbers, and exceptions' stack traces, are
// the source's own.
//
// Lambdas and local functions aren't frames of their own: their lines are marked through the
// frame of the method that wrote them (as in the Go recorder). Parsing only, no compilation: the
// rewrite needs no references, so it never restores or builds anything to read the code.
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Runshape.Record;

/// <summary>Trace format v2's name for a function (docs/trace-format.md).</summary>
public sealed record Symbol(string[] Namespace, string[] Container, string Name, string Kind, string? OwnerType);

/// <summary>A catalog entry: a function an instrumented file defines.</summary>
public sealed record CatalogEntry(string File, Symbol Symbol, int FirstLine, int LastLine, int[] Lines);

/// <summary>A test method: a scenario's root.</summary>
public sealed record TestEntry(string File, Symbol Symbol, int FirstLine, string Nodeid);

public sealed record InstrumentedSource(string Code, List<CatalogEntry> Functions, Dictionary<string, string[]> Types);

public sealed record InstrumentedTests(string Code, List<TestEntry> Tests);

public static class Instrumenter
{
    private const string Runtime = "global::Runshape.Runtime.Trace";
    private const string FrameVariable = "__rsF";
    private const string ScenarioVariable = "__rsS";

    /// <summary>
    /// The symbols #if sees: a Debug build's, on any .NET from 5 on. A method only inside a branch
    /// these don't take is copied as written, uninstrumented.
    /// </summary>
    private static readonly CSharpParseOptions Parsing = new(
        LanguageVersion.Preview,
        preprocessorSymbols: ["DEBUG", "TRACE", "NET", "NETCOREAPP", .. Enumerable.Range(5, 6).Select(major => $"NET{major}_0_OR_GREATER")]);

    /// <summary>Attribute names that make a method a test: xUnit's, NUnit's and MSTest's.</summary>
    private static readonly HashSet<string> TestAttributes = ["Fact", "Theory", "Test", "TestCase", "TestCaseSource", "TestMethod", "DataTestMethod", "SkippableFact", "SkippableTheory"];

    /// <summary>
    /// Instruments one file of a project that isn't a test project. <paramref name="file"/> is its
    /// path relative to the project root ("/"-separated); functions get ids from
    /// <paramref name="firstId"/> on, in catalog order.
    /// </summary>
    public static InstrumentedSource Instrument(string file, string source, int firstId)
    {
        var root = CSharpSyntaxTree.ParseText(source, Parsing).GetCompilationUnitRoot();
        var edits = new List<Edit>();
        var functions = new List<CatalogEntry>();
        var types = new Dictionary<string, string[]>();
        foreach (var type in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            // A C# 14 extension block names no type of its own: its members are left as written.
            if (type.Identifier.ValueText == "") continue;
            var place = Place.Of(type, file);
            types[place.ClrName] = [.. place.Namespace, .. place.Container];
            if (type is not TypeDeclarationSyntax declared) continue;
            var members = declared.Members.Select(member => Function.Of(member, place)).Where(found => found is not null).SelectMany(found => found!).ToList();
            var overloaded = members.GroupBy(member => member.Name).Where(group => group.Count() > 1).Select(group => group.Key).ToHashSet();
            foreach (var member in members)
            {
                var name = overloaded.Contains(member.Name) ? $"{member.Name}({member.Parameters})" : member.Name;
                var symbol = new Symbol(place.Namespace, place.Container, name, member.Kind, place.Container[^1]);
                var id = firstId + functions.Count;
                var lines = member.Rewrite(edits, id, root.SyntaxTree);
                functions.Add(new CatalogEntry(file, symbol, LineOf(member.Start), LineOf(member.Node.Span.End), lines));
            }
        }
        return new InstrumentedSource(Apply(source, edits), functions, types);

        int LineOf(int position) => root.SyntaxTree.GetLineSpan(new Microsoft.CodeAnalysis.Text.TextSpan(position, 0)).StartLinePosition.Line + 1;
    }

    /// <summary>Makes each test method (by its attribute) in a test project's file a scenario.</summary>
    public static InstrumentedTests InstrumentTests(string file, string source, int firstId)
    {
        var root = CSharpSyntaxTree.ParseText(source, Parsing).GetCompilationUnitRoot();
        var edits = new List<Edit>();
        var tests = new List<TestEntry>();
        foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            if (!IsTest(method) || method.Parent is not TypeDeclarationSyntax type || (method.Body is null && method.ExpressionBody is null)) continue;
            var place = Place.Of(type, file);
            var id = firstId + tests.Count;
            var arguments = TestArguments(method);
            var open = $" var {ScenarioVariable} = {Runtime}.Scenario({id}, {arguments}); try {{";
            var close = $"}} catch (global::System.Exception __rsE) {{ {ScenarioVariable}.Fail(__rsE); throw; }} finally {{ {ScenarioVariable}.Dispose(); }}";
            if (method.Body is { } body)
            {
                edits.Add(Edit.Insert(body.OpenBraceToken.Span.End, open));
                edits.Add(Edit.Insert(body.CloseBraceToken.SpanStart, close + " "));
            }
            else
            {
                var expression = method.ExpressionBody!;
                var statement = ReturnsNothing(method) || expression.Expression is ThrowExpressionSyntax ? "" : " return";
                var gap = expression.ArrowToken.TrailingTrivia.Count > 0 ? "" : " ";
                edits.Add(new Edit(expression.ArrowToken.SpanStart, expression.ArrowToken.Span.Length, "{" + open + statement + gap, 0));
                edits.Add(new Edit(method.SemicolonToken.SpanStart, method.SemicolonToken.Span.Length, "; " + close + " }", 0));
            }
            var symbol = new Symbol(place.Namespace, place.Container, method.Identifier.ValueText, "method", place.Container[^1]);
            var line = root.SyntaxTree.GetLineSpan(new Microsoft.CodeAnalysis.Text.TextSpan(StartOf(method), 0)).StartLinePosition.Line + 1;
            tests.Add(new TestEntry(file, symbol, line, string.Join(".", [.. place.Namespace, .. place.Container, method.Identifier.ValueText])));
        }
        return new InstrumentedTests(Apply(source, edits), tests);
    }

    private static bool IsTest(MethodDeclarationSyntax method)
    {
        foreach (var attribute in method.AttributeLists.SelectMany(list => list.Attributes))
        {
            var name = attribute.Name switch
            {
                QualifiedNameSyntax qualified => qualified.Right.Identifier.ValueText,
                AliasQualifiedNameSyntax alias => alias.Name.Identifier.ValueText,
                SimpleNameSyntax simple => simple.Identifier.ValueText,
                _ => "",
            };
            if (name.EndsWith("Attribute", StringComparison.Ordinal)) name = name[..^"Attribute".Length];
            if (TestAttributes.Contains(name)) return true;
        }
        return false;
    }

    /// <summary>A theory's arguments, which tell its cases apart; none when one can't be boxed (ref, out, params).</summary>
    private static string TestArguments(MethodDeclarationSyntax method)
    {
        var parameters = method.ParameterList.Parameters;
        if (parameters.Count == 0 || parameters.Any(parameter => parameter.Modifiers.Count > 0)) return "null";
        return "new object[] { " + string.Join(", ", parameters.Select(parameter => "@" + parameter.Identifier.ValueText)) + " }";
    }

    /// <summary>Where a declaration starts, past its attributes: the line a reader looks for.</summary>
    internal static int StartOf(SyntaxNode node)
    {
        var attributes = node switch
        {
            MemberDeclarationSyntax member => member.AttributeLists,
            AccessorDeclarationSyntax accessor => accessor.AttributeLists,
            _ => default,
        };
        return attributes.Count == 0 ? node.SpanStart : attributes[^1].GetLastToken().GetNextToken().SpanStart;
    }

    /// <summary>A method whose expression body is a statement, not a value: void, or an async Task.</summary>
    private static bool ReturnsNothing(MethodDeclarationSyntax method)
    {
        if (method.ReturnType is PredefinedTypeSyntax { Keyword.RawKind: (int)SyntaxKind.VoidKeyword }) return true;
        if (!method.Modifiers.Any(SyntaxKind.AsyncKeyword)) return false;
        var name = method.ReturnType switch
        {
            QualifiedNameSyntax qualified => qualified.Right,
            AliasQualifiedNameSyntax alias => alias.Name,
            SimpleNameSyntax simple => simple,
            _ => null,
        };
        return name is IdentifierNameSyntax { Identifier.ValueText: "Task" or "ValueTask" };
    }

    private static string Apply(string source, List<Edit> edits)
    {
        var ordered = edits.Select((edit, index) => (edit, index)).OrderBy(pair => pair.edit.At).ThenBy(pair => pair.edit.Order).ThenBy(pair => pair.index).Select(pair => pair.edit);
        var output = new System.Text.StringBuilder(source.Length + edits.Count * 24);
        var from = 0;
        foreach (var edit in ordered)
        {
            output.Append(source, from, edit.At - from).Append(edit.Text);
            from = edit.At + edit.Length;
        }
        return output.Append(source, from, source.Length - from).ToString();
    }

    /// <summary>A replacement of <c>Length</c> characters at <c>At</c>; ties at one position go by <c>Order</c>, then as added.</summary>
    internal sealed record Edit(int At, int Length, string Text, int Order)
    {
        internal static Edit Insert(int at, string text, int order = 0) => new(at, 0, text, order);
    }

    /// <summary>Where a type is: its namespace's segments, the types it's nested in, and the name the CLR gives it.</summary>
    private sealed record Place(string[] Namespace, string[] Container, string ClrName, bool IsStruct)
    {
        internal static Place Of(BaseTypeDeclarationSyntax type, string file)
        {
            var types = type.AncestorsAndSelf().OfType<BaseTypeDeclarationSyntax>().Reverse().ToList();
            var namespaces = type.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().Reverse().SelectMany(ns => ns.Name.ToString().Split('.', StringSplitOptions.TrimEntries)).ToArray();
            var container = types.Select(DisplayName).ToArray();
            var clr = string.Join("+", types.Select(ClrNameOf));
            if (namespaces.Length > 0) clr = string.Join(".", namespaces) + "." + clr;
            // The global namespace: the file's path stands in, as the TypeScript recorder's module does.
            var namespaceSegments = namespaces.Length > 0 ? namespaces : file[..^".cs".Length].Split('/');
            var isStruct = type is StructDeclarationSyntax || type is RecordDeclarationSyntax record && record.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword);
            return new Place(namespaceSegments, container, clr, isStruct);
        }

        private static string DisplayName(BaseTypeDeclarationSyntax type) =>
            type is TypeDeclarationSyntax { TypeParameterList: { } parameters } ? $"{type.Identifier.ValueText}<{string.Join(", ", parameters.Parameters.Select(p => p.Identifier.ValueText))}>" : type.Identifier.ValueText;

        private static string ClrNameOf(BaseTypeDeclarationSyntax type) =>
            type is TypeDeclarationSyntax { TypeParameterList: { } parameters } ? $"{type.Identifier.ValueText}`{parameters.Parameters.Count}" : type.Identifier.ValueText;
    }

    /// <summary>A member with code to run: what it's called, and how to rewrite it.</summary>
    private sealed class Function
    {
        internal required SyntaxNode Node { get; init; }
        internal required string Name { get; init; }
        internal required string Kind { get; init; }
        internal required string Parameters { get; init; }
        internal required int Start { get; init; }
        internal BlockSyntax? Body { get; init; }
        internal ArrowExpressionClauseSyntax? Arrow { get; init; }
        internal SyntaxToken Semicolon { get; init; }
        /// <summary>Whether an expression body is a statement (a setter, a void method), not a value to return.</summary>
        internal bool ReturnsNothing { get; init; }
        /// <summary>A property's or an indexer's `=> value`: a block there would be its accessor list, so it becomes `{ get { ... } }`.</summary>
        internal bool GetterOnly { get; init; }
        internal required bool IsStatic { get; init; }
        internal required Place Place { get; init; }

        internal static IEnumerable<Function>? Of(MemberDeclarationSyntax member, Place place)
        {
            var isStatic = member.Modifiers.Any(SyntaxKind.StaticKeyword) || member.Modifiers.Any(SyntaxKind.ConstKeyword);
            switch (member)
            {
                case MethodDeclarationSyntax method when method.Body is not null || method.ExpressionBody is not null:
                    return [new Function
                    {
                        Node = method, Name = method.Identifier.ValueText, Kind = "method", Parameters = ParametersOf(method.ParameterList),
                        Start = StartOf(method), Body = method.Body, Arrow = method.ExpressionBody, Semicolon = method.SemicolonToken,
                        ReturnsNothing = Instrumenter.ReturnsNothing(method), IsStatic = isStatic, Place = place,
                    }];
                case ConstructorDeclarationSyntax constructor when constructor.Body is not null || constructor.ExpressionBody is not null:
                    return [new Function
                    {
                        Node = constructor, Name = isStatic ? "static constructor" : "constructor", Kind = isStatic ? "initializer" : "constructor",
                        Parameters = ParametersOf(constructor.ParameterList), Start = StartOf(constructor), Body = constructor.Body,
                        Arrow = constructor.ExpressionBody, Semicolon = constructor.SemicolonToken, ReturnsNothing = true, IsStatic = isStatic, Place = place,
                    }];
                case OperatorDeclarationSyntax op when op.Body is not null || op.ExpressionBody is not null:
                    return [new Function
                    {
                        Node = op, Name = $"operator {op.OperatorToken.ValueText}", Kind = "method", Parameters = ParametersOf(op.ParameterList),
                        Start = StartOf(op), Body = op.Body, Arrow = op.ExpressionBody, Semicolon = op.SemicolonToken, IsStatic = true, Place = place,
                    }];
                case ConversionOperatorDeclarationSyntax conversion when conversion.Body is not null || conversion.ExpressionBody is not null:
                    return [new Function
                    {
                        Node = conversion, Name = $"{conversion.ImplicitOrExplicitKeyword.ValueText} operator {conversion.Type}", Kind = "method",
                        Parameters = ParametersOf(conversion.ParameterList), Start = StartOf(conversion), Body = conversion.Body,
                        Arrow = conversion.ExpressionBody, Semicolon = conversion.SemicolonToken, IsStatic = true, Place = place,
                    }];
                case PropertyDeclarationSyntax { ExpressionBody: { } arrow } property:
                    return [new Function
                    {
                        Node = property, Name = $"get_{property.Identifier.ValueText}", Kind = "method", Parameters = "",
                        Start = StartOf(property), Arrow = arrow, Semicolon = property.SemicolonToken, GetterOnly = true, IsStatic = isStatic, Place = place,
                    }];
                case IndexerDeclarationSyntax { ExpressionBody: { } arrow } indexer:
                    return [new Function
                    {
                        Node = indexer, Name = "get_Item", Kind = "method", Parameters = ParametersOf(indexer.ParameterList),
                        Start = StartOf(indexer), Arrow = arrow, Semicolon = indexer.SemicolonToken, GetterOnly = true, IsStatic = false, Place = place,
                    }];
                case BasePropertyDeclarationSyntax { AccessorList: { } accessors } property:
                    var owner = property switch
                    {
                        PropertyDeclarationSyntax p => p.Identifier.ValueText,
                        EventDeclarationSyntax e => e.Identifier.ValueText,
                        _ => "Item",
                    };
                    var parameters = property is IndexerDeclarationSyntax withIndex ? ParametersOf(withIndex.ParameterList) : "";
                    return accessors.Accessors.Where(accessor => accessor.Body is not null || accessor.ExpressionBody is not null).Select(accessor => new Function
                    {
                        Node = accessor, Name = $"{accessor.Keyword.ValueText}_{owner}", Kind = "method", Parameters = parameters,
                        Start = StartOf(accessor), Body = accessor.Body, Arrow = accessor.ExpressionBody, Semicolon = accessor.SemicolonToken,
                        ReturnsNothing = !accessor.Keyword.IsKind(SyntaxKind.GetKeyword), IsStatic = isStatic, Place = place,
                    }).ToList();
                default:
                    return null;
            }
        }

        private static string ParametersOf(BaseParameterListSyntax list) =>
            string.Join(", ", list.Parameters.Select(parameter => string.Join(" ", parameter.Modifiers.Select(m => m.ValueText).Append(parameter.Type?.ToString() ?? "")).Trim()));

        /// <summary>
        /// Adds this function's edits; returns the lines it marks. The receiver is passed only for
        /// a class's instance code: a struct's `this` would be a copy, and a static has none.
        /// </summary>
        internal int[] Rewrite(List<Edit> edits, int id, SyntaxTree tree)
        {
            var self = IsStatic || Place.IsStruct ? "null" : "this";
            var enter = Body is not null && IsIterator(Body) ? "EnterIterator" : "Enter";
            var open = $"using var {FrameVariable} = {Runtime}.{enter}({id}, {self});";
            var lines = new SortedSet<int>();
            int LineOf(int position) => tree.GetLineSpan(new Microsoft.CodeAnalysis.Text.TextSpan(position, 0)).StartLinePosition.Line + 1;
            if (Body is not null)
            {
                edits.Add(Edit.Insert(Body.OpenBraceToken.Span.End, " " + open));
                MarkLines(Body, edits, lines, LineOf);
            }
            else
            {
                var expression = Arrow!.Expression;
                var line = LineOf(expression.SpanStart);
                lines.Add(line);
                var statement = ReturnsNothing || expression is ThrowExpressionSyntax ? "" : " return";
                // The space after `=>` stays, and separates what's added from the expression.
                var gap = Arrow.ArrowToken.TrailingTrivia.Count > 0 ? "" : " ";
                var (before, after) = GetterOnly ? ("{ get { ", "; } }") : ("{ ", "; }");
                edits.Add(new Edit(Arrow.ArrowToken.SpanStart, Arrow.ArrowToken.Span.Length, $"{before}{open} {FrameVariable}.Line({line});{statement}{gap}", 0));
                edits.Add(new Edit(Semicolon.SpanStart, Semicolon.Span.Length, after, 0));
                // Lambdas inside an expression body (a LINQ query's) mark their lines too.
                MarkLines(expression, edits, lines, LineOf);
            }
            return [.. lines];
        }

        /// <summary>Whether the body yields: it runs a piece at a time, in whoever calls MoveNext.</summary>
        private static bool IsIterator(BlockSyntax body) =>
            body.DescendantNodes(node => node is not (LambdaExpressionSyntax or AnonymousMethodExpressionSyntax or LocalFunctionStatementSyntax)).OfType<YieldStatementSyntax>().Any();
    }

    /// <summary>
    /// A line mark before every statement under <paramref name="node"/>, lambdas' and local
    /// functions' included, except a static one's (it can't see the frame). A statement that is
    /// an if's or a loop's whole body is braced, so the mark and it stay one statement.
    /// </summary>
    private static void MarkLines(SyntaxNode node, List<Edit> edits, SortedSet<int> lines, Func<int, int> lineOf)
    {
        var statements = node.DescendantNodes(descend => !IsStatic(descend)).OfType<StatementSyntax>();
        foreach (var statement in statements)
        {
            if (statement is BlockSyntax or EmptyStatementSyntax or LocalFunctionStatementSyntax) continue;
            if (statement.Parent is LabeledStatementSyntax) continue;
            var line = lineOf(statement.SpanStart);
            var mark = $"{FrameVariable}.Line({line}); ";
            switch (statement.Parent)
            {
                case BlockSyntax:
                case SwitchSectionSyntax:
                    edits.Add(Edit.Insert(statement.SpanStart, mark, order: 1));
                    break;
                case IfStatementSyntax or ElseClauseSyntax or WhileStatementSyntax or DoStatementSyntax or ForStatementSyntax
                    or CommonForEachStatementSyntax or UsingStatementSyntax or LockStatementSyntax or FixedStatementSyntax:
                    edits.Add(Edit.Insert(statement.SpanStart, "{ " + mark, order: 1));
                    // Before anything that starts where this ends (the next statement's mark).
                    edits.Add(Edit.Insert(statement.Span.End, " }", order: 0));
                    break;
                default:
                    // A global statement, or somewhere a statement can't take a mark before it.
                    continue;
            }
            lines.Add(line);
        }
    }

    private static bool IsStatic(SyntaxNode node) => node switch
    {
        LambdaExpressionSyntax lambda => lambda.Modifiers.Any(SyntaxKind.StaticKeyword),
        AnonymousMethodExpressionSyntax method => method.Modifiers.Any(SyntaxKind.StaticKeyword),
        LocalFunctionStatementSyntax function => function.Modifiers.Any(SyntaxKind.StaticKeyword),
        _ => false,
    };
}
