// Package instrument rewrites Go source so its functions report to the recorder runtime
// (package runshape): each function and method opens a frame on entry and closes it on return,
// and each statement marks its line through that frame. Every insertion stays on the line it
// belongs to, so recorded line numbers, and panics' stack traces, are the source's own.
//
// Function literals (closures) aren't frames of their own: their lines are marked through the
// frame of the function that wrote them, whichever goroutine runs them.
package instrument

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"hash/fnv"
	"path"
	"sort"
	"strconv"
	"strings"
)

// RuntimeImport is the package instrumented code calls.
const RuntimeImport = "github.com/cardboardforts/runshape/recorder-go/runshape"

// Symbol is trace format v2's name for a function (docs/trace-format.md).
type Symbol struct {
	Namespace []string `json:"namespace"`
	Container []string `json:"container"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	OwnerType *string  `json:"ownerType"`
}

// Function is a catalog entry: a function the instrumented file defines.
type Function struct {
	File      string `json:"file"`
	Symbol    Symbol `json:"symbol"`
	FirstLine int    `json:"firstLine"`
	LastLine  int    `json:"lastLine"`
	// Lines holds a statement this function runs, its closures' included.
	Lines []int `json:"lines"`
}

// Result is an instrumented file and what it defines.
type Result struct {
	Code      []byte
	Functions []Function
	// Handlers are the functions taking (http.ResponseWriter, *http.Request).
	Handlers []Symbol
	// Routes are the file's HandleFunc and Handle registrations.
	Routes []Route
}

// Route is a registration such as mux.HandleFunc("POST /orders", h.placeOrder). The handler is
// named as written; the recorder resolves it among the package's handlers.
type Route struct {
	Pattern string
	Handler string
	// Method is set when the handler was a method value (h.placeOrder), not a function.
	Method bool
}

type insertion struct {
	at   int
	text string
	// Ties at one position: frame opening before line marks.
	order int
}

// Instrument rewrites one non-test file. file is its path relative to the module root (with
// "/"), pkgPath the package's import path: its segments are the functions' namespace.
func Instrument(file, pkgPath string, src []byte) (Result, error) {
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, src, parser.ParseComments)
	if err != nil {
		return Result{}, err
	}
	tf := fset.File(parsed.Pos())
	offset := func(pos token.Pos) int { return tf.Offset(pos) }
	line := func(pos token.Pos) int { return tf.Line(pos) }
	namespace := strings.Split(pkgPath, "/")
	table := tableName(file)

	var functions []Function
	var handlers []Symbol
	var insertions []insertion
	for _, decl := range parsed.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		symbol, receiver := symbolOf(fn, namespace, path.Base(file))
		entry := Function{File: file, Symbol: symbol, FirstLine: line(fn.Pos()), LastLine: line(fn.End()), Lines: []int{}}
		index := len(functions)
		open := fmt.Sprintf(" __rsF := __rs.Enter(&%s, %d, %s); defer __rsF.Exit();", table, index, receiver)
		if request, ok := handlerRequest(fn.Type); ok {
			handlers = append(handlers, symbol)
			if request != "" {
				open += fmt.Sprintf(" __rsF.Request(%s.Method, %s.URL.Path);", request, request)
			}
		}
		insertions = append(insertions, insertion{at: offset(fn.Body.Lbrace) + 1, text: open})
		seen := map[int]bool{}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			for _, statement := range statementsOf(node) {
				if _, empty := statement.(*ast.EmptyStmt); empty {
					continue
				}
				at, n := markPosition(statement, offset, line)
				if !seen[n] {
					seen[n] = true
					entry.Lines = append(entry.Lines, n)
				}
				insertions = append(insertions, insertion{at: at, text: fmt.Sprintf("__rsF.Line(%d); ", n), order: 1})
			}
			return true
		})
		sort.Ints(entry.Lines)
		functions = append(functions, entry)
	}
	routes := routesIn(parsed)
	if len(functions) == 0 {
		return Result{Code: src, Routes: routes}, nil
	}

	// On the package clause's line, so no line below it moves.
	insertions = append(insertions, insertion{at: offset(parsed.Name.End()), text: fmt.Sprintf("; import __rs %q", RuntimeImport)})
	code := apply(src, insertions)
	entries, err := json.Marshal(functions)
	if err != nil {
		return Result{}, err
	}
	// After the last line: Go wants imports before declarations, and appending moves nothing. A
	// literal of constants, so it's set before any package initialisation runs (a function
	// another file's var reaches during init, through an interface, can already use it); the
	// runtime registers it on first use.
	code = append(code, []byte(fmt.Sprintf("\nvar %s = __rs.Table{Entries: %s}\n", table, strconv.Quote(string(entries))))...)
	return Result{Code: code, Functions: functions, Handlers: handlers, Routes: routes}, nil
}

// handlerRequest reports whether a function is an HTTP handler, (http.ResponseWriter,
// *http.Request), and the request parameter's name ("" when it's blank or unnamed).
func handlerRequest(typ *ast.FuncType) (string, bool) {
	var params []*ast.Field
	var names []string
	for _, field := range typ.Params.List {
		if len(field.Names) == 0 {
			params, names = append(params, field), append(names, "")
		}
		for _, name := range field.Names {
			params, names = append(params, field), append(names, name.Name)
		}
	}
	if len(params) != 2 || !isSelector(params[0].Type, "http", "ResponseWriter") {
		return "", false
	}
	star, ok := params[1].Type.(*ast.StarExpr)
	if !ok || !isSelector(star.X, "http", "Request") {
		return "", false
	}
	if names[1] == "_" {
		return "", true
	}
	return names[1], true
}

func isSelector(expr ast.Expr, pkg, name string) bool {
	selector, ok := expr.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != name {
		return false
	}
	ident, ok := selector.X.(*ast.Ident)
	return ok && ident.Name == pkg
}

// routesIn finds x.HandleFunc("pattern", handler) and x.Handle("pattern", handler) calls,
// looking through a conversion such as http.HandlerFunc(health).
func routesIn(file *ast.File) []Route {
	var routes []Route
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) != 2 {
			return true
		}
		fun, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || (fun.Sel.Name != "HandleFunc" && fun.Sel.Name != "Handle") {
			return true
		}
		literal, ok := call.Args[0].(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		pattern, err := strconv.Unquote(literal.Value)
		if err != nil {
			return true
		}
		handler := call.Args[1]
		if conversion, ok := handler.(*ast.CallExpr); ok && len(conversion.Args) == 1 {
			handler = conversion.Args[0]
		}
		switch h := handler.(type) {
		case *ast.SelectorExpr:
			routes = append(routes, Route{Pattern: pattern, Handler: h.Sel.Name, Method: true})
		case *ast.Ident:
			routes = append(routes, Route{Pattern: pattern, Handler: h.Name})
		}
		return true
	})
	return routes
}

// InstrumentTest makes each top-level TestXxx(t *testing.T) in a _test.go file a scenario.
func InstrumentTest(file string, src []byte) ([]byte, error) {
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, src, parser.ParseComments)
	if err != nil {
		return nil, err
	}
	tf := fset.File(parsed.Pos())
	var insertions []insertion
	for _, decl := range parsed.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil || fn.Recv != nil || !isTest(fn) {
			continue
		}
		t := fn.Type.Params.List[0].Names[0].Name
		insertions = append(insertions, insertion{
			at:   tf.Offset(fn.Body.Lbrace) + 1,
			text: fmt.Sprintf(" defer __rs.Scenario(%s, %q, %q)();", t, file, fn.Name.Name),
		})
	}
	if len(insertions) == 0 {
		return src, nil
	}
	insertions = append(insertions, insertion{at: tf.Offset(parsed.Name.End()), text: fmt.Sprintf("; import __rs %q", RuntimeImport)})
	return apply(src, insertions), nil
}

// isTest is go test's rule: TestXxx with one named *testing.T parameter.
func isTest(fn *ast.FuncDecl) bool {
	name := fn.Name.Name
	if !strings.HasPrefix(name, "Test") || name == "TestMain" {
		return false
	}
	if rest := strings.TrimPrefix(name, "Test"); rest != "" && strings.ToLower(rest[:1]) == rest[:1] && rest[:1] != "_" {
		return false
	}
	params := fn.Type.Params.List
	if len(params) != 1 || len(params[0].Names) != 1 || params[0].Names[0].Name == "_" {
		return false
	}
	star, ok := params[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	selector, ok := star.X.(*ast.SelectorExpr)
	return ok && selector.Sel.Name == "T"
}

// symbolOf names a function, and returns what to pass as its receiver: a pointer receiver
// identifies the object; a value receiver is a copy, so nil.
func symbolOf(fn *ast.FuncDecl, namespace []string, fileName string) (Symbol, string) {
	symbol := Symbol{Namespace: namespace, Container: []string{}, Name: fn.Name.Name, Kind: "function"}
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		if fn.Name.Name == "init" {
			// A package may have many: the file keeps them apart (and stable across commits).
			symbol.Name = fmt.Sprintf("init (%s)", fileName)
			symbol.Kind = "initializer"
		}
		return symbol, "nil"
	}
	field := fn.Recv.List[0]
	typ, pointer := receiverType(field.Type)
	symbol.Container = []string{typ}
	symbol.Kind = "method"
	symbol.OwnerType = &typ
	if pointer && len(field.Names) == 1 && field.Names[0].Name != "_" {
		return symbol, field.Names[0].Name
	}
	return symbol, "nil"
}

func receiverType(expr ast.Expr) (string, bool) {
	switch t := expr.(type) {
	case *ast.StarExpr:
		name, _ := receiverType(t.X)
		return name, true
	case *ast.IndexExpr: // a generic type: Box[T]
		return receiverType(t.X)
	case *ast.IndexListExpr: // Pair[K, V]
		return receiverType(t.X)
	case *ast.Ident:
		return t.Name, false
	}
	return "?", false
}

// markPosition is where a statement's line mark goes, and the line it marks. A labelled
// statement is marked after its label, so a goto to the label still records the line, except
// a labelled loop, switch or select: break and continue name the label, which must stay on it.
func markPosition(statement ast.Stmt, offset func(token.Pos) int, line func(token.Pos) int) (int, int) {
	labelled, ok := statement.(*ast.LabeledStmt)
	if !ok {
		return offset(statement.Pos()), line(statement.Pos())
	}
	inner := labelled.Stmt
	switch inner.(type) {
	case *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt:
		return offset(statement.Pos()), line(inner.Pos())
	}
	return offset(inner.Pos()), line(inner.Pos())
}

// statementsOf returns the statement lists a node holds: where line marks go. A switch's or a
// select's block holds case clauses, not statements: nothing goes between them.
func statementsOf(node ast.Node) []ast.Stmt {
	switch n := node.(type) {
	case *ast.BlockStmt:
		statements := []ast.Stmt{}
		for _, statement := range n.List {
			switch statement.(type) {
			case *ast.CaseClause, *ast.CommClause:
				continue
			}
			statements = append(statements, statement)
		}
		return statements
	case *ast.CaseClause:
		return n.Body
	case *ast.CommClause:
		return n.Body
	}
	return nil
}

// tableName is a package-unique name for a file's function table.
func tableName(file string) string {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(file))
	return fmt.Sprintf("__rsT_%08x", hash.Sum32())
}

func apply(src []byte, insertions []insertion) []byte {
	sort.SliceStable(insertions, func(i, j int) bool {
		if insertions[i].at != insertions[j].at {
			return insertions[i].at < insertions[j].at
		}
		return insertions[i].order < insertions[j].order
	})
	var out []byte
	from := 0
	for _, ins := range insertions {
		out = append(out, src[from:ins.at]...)
		out = append(out, ins.text...)
		from = ins.at
	}
	return append(out, src[from:]...)
}
