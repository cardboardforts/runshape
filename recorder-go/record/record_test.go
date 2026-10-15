package record

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
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
		Version  int    `json:"version"`
		Language string `json:"language"`
		Runtime  string `json:"runtime"`
		Catalog  []struct {
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
	var framework struct {
		Framework struct {
			Framework string `json:"framework"`
			Routes    []struct {
				Methods []string `json:"methods"`
				Path    string   `json:"path"`
				Handler []string `json:"handler"`
			} `json:"routes"`
		} `json:"framework"`
	}
	read(t, filepath.Join(out, "run", "manifest.json"), &framework)
	var routes []string
	for _, route := range framework.Framework.Routes {
		routes = append(routes, fmt.Sprintf("%v %s -> %s", route.Methods, route.Path, strings.Join(route.Handler, ".")))
	}
	// Read from the source: web.NewHandler's HandleFunc calls.
	if want := []string{
		"[POST] /orders -> example.com.shop.internal.web.Handler.placeOrder",
		"[GET] /orders/{id} -> example.com.shop.internal.web.Handler.getOrder",
	}; framework.Framework.Framework != "net/http" || !reflect.DeepEqual(routes, want) {
		t.Errorf("framework %q, routes %q", framework.Framework.Framework, routes)
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
	// Each request once, on the handler that received it.
	var requests []string
	for _, e := range placed.Events {
		if e[0] == "Q" {
			requests = append(requests, fmt.Sprintf("%v %v", e[3], e[4]))
		}
	}
	if want := []string{"POST /orders", "GET /orders/ord-1"}; !reflect.DeepEqual(requests, want) {
		t.Errorf("requests %q, want %q", requests, want)
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

// The second-model review's probes, as a module (testdata/probe): each construct must build and
// behave as it does uninstrumented, and what the recorder can't record must be said, not lost.
func TestRecordsTheProbeModule(t *testing.T) {
	out := t.TempDir()
	module, _ := filepath.Abs(filepath.Join("testdata", "probe"))
	recorder, _ := filepath.Abs("..")

	// go 1.21 in its go.mod; a relative replace (../dep); a nested module (./sub).
	if err := Record(Options{Module: module, Out: out, Run: "run", RecorderModule: recorder}); err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Catalog []struct {
			File   string `json:"file"`
			Symbol struct {
				Container []string `json:"container"`
				Name      string   `json:"name"`
			} `json:"symbol"`
			Lines []int `json:"lines"`
		} `json:"catalog"`
		Scenarios []struct {
			Nodeid  string `json:"nodeid"`
			File    string `json:"file"`
			Outcome string `json:"outcome"`
		} `json:"scenarios"`
		SessionProblems []string `json:"sessionProblems"`
	}
	read(t, filepath.Join(out, "run", "manifest.json"), &manifest)

	outcomes := map[string]string{}
	for _, s := range manifest.Scenarios {
		outcomes[s.Nodeid[strings.LastIndex(s.Nodeid, "::")+2:]] = s.Outcome
	}
	// TestShapes passing means: switch, type switch, select, goto, init order through a String
	// method, relative replace and nested module all work instrumented.
	if want := map[string]string{"TestShapes": "passed", "TestGoldenFileIsUntouched": "passed", "TestCleanupFails": "failed", "TestPanics": "failed", "TestANilRequestIsServed": "passed"}; !reflect.DeepEqual(outcomes, want) {
		t.Errorf("outcomes %v, want %v", outcomes, want)
	}
	if !reflect.DeepEqual(manifest.SessionProblems, []string{
		"example.com/probe/shapes: a test panicked and stopped the test binary, so the tests after it didn't run",
	}) {
		t.Errorf("session problems %q", manifest.SessionProblems)
	}

	var framework struct {
		Framework struct {
			Routes []struct {
				Path    string   `json:"path"`
				Handler []string `json:"handler"`
			} `json:"routes"`
		} `json:"framework"`
	}
	read(t, filepath.Join(out, "run", "manifest.json"), &framework)
	// wiring registers server.Index: server's function, not wiring's own Index method.
	index := ""
	for _, route := range framework.Framework.Routes {
		if route.Path == "/index" {
			index = strings.Join(route.Handler, ".")
		}
	}
	if index != "example.com.probe.server.Index" {
		t.Errorf("/index is handled by %q (routes %+v)", index, framework.Framework.Routes)
	}

	catalogued := map[string][]int{}
	for _, fn := range manifest.Catalog {
		catalogued[strings.Join(append(append([]string{}, fn.Symbol.Container...), fn.Symbol.Name), ".")] = fn.Lines
	}
	for _, absent := range []string{"Ignored", "Untouched", "Name"} {
		if _, ok := catalogued[absent]; ok {
			t.Errorf("%s is catalogued: build-ignored files, testdata and nested modules aren't the module's code", absent)
		}
	}
	if lines, ok := catalogued["Marker.Mark"]; !ok || lines == nil || len(lines) != 0 {
		t.Errorf("an empty method's lines are %#v, want []", lines)
	}
	if lines := catalogued["Skip"]; !reflect.DeepEqual(lines, []int{44, 45, 47, 49}) {
		t.Errorf("Skip's lines %v: the labelled return is line 49", lines)
	}

	var shapes scenario
	for _, s := range manifest.Scenarios {
		if strings.HasSuffix(s.Nodeid, "::TestShapes") {
			read(t, filepath.Join(out, "run", s.File), &shapes)
		}
	}
	spans := map[float64]string{}
	reached := map[string][]int{}
	objects := 0
	for _, e := range shapes.Events {
		switch e[0] {
		case "S":
			spans[e[2].(float64)] = shapes.Functions[int(e[3].(float64))].Symbol.Name
		case "L":
			name := spans[e[1].(float64)]
			reached[name] = append(reached[name], int(e[2].(float64)))
		case "O":
			objects++
		}
	}
	// Skip(5) jumps to end: and returns: the jump target's line is recorded.
	if !strings.Contains(fmt.Sprint(reached["Skip"]), "44 45 49") {
		t.Errorf("Skip reached %v", reached["Skip"])
	}
	// Zero-size values share one address: they can't be told apart, so aren't objects.
	if objects != 0 {
		t.Errorf("%d objects recorded for zero-size Markers", objects)
	}
}

func TestARunThatRecordsNothingFailsLoudlyAndKeepsTheLastRun(t *testing.T) {
	out := t.TempDir()
	broken := t.TempDir()
	recorder, _ := filepath.Abs("..")
	if err := os.WriteFile(filepath.Join(broken, "go.mod"), []byte("module example.com/broken\n\ngo 1.21\n\nrequire example.com/missing v1.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "latest.json"), []byte(`{"run":"good"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	err := Record(Options{Module: broken, Out: out, Run: "bad", RecorderModule: recorder})
	latest, _ := os.ReadFile(filepath.Join(out, "latest.json"))

	if err == nil || string(latest) != `{"run":"good"}` {
		t.Errorf("error %v, latest.json %s", err, latest)
	}
	for _, name := range []string{"", ".", "..", "../x", "a/b"} {
		if err := Record(Options{Module: broken, Out: out, Run: name, RecorderModule: recorder}); err == nil || !strings.Contains(err.Error(), "run name") {
			t.Errorf("run name %q: %v", name, err)
		}
	}
}

// Recording the program as it runs, not its tests (docs/ideas.md, idea 1): go-shop's real
// binary, started as main starts it, sent real HTTP requests. Startup is one scenario (main
// wiring the app); each request is another, rooted at its client.
func TestRecordsTheRunningShop(t *testing.T) {
	out := t.TempDir()
	module, _ := filepath.Abs(filepath.Join("..", "..", "examples", "go-shop"))
	recorder, _ := filepath.Abs("..")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()

	drive := func() error {
		base := "http://" + address
		for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(50 * time.Millisecond) {
			if response, err := http.Get(base + "/orders/none"); err == nil {
				response.Body.Close()
				break
			} else if time.Now().After(deadline) {
				return fmt.Errorf("the shop never started: %w", err)
			}
		}
		response, err := http.Post(base+"/orders", "application/json", strings.NewReader(`{"customer":"ada","items":[{"sku":"tea","quantity":1,"priceCents":350}]}`))
		if err != nil {
			return err
		}
		response.Body.Close()
		response, err = http.Get(base + "/orders/ord-1")
		if err != nil {
			return err
		}
		return response.Body.Close()
	}
	err = RecordProcess(ProcessOptions{
		Options: Options{Module: module, Out: out, Run: "run", RecorderModule: recorder},
		Package: "./cmd/shop", Env: []string{"SHOP_ADDR=" + address}, Drive: drive, Output: io.Discard,
	})
	if err != nil {
		t.Fatal(err)
	}

	var manifest struct {
		Scenarios []struct {
			Nodeid string `json:"nodeid"`
			File   string `json:"file"`
		} `json:"scenarios"`
	}
	read(t, filepath.Join(out, "run", "manifest.json"), &manifest)
	trees := map[string][]string{}
	var names []string
	for _, s := range manifest.Scenarios {
		var recorded scenario
		read(t, filepath.Join(out, "run", s.File), &recorded)
		trees[s.Nodeid] = recorded.tree()
		names = append(names, s.Nodeid)
	}
	// The readiness probe (GET /orders/none) is a request too.
	if want := []string{"process::startup", "process::GET /orders/none #1", "process::POST /orders #2", "process::GET /orders/ord-1 #3"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("scenarios %q, want %q", names, want)
	}
	for nodeid, want := range map[string][]string{
		"process::startup":         {"startup", "  shop.main", "    app.New", "      storage.NewMemoryRepository", "      orders.NewService", "      web.NewHandler"},
		"process::POST /orders #2": {"POST /orders", "  web.Handler.ServeHTTP", "    web.Handler.placeOrder", "      orders.Service.Place", "        orders.Order.Problems", "        storage.MemoryRepository.Save"},
	} {
		for _, line := range want {
			if !contains(trees[nodeid], line) {
				t.Errorf("%s: missing %q in\n%s", nodeid, line, strings.Join(trees[nodeid], "\n"))
			}
		}
	}
}

// The second-model review's probes of a running program (testdata/probe/cmd/server), driven
// over one keep-alive connection: work a request waits for is the request's; work it leaves
// running isn't the next request's; a panicking request failed; a loop started at startup is
// background; and when main returns, the program's tail is written.
func TestRecordsTheRunningProbeServer(t *testing.T) {
	out := t.TempDir()
	module, _ := filepath.Abs(filepath.Join("testdata", "probe"))
	recorder, _ := filepath.Abs("..")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	client := &http.Client{Transport: &http.Transport{MaxConnsPerHost: 1}}
	get := func(path string) {
		if response, err := client.Get("http://" + address + path); err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
		}
	}
	drive := func() error {
		for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(50 * time.Millisecond) {
			if conn, err := net.Dial("tcp", address); err == nil {
				conn.Close()
				break
			} else if time.Now().After(deadline) {
				return err
			}
		}
		for _, path := range []string{"/spawn", "/spawnlater", "/slow", "/panic"} {
			get(path)
		}
		time.Sleep(100 * time.Millisecond) // the loop ticks
		get("/quit")
		return nil
	}
	err = RecordProcess(ProcessOptions{
		Options: Options{Module: module, Out: out, Run: "run", RecorderModule: recorder},
		Package: "./cmd/server", Env: []string{"PROBE_ADDR=" + address}, Drive: drive, Output: io.Discard,
	})
	if err != nil {
		t.Fatal(err)
	}

	var manifest struct {
		Scenarios []struct {
			Nodeid  string `json:"nodeid"`
			File    string `json:"file"`
			Outcome string `json:"outcome"`
		} `json:"scenarios"`
	}
	read(t, filepath.Join(out, "run", "manifest.json"), &manifest)
	helpers := map[string]int{}
	ticks := map[string]int{}
	outcomes := map[string]string{}
	for _, s := range manifest.Scenarios {
		name := strings.TrimPrefix(s.Nodeid, "process::")
		outcomes[name] = s.Outcome
		var recorded scenario
		read(t, filepath.Join(out, "run", s.File), &recorded)
		for _, line := range recorded.tree() {
			switch strings.TrimSpace(line) {
			case "work.Helper":
				helpers[name]++
			case "work.Tick":
				ticks[name]++
			}
		}
	}
	if want := map[string]int{"GET /spawn #1": 1, "GET /slow #3": 1, "background": 1}; !reflect.DeepEqual(helpers, want) {
		t.Errorf("Helper calls by scenario %v, want %v (spawnlater's goroutine ran during /slow: it's background)", helpers, want)
	}
	if outcomes["GET /panic #4"] != "failed" {
		t.Errorf("the panicking request is %q, want failed (outcomes %v)", outcomes["GET /panic #4"], outcomes)
	}
	if ticks["background"] == 0 {
		t.Errorf("the loop's ticks after the first request aren't in background: %v", ticks)
	}
}
