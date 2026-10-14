// Rewrites a TypeScript source file so its functions report to the recorder runtime
// (runtime.ts, reached as globalThis.__runshape). Every insertion stays on the line it belongs
// to, so line numbers in the recording, and in stack traces, are the source's own.
//
// Tracked, each with a catalog entry and a span per call: function declarations, class
// methods, accessors and constructors, arrow functions and function expressions bound to a
// top-level const or a class property. Not tracked: callbacks and object-literal methods
// (their lines count toward the function they run in), generators, and a derived class's
// constructor whose super() call isn't a statement of its own (only what follows super() is
// wrapped: the call can't move into a closure, and `this` exists only after it).
import ts from "typescript";

import type { SymbolDto } from "./runtime";

export interface CatalogEntry {
  file: string;
  symbol: SymbolDto;
  firstLine: number;
  lastLine: number;
  /** Lines holding a statement this function runs itself (not a nested tracked function's). */
  lines: number[];
}

export interface Instrumented {
  functions: CatalogEntry[];
  code: string;
}

interface Insertion {
  at: number;
  text: string;
  /** Ties at one position: wrappers open outermost first, close innermost first, line marks last. */
  order: number;
}

interface Scope {
  /** The catalog entry whose span is running here, or null at module level. */
  current: CatalogEntry | null;
  /** Its index in the module's function table: line marks name the function they belong to. */
  currentIndex: number;
  className: string | null;
  /** Names between the file and the next function: classes, enclosing functions. */
  container: string[];
}

const LINE_MARK_ORDER = Number.MAX_SAFE_INTEGER;
/** Declarations that run nothing where they stand: no line mark before them. */
const NOT_EXECUTED = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EmptyStatement,
]);

/** `file` is the path relative to the project root, with "/" separators: it becomes the namespace. */
export function instrument(file: string, text: string): Instrumented {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const namespace = file.replace(/\.[cm]?[jt]sx?$/, "").split("/");
  const functions: CatalogEntry[] = [];
  const insertions: Insertion[] = [];
  /** Statements no span is open for, so they get no line mark and aren't catalogued lines. */
  const outsideSpans = new Set<ts.Statement>();
  let visits = 0;
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;

  const visit = (node: ts.Node, scope: Scope): void => {
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      ts.forEachChild(node, (child) => visit(child, { ...scope, container: [...scope.container, (node.name as ts.Identifier).text] }));
      return;
    }
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const className = node.name.text;
      const ambient = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
      if (node.parent === source && !ambient) {
        insertions.push({ at: node.end, text: `;__rs.cls(${className}, ${JSON.stringify([...namespace, className])});`, order: 0 });
      }
      ts.forEachChild(node, (child) => visit(child, { ...scope, className, container: [...scope.container, className] }));
      return;
    }
    if (isFunctionWithBody(node)) {
      const symbol = trackedSymbol(node, scope, namespace);
      if (symbol !== null) {
        const entry: CatalogEntry = { file, symbol, firstLine: lineOf(node.getStart()), lastLine: lineOf(node.end), lines: [] };
        const index = functions.push(entry) - 1;
        const expressionLine = ts.isBlock(node.body) ? null : lineOf(node.body.getStart());
        if (expressionLine !== null) entry.lines.push(expressionLine);
        wrap(node, index, ++visits, insertions, expressionLine);
        const inner: Scope = { current: entry, currentIndex: index, className: scope.className, container: [...symbol.container, symbol.name] };
        // A derived constructor's span opens after super(...): what comes before runs outside it.
        if (ts.isConstructorDeclaration(node) && isDerived(node)) {
          const statements = node.body!.statements;
          for (const statement of statements.slice(0, statements.indexOf(superStatement(node)!) + 1)) outsideSpans.add(statement);
        }
        ts.forEachChild(node, (child) => visit(child, inner));
        return;
      }
    }
    if (scope.current !== null && (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node))) {
      for (const statement of node.statements) {
        if (NOT_EXECUTED.has(statement.kind) || outsideSpans.has(statement)) continue;
        const line = lineOf(statement.getStart());
        if (!scope.current.lines.includes(line)) scope.current.lines.push(line);
        // Naming the function lets a callback's line count for the function that wrote it,
        // whichever function happens to be running the callback.
        insertions.push({ at: statement.getStart(), text: `;__rs.l(${line}, __rsF[${scope.currentIndex}]);`, order: LINE_MARK_ORDER });
      }
    }
    if (scope.current !== null) {
      // `if (a) f(); else g();`: each body becomes a block holding its own line mark.
      for (const body of unbracedBodies(node)) {
        const line = lineOf(body.getStart());
        if (!scope.current.lines.includes(line)) scope.current.lines.push(line);
        insertions.push({ at: body.getStart(), text: `{;__rs.l(${line}, __rsF[${scope.currentIndex}]);`, order: LINE_MARK_ORDER });
        insertions.push({ at: body.end, text: "}", order: -LINE_MARK_ORDER });
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(source, { current: null, currentIndex: -1, className: null, container: [] });

  for (const entry of functions) entry.lines.sort((a, b) => a - b);
  const table = JSON.stringify(functions.map(({ symbol, file, firstLine }) => ({ symbol, file, firstLine })));
  // Without a recorder (a module a config file imports, say) the code runs as written.
  const prologue = `const __rs = globalThis.__runshape ?? { functions: () => [], run: (f, r, body) => body(), runAsync: (f, r, body) => body(), l() {}, cls() {} }; const __rsF = __rs.functions(${table});`;
  // A hashbang must stay the first thing in the file: the prologue goes at the start of line 2.
  const at = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0;
  insertions.push({ at, text: prologue, order: Number.MIN_SAFE_INTEGER });
  return { functions, code: apply(text, insertions) };
}

type FunctionWithBody = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return ts.isFunctionLike(node) && "body" in node && node.body !== undefined;
}

/** What a function is called, or null when it isn't tracked on its own. */
function trackedSymbol(node: FunctionWithBody, scope: Scope, namespace: string[]): SymbolDto | null {
  if (node.asteriskToken !== undefined) return null;
  const inClass = node.parent !== undefined && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent));
  const symbol = (name: string, kind: SymbolDto["kind"], ownerType: string | null): SymbolDto => ({
    namespace,
    container: scope.container,
    name,
    kind,
    ownerType,
  });

  if (ts.isConstructorDeclaration(node)) {
    if (scope.className === null) return null;
    if (isDerived(node) && superStatement(node) === null) return null;
    return symbol("constructor", "constructor", scope.className);
  }
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && inClass && scope.className !== null) {
    const name = node.name.getText();
    const accessor = ts.isGetAccessorDeclaration(node) ? "get " : ts.isSetAccessorDeclaration(node) ? "set " : "";
    return symbol(`${isStatic(node) ? "static " : ""}${accessor}${name}`, "method", scope.className);
  }
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return symbol(node.name.text, scope.current === null ? "function" : "nested", scope.className);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const holder = node.parent;
    if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) && scope.current === null && holder.parent.parent.parent === holder.getSourceFile()) {
      return symbol(holder.name.text, "function", null);
    }
    if (ts.isPropertyDeclaration(holder) && ts.isIdentifier(holder.name) && scope.className !== null) {
      return symbol(`${isStatic(holder) ? "static " : ""}${holder.name.text}`, "method", scope.className);
    }
  }
  return null;
}

function isDerived(node: ts.ConstructorDeclaration): boolean {
  return node.parent.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? false;
}

/** A derived constructor's `super(...);` when it's a statement of the body itself. */
function superStatement(node: ts.ConstructorDeclaration): ts.Statement | null {
  const statements = node.body?.statements ?? [];
  return statements.find((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword) ?? null;
}

/** The branches and loop bodies of `node` written without braces. */
function unbracedBodies(node: ts.Node): ts.Statement[] {
  if (ts.isIfStatement(node)) return [node.thenStatement, node.elseStatement].filter((body): body is ts.Statement => body !== undefined && !ts.isBlock(body));
  if (ts.isIterationStatement(node, false)) return ts.isBlock(node.statement) ? [] : [node.statement];
  return [];
}

/** A static and an instance member may share a name; their symbols must not. */
function isStatic(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
}

/** Runs the body inside __rs.run, which opens and closes the span around it. */
function wrap(node: FunctionWithBody, index: number, visit: number, insertions: Insertion[], expressionLine: number | null): void {
  const fn = `__rsF[${index}]`;
  const isAsync = ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async;
  const run = isAsync ? "runAsync" : "run";
  const arrow = isAsync ? "async () =>" : "() =>";
  // Arrows have no `this` of their own, except a class property's, which is the instance.
  const takesThis = !ts.isArrowFunction(node) || ts.isPropertyDeclaration(node.parent);
  const receiver = ts.isConstructorDeclaration(node) || !takesThis ? "undefined" : "this";
  const built = ts.isConstructorDeclaration(node) ? ", () => this" : "";
  const body = node.body;
  if (ts.isBlock(body)) {
    const open = ` return __rs.${run}(__rsF[${index}], ${receiver}, ${arrow} {`;
    const close = `}${built});`;
    // A derived constructor's span opens after its super(...) statement (see the file comment).
    const after = ts.isConstructorDeclaration(node) && isDerived(node) ? superStatement(node)!.end : body.getStart() + 1;
    // Nothing between open and close (`{}`, or super() last): one insertion keeps them in order.
    if (after === body.end - 1) {
      insertions.push({ at: body.end - 1, text: open + close, order: visit });
      return;
    }
    insertions.push({ at: after, text: open, order: visit });
    insertions.push({ at: body.end - 1, text: close, order: -visit });
  } else {
    insertions.push({ at: body.getStart(), text: `__rs.${run}(${fn}, ${receiver}, ${arrow} (__rs.l(${expressionLine}, ${fn}), `, order: visit });
    insertions.push({ at: body.end, text: `))`, order: -visit });
  }
}

function apply(text: string, insertions: Insertion[]): string {
  const sorted = [...insertions].sort((a, b) => a.at - b.at || a.order - b.order);
  let out = "";
  let from = 0;
  for (const { at, text: inserted } of sorted) {
    out += text.slice(from, at) + inserted;
    from = at;
  }
  return out + text.slice(from);
}
