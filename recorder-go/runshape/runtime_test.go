package runshape

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// The runtime is what instrumented code calls: Enter and Exit around each function, Line for
// each statement, Scenario around each test. These tests call it as instrumented code would.

type fakeT struct{ failed bool }

func (f fakeT) Name() string   { return "TestSample" }
func (f fakeT) Failed() bool   { return f.failed }
func (f fakeT) Skipped() bool  { return false }
func (f fakeT) Cleanup(func()) {}

type service struct{ calls int }

const table = `[
 {"file":"svc.go","symbol":{"namespace":["example.com","shop"],"container":["Service"],"name":"Place","kind":"method","ownerType":"Service"},"firstLine":10},
 {"file":"svc.go","symbol":{"namespace":["example.com","shop"],"container":[],"name":"check","kind":"function","ownerType":null},"firstLine":20},
 {"file":"svc.go","symbol":{"namespace":["example.com","shop"],"container":[],"name":"work","kind":"function","ownerType":null},"firstLine":30}
]`

// describe renders a scenario as a call tree with each span's lines, then its objects.
func describe(s scenarioFile) []string {
	depth := map[int]int{}
	lines := map[int][]int{}
	objects := map[int]string{}
	for _, e := range s.Events {
		if e[0] == "L" {
			lines[num(e[1])] = append(lines[num(e[1])], num(e[2]))
		}
		if e[0] == "O" {
			segments := e[3].([]string)
			objects[num(e[2])] = fmt.Sprintf("%s#%d", segments[len(segments)-1], num(e[2]))
		}
	}
	var out []string
	for _, e := range s.Events {
		if e[0] != "S" {
			continue
		}
		span, fn := num(e[2]), num(e[3])
		if e[4] == nil {
			depth[span] = 0
		} else {
			depth[span] = depth[num(e[4])] + 1
		}
		on := ""
		if e[6] != nil {
			on = " on " + objects[num(e[6])]
		}
		name := strings.Join(append(append([]string{}, s.Functions[fn].Symbol.Container...), s.Functions[fn].Symbol.Name), ".")
		out = append(out, fmt.Sprintf("%s%s%s %v thread=%v", strings.Repeat("  ", depth[span]), name, on, lines[span], e[5] != s.Events[1][5]))
	}
	return out
}

func num(v any) int { return int(reflect.ValueOf(v).Int()) }

func TestRecordsTheCallTreeObjectsAndClosuresLines(t *testing.T) {
	r := newRecorder(Limits{CallsPerCaller: 2, EventsPerScenario: 1000})
	ids := r.functions(table)
	finish := r.scenario(fakeT{}, "svc_test.go", "TestSample")
	svc := &service{}

	place := func() {
		f := r.enter(ids[0], svc)
		defer f.Exit()
		f.Line(11)
		visit := func() { f.Line(12) } // a closure: its line is Place's, whoever runs it
		for i := 0; i < 3; i++ {
			c := r.enter(ids[1], nil)
			c.Line(21)
			c.Exit()
		}
		var wg sync.WaitGroup
		wg.Add(1)
		go func() { // another goroutine: its own stack, not this one's
			defer wg.Done()
			visit()
			g := r.enter(ids[2], nil)
			g.Exit()
		}()
		wg.Wait()
	}
	place()
	place()

	got := finish()
	want := []string{
		"TestSample [] thread=false",
		"  Service.Place on Service#1 [11 12] thread=false",
		"    check [21] thread=false",
		"    check [21] thread=false",
		// The goroutine was started by the test's closure, not by a recorded function, so it
		// hangs off the test (record_test's probe server shows a handler's goroutine under it).
		"  work [] thread=true",
		"  Service.Place on Service#1 [11 12] thread=false",
		"    check [21] thread=false",
		"    check [21] thread=false",
		"  work [] thread=true",
	}
	if lines := describe(got); !reflect.DeepEqual(lines, want) {
		t.Errorf("tree:\n got %q\nwant %q", lines, want)
	}
	if !reflect.DeepEqual(got.RecorderErrors, []string{
		"1 more calls of check from Service.Place were not recorded (limit 2 per caller)",
		"1 more calls of check from Service.Place were not recorded (limit 2 per caller)",
	}) {
		t.Errorf("errors %q", got.RecorderErrors)
	}
	if got.Outcome != "passed" || got.Nodeid != "svc_test.go::TestSample" {
		t.Errorf("outcome %q nodeid %q", got.Outcome, got.Nodeid)
	}
}

func TestOutsideAScenarioNothingIsRecorded(t *testing.T) {
	r := newRecorder(DefaultLimits)
	ids := r.functions(table)
	f := r.enter(ids[0], nil)
	f.Line(11)
	f.Exit()
}

func TestOnlyTheOutermostHandlerReportsTheRequest(t *testing.T) {
	r := newRecorder(DefaultLimits)
	ids := r.functions(table)
	finish := r.scenario(fakeT{}, "svc_test.go", "TestSample")

	serve := r.enterHTTP(ids[0], nil, "POST", "/orders")
	route := r.enterHTTP(ids[1], nil, "POST", "/orders") // the route's handler, called by the mux inside serve
	route.Exit()
	serve.Exit()

	var requests []string
	for _, e := range finish().Events {
		if e[0] == "Q" {
			requests = append(requests, fmt.Sprintf("span %v: %v %v", e[2], e[3], e[4]))
		}
	}
	if want := []string{"span 1: POST /orders"}; !reflect.DeepEqual(requests, want) {
		t.Errorf("requests %q, want %q", requests, want)
	}
}

func TestWorkATestLeftRunningIsNotRecordedInTheNextTest(t *testing.T) {
	r := newRecorder(DefaultLimits)
	ids := r.functions(table)
	finishFirst := r.scenario(fakeT{}, "svc_test.go", "TestFirst")
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() { // left running by TestFirst
		f := r.enter(ids[0], nil)
		close(started)
		<-release
		g := r.enter(ids[1], nil) // called after TestFirst ended, while TestSecond runs
		g.Exit()
		f.Exit()
		late := r.enter(ids[1], nil) // and a fresh call on it, with nothing on its stack
		late.Exit()
		close(done)
	}()
	<-started
	finishFirst()

	finishSecond := r.scenario(fakeT{}, "svc_test.go", "TestSecond")
	close(release)
	<-done
	second := finishSecond()

	// g continues work TestFirst started (f is still open): not TestSecond's. The later call
	// is new work on that goroutine, done during TestSecond: it's TestSecond's.
	if lines := describe(second); !reflect.DeepEqual(lines, []string{"TestSecond [] thread=false", "  check [] thread=true"}) {
		t.Errorf("TestSecond recorded %q", lines)
	}
}

func TestALongLivedGoroutineWorksForEveryTestThatUsesIt(t *testing.T) {
	// A worker started once (a shared test server, a pool behind sync.Once) serves later tests.
	r := newRecorder(DefaultLimits)
	ids := r.functions(table)
	jobs, done := make(chan struct{}), make(chan struct{})
	go func() {
		for range jobs {
			f := r.enter(ids[2], nil)
			f.Exit()
			done <- struct{}{}
		}
	}()
	var recorded [][]string
	for _, name := range []string{"TestOne", "TestTwo"} {
		finish := r.scenario(fakeT{}, "svc_test.go", name)
		jobs <- struct{}{}
		<-done
		recorded = append(recorded, describe(finish()))
	}
	close(jobs)

	if want := [][]string{{"TestOne [] thread=false", "  work [] thread=true"}, {"TestTwo [] thread=false", "  work [] thread=true"}}; !reflect.DeepEqual(recorded, want) {
		t.Errorf("recorded %q, want %q", recorded, want)
	}
}

// A running program, not a test (process mode): what runs outside any request is the startup
// scenario, and each request is a scenario of its own, rooted at its client, even when requests
// overlap. A request's scenario is written when its outermost handler returns.
func TestAProcessRecordsStartupAndEachRequest(t *testing.T) {
	var written []scenarioFile
	var mu sync.Mutex
	r := newRecorder(DefaultLimits)
	r.startProcess(func(s scenarioFile) { mu.Lock(); written = append(written, s); mu.Unlock() })
	ids := r.functions(table)

	boot := r.enter(ids[0], nil) // main wiring the app
	boot.Exit()

	var wg sync.WaitGroup
	inside := make(chan struct{})
	for _, path := range []string{"/orders", "/orders/1"} {
		wg.Add(1)
		go func(path string) {
			defer wg.Done()
			serve := r.enterHTTP(ids[0], nil, "GET", path)
			inside <- struct{}{} // both requests are open at once
			work := r.enter(ids[2], nil)
			work.Exit()
			serve.Exit()
		}(path)
	}
	<-inside
	<-inside
	wg.Wait()
	r.flush()

	mu.Lock()
	defer mu.Unlock()
	var got []string
	for _, s := range written {
		got = append(got, fmt.Sprintf("%s: %q", s.Nodeid, describe(s)))
	}
	sort.Strings(got)
	want := []string{
		`process::GET /orders #1: ["GET /orders [] thread=false" "  Service.Place [] thread=false" "    work [] thread=false"]`,
		`process::GET /orders/1 #2: ["GET /orders/1 [] thread=false" "  Service.Place [] thread=false" "    work [] thread=false"]`,
		`process::startup: ["startup [] thread=false" "  Service.Place [] thread=false"]`,
	}
	// Which request got #1 depends on scheduling; the shapes don't.
	for i := range got {
		got[i] = strings.Replace(strings.Replace(got[i], "#2", "#n", 1), "#1", "#n", 1)
		want[i] = strings.Replace(strings.Replace(want[i], "#2", "#n", 1), "#1", "#n", 1)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("written:\n got %q\nwant %q", got, want)
	}
}
