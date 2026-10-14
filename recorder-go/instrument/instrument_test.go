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
