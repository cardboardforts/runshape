package instrument

import (
	"fmt"
	"go/parser"
	"go/token"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// The instrumenter rewrites a Go file so each function reports its calls and lines to the
// runtime (package runshape), keeping every line where it was.

const sample = `package orders

import "fmt"

type Service struct{ count int }

func NewService() *Service {
	return &Service{}
}

func (s *Service) Place(name string) string {
	s.count++
	check := func(n string) bool {
		return n != ""
	}
	if !check(name) {
		return "refused"
	}
	return fmt.Sprintf("placed %s", name)
}

func (s Service) Count() int { return s.count }

func init() {
	_ = 1
}
`

func TestCataloguesFunctionsAndMethodsWithTheirLines(t *testing.T) {
	result, err := Instrument("internal/orders/service.go", "example.com/shop/internal/orders", []byte(sample))
	if err != nil {
		t.Fatal(err)
	}

	var got []string
	for _, fn := range result.Functions {
		owner := ""
		if fn.Symbol.OwnerType != nil {
			owner = " of " + *fn.Symbol.OwnerType
		}
		got = append(got, fmt.Sprintf("%s: %s%s, line %d, runs %v", strings.Join(append(fn.Symbol.Container, fn.Symbol.Name), "."), fn.Symbol.Kind, owner, fn.FirstLine, fn.Lines))
	}
	want := []string{
		"NewService: function, line 7, runs [8]",
		// The closure is part of Place: its line counts as Place's.
		"Service.Place: method of Service, line 11, runs [12 13 14 16 17 19]",
		"Service.Count: method of Service, line 22, runs [22]",
		// Go allows any number of init functions per package: the file keeps them apart.
		"init (service.go): initializer, line 24, runs [25]",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("catalog:\n got %q\nwant %q", got, want)
	}
	if ns := result.Functions[0].Symbol.Namespace; !reflect.DeepEqual(ns, []string{"example.com", "shop", "internal", "orders"}) {
		t.Errorf("namespace %q", ns)
	}
}

func TestTheInstrumentedFileParsesAndKeepsItsLineNumbers(t *testing.T) {
	result, err := Instrument("internal/orders/service.go", "example.com/shop/internal/orders", []byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parser.ParseFile(token.NewFileSet(), "service.go", result.Code, 0); err != nil {
		t.Fatalf("instrumented code doesn't parse: %v\n%s", err, result.Code)
	}
	// Take the insertions back out: what's left is the source, line for line, then the table.
	inserted := regexp.MustCompile(`; import __rs "[^"]+"| __rsF := __rs\.Enter\([^;]*\); defer __rsF\.Exit\(\);|__rsF\.Line\(\d+\); `)
	stripped := inserted.ReplaceAllString(string(result.Code), "")
	if !strings.HasPrefix(stripped, sample) || !strings.HasPrefix(stripped[len(sample):], "\nvar __rsT_") {
		t.Errorf("lines moved:\n%s", stripped)
	}
}

const sampleTest = `package e2e

import "testing"

func helper(t *testing.T) {}

func TestPlaces(t *testing.T) {
	helper(t)
}
`

func TestATestFunctionBecomesAScenario(t *testing.T) {
	result, err := InstrumentTest("e2e/orders_test.go", []byte(sampleTest))
	if err != nil {
		t.Fatal(err)
	}
	code := string(result)
	if !strings.Contains(code, `defer __rs.Scenario(t, "e2e/orders_test.go", "TestPlaces")()`) || strings.Count(code, "__rs.Scenario") != 1 {
		t.Errorf("want one scenario, for TestPlaces only:\n%s", code)
	}
	if _, err := parser.ParseFile(token.NewFileSet(), "orders_test.go", result, 0); err != nil {
		t.Fatalf("doesn't parse: %v", err)
	}
}

const sampleHTTP = `package web

import "net/http"

type Handler struct{ mux *http.ServeMux }

func NewHandler() *Handler {
	h := &Handler{mux: http.NewServeMux()}
	h.mux.HandleFunc("POST /orders", h.placeOrder)
	h.mux.Handle("/health", http.HandlerFunc(health))
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mux.ServeHTTP(w, r)
}

func (h *Handler) placeOrder(w http.ResponseWriter, r *http.Request) {}

func health(w http.ResponseWriter, _ *http.Request) {}
`

// Go's standard library has no framework to ask for routes, but its shape is in the source:
// handlers take (http.ResponseWriter, *http.Request), and routes are registered with HandleFunc
// or Handle and a pattern. A handler reports the request it serves; the runtime keeps only the
// outermost one on a call stack.
func TestFindsHandlersRoutesAndReportsRequests(t *testing.T) {
	result, err := Instrument("internal/web/handler.go", "example.com/shop/internal/web", []byte(sampleHTTP))
	if err != nil {
		t.Fatal(err)
	}

	var handlers []string
	for _, h := range result.Handlers {
		handlers = append(handlers, strings.Join(append(append([]string{}, h.Container...), h.Name), "."))
	}
	if want := []string{"Handler.ServeHTTP", "Handler.placeOrder", "health"}; !reflect.DeepEqual(handlers, want) {
		t.Errorf("handlers %q, want %q", handlers, want)
	}
	if want := []Route{{Pattern: "POST /orders", Handler: "placeOrder", Method: true}, {Pattern: "/health", Handler: "health"}}; !reflect.DeepEqual(result.Routes, want) {
		t.Errorf("routes %+v, want %+v", result.Routes, want)
	}
	code := string(result.Code)
	if strings.Count(code, "__rsM, __rsP = r.Method, r.URL.Path };") != 2 {
		t.Errorf("want the two handlers with a named request to report it:\n%s", code)
	}
}

const sampleImports = `package wiring

import (
	nethttp "net/http"

	"example.com/shop/internal/server"
	"example.com/shop/internal/http"
)

func Routes(m *nethttp.ServeMux) {
	m.HandleFunc("/index", server.Index)
	m.Handle("/files", nethttp.FileServer(nil))
}

func (w *Wiring) Index(rw nethttp.ResponseWriter, req *nethttp.Request) {}

// Not net/http's: a package that happens to be named http.
func Fake(w http.ResponseWriter, r *http.Request) {}
`

// Handlers are found by what the file imports as net/http, under any name; a selector on an
// imported package names that package's function; a request is only read when there is one.
func TestHandlersFollowTheFilesImports(t *testing.T) {
	result, err := Instrument("internal/wiring/wiring.go", "example.com/shop/internal/wiring", []byte(sampleImports))
	if err != nil {
		t.Fatal(err)
	}
	var handlers []string
	for _, h := range result.Handlers {
		handlers = append(handlers, strings.Join(append(append([]string{}, h.Container...), h.Name), "."))
	}
	if want := []string{"Wiring.Index"}; !reflect.DeepEqual(handlers, want) {
		t.Errorf("handlers %q, want %q", handlers, want)
	}
	// FileServer(nil) is a call, not a handler this file names: skipped, not a problem.
	if want := []Route{{Pattern: "/index", Handler: "Index", Package: "example.com/shop/internal/server"}}; !reflect.DeepEqual(result.Routes, want) {
		t.Errorf("routes %+v, want %+v", result.Routes, want)
	}
	if code := string(result.Code); !strings.Contains(code, "if req != nil && req.URL != nil { __rsM, __rsP = req.Method, req.URL.Path };") {
		t.Errorf("want a nil-safe request read:\n%s", code)
	}
}
