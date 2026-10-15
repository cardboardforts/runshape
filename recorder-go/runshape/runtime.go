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
	"regexp"
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
	// finished is set once the scenario was written: later events from it are dropped.
	finished bool
	// request is set on a process's request scenario: it ends when its first frame returns.
	request bool
	// panicked is set when a request's handler panicked out of its owner frame.
	panicked bool
}

func (s *scenarioState) now() int64 { return time.Since(s.started).Microseconds() }

type recorder struct {
	mu       sync.Mutex
	limits   Limits
	registry []functionEntry
	current  *scenarioState
	// openIn is the scenario a goroutine has calls open in: only goroutines with open calls.
	openIn map[uint64]*scenarioState
	// known holds goroutines whose creator was looked up (Go never reuses ids).
	known map[uint64]bool

	// Process mode (a running program, not tests): see startProcess.
	process    bool
	sink       func(scenarioFile)
	background *scenarioState
	startedUp  bool
	requests   int
	// mainThread is the program's main goroutine: main.main returning there ends the program.
	mainThread uint64
	flushed    func()
}

func newRecorder(limits Limits) *recorder {
	return &recorder{limits: limits, openIn: map[uint64]*scenarioState{}, known: map[uint64]bool{}}
}

var global = newRecorder(DefaultLimits)

// A running program is recorded when started with RUNSHAPE_PROCESS=1 and RUNSHAPE_RUN_DIR (by
// runshape-go run). SIGUSR1 asks it to write what ran outside requests before it's stopped.
func init() {
	directory := os.Getenv("RUNSHAPE_RUN_DIR")
	if os.Getenv("RUNSHAPE_PROCESS") != "1" || directory == "" {
		return
	}
	global.startProcess(func(s scenarioFile) { write(directory, s) })
	// Tells runshape-go the background is written: it waits for this file.
	global.flushed = func() { _ = os.WriteFile(filepath.Join(directory, "flushed"), nil, 0o644) }
	onFlushSignal(func() {
		global.flush()
		global.flushed()
	})
}

// Enter opens a frame for the table's index-th function, called on recv (a pointer receiver, or
// nil).
func Enter(table *Table, index int, recv any) *Frame {
	return EnterHTTP(table, index, recv, "", "")
}

// EnterHTTP opens a handler's frame: method and path are the request it serves ("" for none).
// The outermost handler on a call stack records the request; in a running program it starts
// the request's own scenario.
func EnterHTTP(table *Table, index int, recv any, method, path string) *Frame {
	table.once.Do(func() {
		if table.Entries != "" {
			table.ids = global.functions(table.Entries)
		}
	})
	if index >= len(table.ids) {
		return &Frame{r: global}
	}
	return global.enterAt(table.ids[index], recv, method, path)
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
	s := r.newScenario(file+"::"+name, file, name, goroutineID())
	r.current = s
	return func() scenarioFile {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.current == s {
			r.current = nil
		}
		outcome := "passed"
		if t.Skipped() {
			outcome = "skipped"
		} else if t.Failed() {
			outcome = "failed"
		}
		return r.finish(s, outcome)
	}
}

// newScenario starts a scenario whose root span is its client: the test, or a running
// program's startup or request. Called with r.mu held.
func (r *recorder) newScenario(nodeid, file, name string, thread uint64) *scenarioState {
	s := &scenarioState{
		nodeid: nodeid, started: time.Now(), thread: thread,
		local: map[int]int{}, spanFn: map[int]int{}, nextSpan: rootSpan + 1,
		stacks: map[uint64][]*Frame{}, calls: map[callKey]int{}, skipped: map[callKey]int{},
		objects: map[uintptr]int{}, lines: map[int]map[int]bool{},
	}
	rootFile := file
	root := len(r.registry)
	r.registry = append(r.registry, functionEntry{File: file, Symbol: symbol{
		Namespace: strings.Split(strings.TrimSuffix(file, ".go"), "/"), Container: []string{}, Name: name, Kind: "function",
	}, FirstLine: 1})
	s.functions = append(s.functions, functionDTO{Role: "test", Symbol: r.registry[root].Symbol, File: &rootFile, FirstLine: 1})
	s.local[root] = 0
	s.spanFn[rootSpan] = root
	s.events = append(s.events, []any{"P", int64(0), "call"}, []any{"S", int64(0), rootSpan, 0, nil, thread, nil})
	return s
}

// finish closes the scenario's root span and returns it to be written. Called with r.mu held.
func (r *recorder) finish(s *scenarioState, outcome string) scenarioFile {
	s.finished = true
	duration := s.now()
	s.events = append(s.events, []any{"X", duration, rootSpan})
	return scenarioFile{Nodeid: s.nodeid, Outcome: outcome, DurationUs: duration, Functions: s.functions, Events: s.events, RecorderErrors: r.omissions(s)}
}

// startProcess records a running program instead of tests. What runs outside any request is
// the startup scenario, written when the first request arrives (then a background scenario,
// written by flush); each request is its own scenario, rooted at its client, written when its
// outermost handler returns. sink receives each finished scenario.
func (r *recorder) startProcess(sink func(scenarioFile)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.process = true
	r.sink = sink
	r.mainThread = goroutineID()
	r.background = r.newScenario("process::startup", "process", "startup", r.mainThread)
}

// flush writes the background scenario, if anything ran in it: a running program has no end
// to wait for, so the recorder asks (SIGUSR1) before stopping it.
func (r *recorder) flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.flushLocked()
}

func (r *recorder) flushLocked() {
	if !r.process || r.background == nil || r.background.nextSpan == rootSpan+1 {
		return
	}
	r.sink(r.finish(r.background, "passed"))
	r.background = r.newScenario("process::background", "process", "background", r.background.thread)
}

// Frame is one call of an instrumented function.
type Frame struct {
	r      *recorder
	s      *scenarioState
	span   int
	fn     int
	thread uint64
	closed bool
	// serving is set on the frame that recorded a request.
	serving bool
	// owner is set on a request scenario's first frame: when it returns, the request is done.
	owner bool
}

func (r *recorder) enter(id int, recv any) *Frame { return r.enterAt(id, recv, "", "") }

func (r *recorder) enterHTTP(id int, recv any, method, path string) *Frame {
	return r.enterAt(id, recv, method, path)
}

func (r *recorder) enterAt(id int, recv any, method, path string) *Frame {
	r.mu.Lock()
	defer r.mu.Unlock()
	thread := goroutineID()
	s, parent, owner := r.place(thread, method, path)
	if s == nil {
		return &Frame{r: r}
	}
	stack := s.stacks[thread]
	frame := &Frame{r: r, s: s, span: notRecorded, fn: id, thread: thread, owner: owner}
	if parent != notRecorded && r.admits(s, parent, id) {
		frame.span = s.nextSpan
		s.nextSpan++
		s.spanFn[frame.span] = id
		s.events = append(s.events, []any{"S", s.now(), frame.span, r.localIndex(s, id), parent, thread, r.objectOf(s, id, recv)})
		if method != "" && !serving(stack) {
			frame.serving = true
			s.events = append(s.events, []any{"Q", s.now(), frame.span, method, path})
		}
	}
	if len(stack) == 0 {
		r.openIn[thread] = s
	}
	s.stacks[thread] = append(stack, frame)
	return frame
}

// place is the scenario a call on this goroutine goes in, its caller's span, and whether the
// call starts a request scenario of its own. Called with r.mu held.
func (r *recorder) place(thread uint64, method, path string) (*scenarioState, int, bool) {
	// Calls under a recorded call belong where it does; in a running program, a call under a
	// frame of a scenario already written (a loop started at startup, work a finished request
	// left running) is background work.
	if open := r.openIn[thread]; open != nil && len(open.stacks[thread]) > 0 {
		if open.finished && r.process {
			return r.background, rootSpan, false
		}
		frames := open.stacks[thread]
		return open, frames[len(frames)-1].span, false
	}
	if r.process {
		if method != "" {
			return r.startRequest(thread, method, path), rootSpan, true
		}
		if !r.known[thread] {
			r.known[thread] = true
			if creator, function, ok := goroutineCreator(); ok {
				if cs := r.openIn[creator]; cs != nil && !cs.finished {
					if frame := r.creatorFrame(cs.stacks[creator], function); frame != nil {
						return cs, frame.span, false
					}
				}
			}
		}
		return r.background, rootSpan, false
	}
	if r.current == nil {
		return nil, 0, false
	}
	return r.current, r.outermostParent(r.current, thread), false
}

// startRequest begins a request's scenario; the first one also ends startup. With r.mu held.
func (r *recorder) startRequest(thread uint64, method, path string) *scenarioState {
	if !r.startedUp {
		r.startedUp = true
		r.sink(r.finish(r.background, "passed"))
		r.background = r.newScenario("process::background", "process", "background", r.background.thread)
	}
	r.requests++
	s := r.newScenario(fmt.Sprintf("process::%s %s #%d", method, path, r.requests), "process", method+" "+path, thread)
	s.request = true
	return s
}

// serving reports whether a frame on the stack already records a request.
func serving(stack []*Frame) bool {
	for _, frame := range stack {
		if frame.serving {
			return true
		}
	}
	return false
}

// Exit closes the frame; deferred by the instrumented function, so it runs on panics too. A
// request's handler panicking marks its scenario failed; the panic carries on (http.Server
// recovers it, as it would have).
func (f *Frame) Exit() {
	if f.s == nil {
		return
	}
	if f.owner {
		if p := recover(); p != nil {
			f.r.mu.Lock()
			f.s.panicked = true
			f.r.mu.Unlock()
			defer panic(p)
		}
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
	if len(f.s.stacks[f.thread]) == 0 && f.r.openIn[f.thread] == f.s {
		delete(f.r.openIn, f.thread)
	}
	if f.span != notRecorded {
		f.s.events = append(f.s.events, []any{"X", f.s.now(), f.span})
		delete(f.s.lines, f.span)
	}
	if f.owner && !f.s.finished {
		outcome := "passed"
		if f.s.panicked {
			outcome = "failed"
		}
		f.r.sink(f.r.finish(f.s, outcome))
	}
	// main returning (or panicking) ends the program: write what ran outside requests now.
	if f.r.process && f.thread == f.r.mainThread {
		if sym := f.r.registry[f.fn].Symbol; sym.Name == "main" && len(sym.Container) == 0 {
			f.r.flushLocked()
			if f.r.flushed != nil {
				f.r.flushed()
			}
		}
	}
}

// Line records that the function ran line n: once per call. A closure marks its lines through
// the frame of the function that wrote it, on whatever goroutine it runs.
func (f *Frame) Line(n int) {
	if f.s == nil {
		return
	}
	f.r.mu.Lock()
	defer f.r.mu.Unlock()
	if f.closed || f.span == notRecorded || f.s.finished || f.r.isFull(f.s) {
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

// outermostParent is the caller, in a test, of a call with nothing recorded under it on its
// goroutine (a call continuing work an earlier test started is placed with that test: see
// place).
//   - On a goroutine's first recorded call ever: what its creator is running, the span that
//     handed it the work, when the creator is running recorded code.
//   - Otherwise the test: new work on a long-lived goroutine (a shared server, a worker pool)
//     belongs to the test it's done in.
func (r *recorder) outermostParent(s *scenarioState, thread uint64) int {
	if thread == s.thread || r.known[thread] {
		return rootSpan
	}
	r.known[thread] = true
	creator, function, ok := goroutineCreator()
	if !ok {
		return rootSpan
	}
	if frame := r.creatorFrame(s.stacks[creator], function); frame != nil {
		return frame.span
	}
	return rootSpan
}

// creatorFrame is the open frame of the function whose go statement created a goroutine (its
// "created by" name, with closures' .funcN taken off), or nil when that call has returned (or
// isn't recorded): the goroutine's work isn't part of whatever its creator does next.
func (r *recorder) creatorFrame(frames []*Frame, function string) *Frame {
	base := goWrapper.ReplaceAllString(function, "")
	for i := len(frames) - 1; i >= 0; i-- {
		sym := r.registry[frames[i].fn].Symbol
		if !strings.HasSuffix(base, "."+sym.Name) {
			continue
		}
		if owner := sym.OwnerType; owner != nil && !strings.Contains(base, *owner+").") && !strings.Contains(base, "."+*owner+".") {
			continue
		}
		return frames[i]
	}
	return nil
}

// goWrapper matches what Go appends to the name of a closure or go-statement wrapper.
var goWrapper = regexp.MustCompile(`(\.(func|gowrap)\d+)+$`)

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

// createdBy is the line a goroutine's stack ends with: "created by main.f in goroutine 7".
var createdBy = regexp.MustCompile(`created by (\S+) in goroutine (\d+)`)

// goroutineCreator is the id of the goroutine that created the current one, read on a
// goroutine's first recorded call only. The line is last, so the buffer grows until it fits.
func goroutineCreator() (uint64, string, bool) {
	var buffer []byte
	for size := 16 * 1024; size <= 4*1024*1024; size *= 4 {
		buffer = make([]byte, size)
		n := runtime.Stack(buffer, false)
		if n < size {
			buffer = buffer[:n]
			break
		}
	}
	match := createdBy.FindSubmatch(buffer)
	if match == nil {
		return 0, "", false
	}
	id, err := strconv.ParseUint(string(match[2]), 10, 64)
	return id, string(match[1]), err == nil
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
