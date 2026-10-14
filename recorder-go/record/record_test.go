package record

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Recording a module end to end: copy it, instrument it, run its tests, write the trace. The
// example shop's e2e tests drive the real router in process, so a recorded request shows the
// whole path: the HTTP adapter, the orders service, the domain rules and the storage adapter.

func TestRecordsTheExampleShop(t *testing.T) {
	out := t.TempDir()
	module, _ := filepath.Abs(filepath.Join("..", "..", "examples", "go-shop"))
	recorder, _ := filepath.Abs("..")

	if err := Record(Options{Module: module, Out: out, Run: "run", RecorderModule: recorder}); err != nil {
		t.Fatal(err)
	}

	var manifest struct {
		Version   int    `json:"version"`
		Language  string `json:"language"`
		Runtime   string `json:"runtime"`
		Catalog   []struct {
			File   string `json:"file"`
			Symbol struct {
				Container []string `json:"container"`
				Name      string   `json:"name"`
			} `json:"symbol"`
		} `json:"catalog"`
		Sources   map[string][]string `json:"sources"`
		Scenarios []struct {
			Nodeid  string `json:"nodeid"`
			File    string `json:"file"`
			Outcome string `json:"outcome"`
		} `json:"scenarios"`
		SessionProblems []string `json:"sessionProblems"`
	}
	read(t, filepath.Join(out, "run", "manifest.json"), &manifest)

	var tests []string
	for _, s := range manifest.Scenarios {
		tests = append(tests, s.Outcome+" "+s.Nodeid)
	}
	sort.Strings(tests)
	if !reflect.DeepEqual(tests, []string{
		"passed e2e/orders_test.go::TestAMalformedOrderIsRefusedBeforeTheService",
		"passed e2e/orders_test.go::TestAnInvalidOrderListsEveryProblem",
		"passed e2e/orders_test.go::TestAnUnknownOrderIsNotFound",
		"passed e2e/orders_test.go::TestPlaceThenFetchAnOrder",
		"passed internal/orders/order_test.go::TestTotalAddsEveryItem",
	}) {
		t.Errorf("scenarios: %q", tests)
	}
	if manifest.Version != 2 || manifest.Language != "go" || !strings.HasPrefix(manifest.Runtime, "go1.") || len(manifest.SessionProblems) != 0 {
		t.Errorf("manifest: version %d, language %q, runtime %q, problems %q", manifest.Version, manifest.Language, manifest.Runtime, manifest.SessionProblems)
	}
	if len(manifest.Catalog) < 15 || len(manifest.Sources["internal/orders/service.go"]) == 0 {
		t.Errorf("catalog of %d, sources %d files", len(manifest.Catalog), len(manifest.Sources))
	}
	var latest map[string]string
	read(t, filepath.Join(out, "latest.json"), &latest)
	if latest["run"] != "run" {
		t.Errorf("latest.json: %v", latest)
	}

	// The first test, as a call tree.
	var placed *scenario
	for _, s := range manifest.Scenarios {
		if strings.HasSuffix(s.Nodeid, "TestPlaceThenFetchAnOrder") {
			placed = &scenario{}
			read(t, filepath.Join(out, "run", s.File), placed)
		}
	}
	tree := placed.tree()
	for _, want := range []string{
		"TestPlaceThenFetchAnOrder",
		"  app.New",
		"    orders.NewService",
		"  web.Handler.ServeHTTP",
		"    web.Handler.placeOrder",
		"      orders.Service.Place",
		"        orders.Order.Problems",
		"        storage.MemoryRepository.Save",
		"    web.Handler.getOrder",
		"      orders.Service.Get",
		"        storage.MemoryRepository.Find",
		"      orders.Order.TotalCents",
	} {
		if !contains(tree, want) {
			t.Errorf("missing %q in\n%s", want, strings.Join(tree, "\n"))
		}
	}
}

type scenario struct {
	Functions []struct {
		Symbol struct {
			Namespace []string `json:"namespace"`
			Container []string `json:"container"`
			Name      string   `json:"name"`
		} `json:"symbol"`
	} `json:"functions"`
	Events [][]any `json:"events"`
}

// tree renders spans as "package.Type.method", indented under their callers.
func (s scenario) tree() []string {
	depth := map[float64]int{}
	var out []string
	for _, e := range s.Events {
		if e[0] != "S" {
			continue
		}
		span, fn := e[2].(float64), int(e[3].(float64))
		if e[4] != nil {
			depth[span] = depth[e[4].(float64)] + 1
		}
		sym := s.Functions[fn].Symbol
		name := strings.Join(append(append([]string{}, sym.Container...), sym.Name), ".")
		if len(sym.Namespace) > 0 && fn > 0 {
			name = sym.Namespace[len(sym.Namespace)-1] + "." + name
		}
		out = append(out, strings.Repeat("  ", depth[span])+name)
	}
	return out
}

func contains(lines []string, want string) bool {
	for _, line := range lines {
		if line == want {
			return true
		}
	}
	return false
}

func read(t *testing.T, path string, into any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatal(fmt.Errorf("%s: %w", path, err))
	}
}
