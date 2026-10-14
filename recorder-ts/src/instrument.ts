// Rewrites a TypeScript source file so its functions report to the recorder runtime
// (runtime.ts, reached as globalThis.__runshape). Every insertion stays on the line it belongs
// to, so line numbers in the recording, and in stack traces, are the source's own.
//
// Tracked, each with a catalog entry and a span per call: function declarations, class
// methods, accessors and constructors, arrow functions and function expressions bound to a
// top-level const or a class property. Not tracked: callbacks and object-literal methods
// (their lines count toward the function they run in), generators, and constructors of
// derived classes (a super() call can't move into the closure that wraps a body).
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
  let visits = 0;
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;

  const visit = (node: ts.Node, scope: Scope): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const className = node.name.text;
      if (node.parent === source) {
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
        const inner: Scope = { current: entry, className: scope.className, container: [...symbol.container, symbol.name] };
        ts.forEachChild(node, (child) => visit(child, inner));
        return;
      }
    }
    if (scope.current !== null && (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node))) {
      for (const statement of node.statements) {
        if (NOT_EXECUTED.has(statement.kind)) continue;
        const line = lineOf(statement.getStart());
        if (!scope.current.lines.includes(line)) scope.current.lines.push(line);
        insertions.push({ at: statement.getStart(), text: `;__rs.l(${line});`, order: LINE_MARK_ORDER });
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(source, { current: null, className: null, container: [] });

  for (const entry of functions) entry.lines.sort((a, b) => a - b);
  const prologue = `const __rs = globalThis.__runshape; const __rsF = __rs.functions(${JSON.stringify(functions.map(({ symbol, file, firstLine }) => ({ symbol, file, firstLine })))});`;
  return { functions, code: prologue + apply(text, insertions) };
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
    const derived = node.parent.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? false;
    return derived || scope.className === null ? null : symbol("constructor", "constructor", scope.className);
  }
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && inClass && scope.className !== null) {
    const name = node.name.getText();
    const prefix = ts.isGetAccessorDeclaration(node) ? "get " : ts.isSetAccessorDeclaration(node) ? "set " : "";
    return symbol(`${prefix}${name}`, "method", scope.className);
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
      return symbol(holder.name.text, "method", scope.className);
    }
  }
  return null;
}

/** Runs the body inside __rs.run, which opens and closes the span around it. */
function wrap(node: FunctionWithBody, index: number, visit: number, insertions: Insertion[], expressionLine: number | null): void {
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
    // An empty body `{}` opens and closes at one position: one insertion keeps them in order.
    if (body.statements.length === 0 && body.getStart() + 1 === body.end - 1) {
      insertions.push({ at: body.end - 1, text: open + close, order: visit });
      return;
    }
    insertions.push({ at: body.getStart() + 1, text: open, order: visit });
    insertions.push({ at: body.end - 1, text: close, order: -visit });
  } else {
    insertions.push({ at: body.getStart(), text: `__rs.${run}(__rsF[${index}], ${receiver}, ${arrow} (__rs.l(${expressionLine}), `, order: visit });
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
