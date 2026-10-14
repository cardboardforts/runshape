// Package runshape is what instrumented Go code calls (see package instrument): it records each
// test's calls, lines and objects as a scenario in trace format version 2
// (docs/trace-format.md), written to $RUNSHAPE_RUN_DIR/scenarios. Without that variable the
// instrumented code runs as written and nothing is recorded.
package runshape

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Limits keep a hot loop from filling a scenario: the per-caller limit drops a caller's later
// calls of one function (counted in recorderErrors), the event cap stops the scenario.
type Limits struct {
	CallsPerCaller    int
	EventsPerScenario int
}

// DefaultLimits match the TypeScript recorder's.
var DefaultLimits = Limits{CallsPerCaller: 50, EventsPerScenario: 500_000}

// TB is the part of *testing.T a scenario needs; the runtime doesn't import testing.
type TB interface {
	Name() string
	Failed() bool
	Skipped() bool
	Cleanup(func())
}

// Table is an instrumented file's function table: the catalog entries as JSON, registered on
// first use. A literal of constants, so it's set before the package initialises.
type Table struct {
	Entries string
	once    sync.Once
	ids     []int
}

type symbol struct {
	Namespace []string `json:"namespace"`
	Container []string `json:"container"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	OwnerType *string  `json:"ownerType"`
}

type functionEntry struct {
	File      string `json:"file"`
	Symbol    symbol `json:"symbol"`
	FirstLine int    `json:"firstLine"`
}

type functionDTO struct {
	Role         string  `json:"role"`
	Symbol       symbol  `json:"symbol"`
	File         *string `json:"file"`
	FirstLine    int     `json:"firstLine"`
	LandmarkKind *string `json:"landmarkKind"`
}

type scenarioFile struct {
	Nodeid         string        `json:"nodeid"`
	Outcome        string        `json:"outcome"`
	DurationUs     int64         `json:"durationUs"`
	Functions      []functionDTO `json:"functions"`
	Events         [][]any       `json:"events"`
	RecorderErrors []string      `json:"recorderErrors"`
}

// notRecorded is the span of a call left out by a limit: nothing under it is recorded either.
const notRecorded = -1

// rootSpan is the test function's own span.
const rootSpan = 0

type callKey struct{ caller, fn int }

type scenarioState struct {
	nodeid    string
	started   time.Time
	thread    uint64
	events    [][]any
	functions []functionDTO
	local     map[int]int
	spanFn    map[int]int
	nextSpan  int
	stacks    map[uint64][]*Frame
	calls     map[callKey]int
	skipped   map[callKey]int
	skipOrder []callKey
	full      bool
	dropped   int
	objects   map[uintptr]int
	lines     map[int]map[int]bool
}

func (s *scenarioState) now() int64 { return time.Since(s.started).Microseconds() }

type recorder struct {
	mu       sync.Mutex
	limits   Limits
	registry []functionEntry
	current  *scenarioState
}

func newRecorder(limits Limits) *recorder { return &recorder{limits: limits} }

var global = newRecorder(DefaultLimits)

// Enter opens a frame for the table's index-th function, called on recv (a pointer receiver, or
// nil).
func Enter(table *Table, index int, recv any) *Frame {
	table.once.Do(func() {
		if table.Entries != "" {
			table.ids = global.functions(table.Entries)
		}
	})
	if index >= len(table.ids) {
		return &Frame{r: global}
	}
	return global.enter(table.ids[index], recv)
}

// Scenario starts recording test t. It finishes in t.Cleanup, registered first so it runs last:
// a failure in the test's own cleanups counts. The function it returns, deferred by the test,
// notes a panic on the way out (the panic carries on).
func Scenario(t TB, file, name string) func() {
	finish := global.scenario(t, file, name)
	panicked := false
	t.Cleanup(func() {
		result := finish()
		if panicked {
			result.Outcome = "failed"
		}
		if directory := os.Getenv("RUNSHAPE_RUN_DIR"); directory != "" {
			write(directory, result)
		}
	})
	return func() {
		if p := recover(); p != nil {
			panicked = true
			panic(p)
		}
	}
}

func (r *recorder) functions(table string) []int {
	var entries []functionEntry
	if err := json.Unmarshal([]byte(table), &entries); err != nil {
		panic(fmt.Sprintf("runshape: bad function table: %v", err))
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]int, len(entries))
	for i, entry := range entries {
		ids[i] = len(r.registry)
		r.registry = append(r.registry, entry)
	}
	return ids
}

func (r *recorder) scenario(t TB, file, name string) func() scenarioFile {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := &scenarioState{
		nodeid: file + "::" + name, started: time.Now(), thread: goroutineID(),
		local: map[int]int{}, spanFn: map[int]int{}, nextSpan: rootSpan + 1,
		stacks: map[uint64][]*Frame{}, calls: map[callKey]int{}, skipped: map[callKey]int{},
		objects: map[uintptr]int{}, lines: map[int]map[int]bool{},
	}
	testFile := file
	root := len(r.registry)
	r.registry = append(r.registry, functionEntry{File: file, Symbol: symbol{
		Namespace: strings.Split(strings.TrimSuffix(file, ".go"), "/"), Container: []string{}, Name: name, Kind: "function",
	}, FirstLine: 1})
	s.functions = append(s.functions, functionDTO{Role: "test", Symbol: r.registry[root].Symbol, File: &testFile, FirstLine: 1})
	s.local[root] = 0
	s.spanFn[rootSpan] = root
	s.events = append(s.events, []any{"P", int64(0), "call"}, []any{"S", int64(0), rootSpan, 0, nil, s.thread, nil})
	r.current = s
	return func() scenarioFile {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.current == s {
			r.current = nil
		}
		duration := s.now()
		s.events = append(s.events, []any{"X", duration, rootSpan})
		outcome := "passed"
		if t.Skipped() {
			outcome = "skipped"
		} else if t.Failed() {
			outcome = "failed"
		}
		return scenarioFile{Nodeid: s.nodeid, Outcome: outcome, DurationUs: duration, Functions: s.functions, Events: s.events, RecorderErrors: r.omissions(s)}
	}
}

// Frame is one call of an instrumented function.
type Frame struct {
	r      *recorder
	s      *scenarioState
	span   int
	fn     int
	thread uint64
	closed bool
	// serving is set on the frame that reported a request (see Request).
	serving bool
}

func (r *recorder) enter(id int, recv any) *Frame {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.current
	if s == nil {
		return &Frame{r: r}
	}
	thread := goroutineID()
	stack := s.stacks[thread]
	parent := rootSpan
	if len(stack) > 0 {
		parent = stack[len(stack)-1].span
	}
	frame := &Frame{r: r, s: s, span: notRecorded, fn: id, thread: thread}
	if parent != notRecorded && r.admits(s, parent, id) {
		frame.span = s.nextSpan
		s.nextSpan++
		s.spanFn[frame.span] = id
		s.events = append(s.events, []any{"S", s.now(), frame.span, r.localIndex(s, id), parent, thread, r.objectOf(s, id, recv)})
	}
	s.stacks[thread] = append(stack, frame)
	return frame
}

// Exit closes the frame; deferred by the instrumented function, so it runs on panics too.
func (f *Frame) Exit() {
	if f.s == nil {
		return
	}
	f.r.mu.Lock()
	defer f.r.mu.Unlock()
	if f.closed {
		return
	}
	f.closed = true
	stack := f.s.stacks[f.thread]
	for i := len(stack) - 1; i >= 0; i-- {
		if stack[i] == f {
			f.s.stacks[f.thread] = append(stack[:i], stack[i+1:]...)
			break
		}
	}
	if f.span != notRecorded {
		f.s.events = append(f.s.events, []any{"X", f.s.now(), f.span})
		delete(f.s.lines, f.span)
	}
}

// Request records the HTTP request a handler serves, on the outermost handler of its call
// stack only: a mux's route handler serves the same request as the ServeHTTP that called it.
func (f *Frame) Request(method, path string) {
	if f.s == nil {
		return
	}
	f.r.mu.Lock()
	defer f.r.mu.Unlock()
	if f.closed || f.span == notRecorded || f.r.current != f.s || f.r.isFull(f.s) {
		return
	}
	for _, outer := range f.s.stacks[f.thread] {
		if outer == f {
			break
		}
		if outer.serving {
			return
		}
	}
	f.serving = true
	f.s.events = append(f.s.events, []any{"Q", f.s.now(), f.span, method, path})
}

// Line records that the function ran line n: once per call. A closure marks its lines through
// the frame of the function that wrote it, on whatever goroutine it runs.
func (f *Frame) Line(n int) {
	if f.s == nil {
		return
	}
	f.r.mu.Lock()
	defer f.r.mu.Unlock()
	if f.closed || f.span == notRecorded || f.r.current != f.s || f.r.isFull(f.s) {
		return
	}
	seen := f.s.lines[f.span]
	if seen == nil {
		seen = map[int]bool{}
		f.s.lines[f.span] = seen
	}
	if seen[n] {
		return
	}
	seen[n] = true
	f.s.events = append(f.s.events, []any{"L", f.span, n})
}

func (r *recorder) admits(s *scenarioState, parent, fn int) bool {
	if r.isFull(s) {
		s.dropped++
		return false
	}
	key := callKey{parent, fn}
	s.calls[key]++
	if s.calls[key] <= r.limits.CallsPerCaller {
		return true
	}
	if s.skipped[key] == 0 {
		s.skipOrder = append(s.skipOrder, key)
	}
	s.skipped[key]++
	return false
}

func (r *recorder) isFull(s *scenarioState) bool {
	if len(s.events) >= r.limits.EventsPerScenario {
		s.full = true
	}
	return s.full
}

func (r *recorder) localIndex(s *scenarioState, id int) int {
	if index, ok := s.local[id]; ok {
		return index
	}
	entry := r.registry[id]
	file := entry.File
	s.local[id] = len(s.functions)
	s.functions = append(s.functions, functionDTO{Role: "source", Symbol: entry.Symbol, File: &file, FirstLine: entry.FirstLine})
	return s.local[id]
}

// objectOf identifies a pointer receiver; its type is the method's owner type in its package.
func (r *recorder) objectOf(s *scenarioState, id int, recv any) any {
	if recv == nil {
		return nil
	}
	value := reflect.ValueOf(recv)
	// Zero-size values all live at one address: they can't be told apart.
	if value.Kind() != reflect.Pointer || value.IsNil() || value.Elem().Type().Size() == 0 {
		return nil
	}
	owner := r.registry[id].Symbol.OwnerType
	if owner == nil {
		return nil
	}
	address := value.Pointer()
	if known, ok := s.objects[address]; ok {
		return known
	}
	object := len(s.objects) + 1
	s.objects[address] = object
	typ := append(append([]string{}, r.registry[id].Symbol.Namespace...), *owner)
	s.events = append(s.events, []any{"O", s.now(), object, typ, nil})
	return object
}

func (r *recorder) omissions(s *scenarioState) []string {
	notes := []string{}
	name := func(id int) string {
		sym := r.registry[id].Symbol
		return strings.Join(append(append([]string{}, sym.Container...), sym.Name), ".")
	}
	for _, key := range s.skipOrder {
		notes = append(notes, fmt.Sprintf("%d more calls of %s from %s were not recorded (limit %d per caller)", s.skipped[key], name(key.fn), name(s.spanFn[key.caller]), r.limits.CallsPerCaller))
	}
	if s.full {
		notes = append(notes, fmt.Sprintf("stopped recording after %d events: %d later calls were not recorded", r.limits.EventsPerScenario, s.dropped))
	}
	return notes
}

// goroutineID reads the current goroutine's id from its stack header ("goroutine 18 [running]").
// Go offers no goroutine-local storage; frames carry the id, so this runs once per call.
func goroutineID() uint64 {
	buffer := make([]byte, 64)
	buffer = buffer[:runtime.Stack(buffer, false)]
	buffer = bytes.TrimPrefix(buffer, []byte("goroutine "))
	id, _ := strconv.ParseUint(string(buffer[:bytes.IndexByte(buffer, ' ')]), 10, 64)
	return id
}

func write(directory string, scenario scenarioFile) {
	scenarios := filepath.Join(directory, "scenarios")
	if err := os.MkdirAll(scenarios, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "runshape: %v\n", err)
		return
	}
	data, err := json.Marshal(scenario)
	if err == nil {
		err = os.WriteFile(filepath.Join(scenarios, fmt.Sprintf("%020d-%d.json", time.Now().UnixNano(), os.Getpid())), data, 0o644)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "runshape: writing %s: %v\n", scenario.Nodeid, err)
	}
}
