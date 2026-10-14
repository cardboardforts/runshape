// Package record records a Go module's tests in trace format version 2: it copies the module,
// instruments the copy (package instrument), runs `go test` against the runtime (package
// runshape) and writes the run's manifest beside the scenarios the tests wrote.
package record

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"go/build"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/cardboardforts/runshape/recorder-go/instrument"
)

// RecorderModulePath is this module's path: instrumented code imports its runshape package.
const RecorderModulePath = "github.com/cardboardforts/runshape/recorder-go"

// Version is written to each manifest, so runs from different recorders can be told apart.
const Version = "recorder-go 0.1.0"

// Options for one recording.
type Options struct {
	// Module is the root of the Go module to record (where its go.mod is).
	Module string
	// Out is the traces directory: the run goes in Out/Run, and latest.json points at it.
	Out string
	Run string
	// Packages are go test's package patterns; ./... when empty.
	Packages []string
	// RecorderModule is this module's directory, which the copy's go.mod points at.
	RecorderModule string
}

type catalogEntry = instrument.Function

type problem struct {
	File   string `json:"file"`
	Reason string `json:"reason"`
}

// Record runs the module's tests instrumented. Failing tests are recorded like passing ones;
// a package that doesn't build is named in the manifest's sessionProblems.
func Record(options Options) error {
	run, err := prepare(options)
	if err != nil {
		return err
	}
	defer run.cleanup()
	packages := options.Packages
	if len(packages) == 0 {
		packages = []string{"./..."}
	}
	// One package and one test at a time: the runtime records one scenario at a time.
	test := goCommand(run.work, append([]string{"test", "-json", "-count=1", "-p=1", "-parallel=1"}, packages...)...)
	test.Env = append(os.Environ(), "RUNSHAPE_RUN_DIR="+run.directory)
	var stdout, stderr bytes.Buffer
	test.Stdout, test.Stderr = &stdout, &stderr
	testErr := test.Run()
	sessionProblems, raw := testProblems(stdout.String())
	return run.finish(options, sessionProblems, func() string {
		return fmt.Sprintf("no test was recorded (go test: %v)\n%s%s", testErr, strings.Join(raw, "\n"), stderr.String())
	})
}

// preparedRun is an instrumented copy of the module, and the run directory it records into.
type preparedRun struct {
	work, directory string
	catalog         []catalogEntry
	sources         map[string][]string
	routes          []route
	catalogProblems []problem
	createdAt       string
}

// prepare copies and instruments the module and points the copy at the recorder.
func prepare(options Options) (*preparedRun, error) {
	// Before anything touches the disk: Out/Run is removed and rewritten.
	if run := options.Run; run == "" || run == "." || run == ".." || strings.ContainsAny(run, `/\`) {
		return nil, fmt.Errorf("run name %q must be one directory name", run)
	}
	modulePath, err := modulePathOf(options.Module)
	if err != nil {
		return nil, err
	}
	work, err := os.MkdirTemp("", "runshape-go-")
	if err != nil {
		return nil, err
	}
	run := &preparedRun{work: work, directory: filepath.Join(options.Out, options.Run), createdAt: time.Now().Format(time.RFC3339)}
	fail := func(err error) (*preparedRun, error) { run.cleanup(); return nil, err }
	catalog, sources, http, catalogProblems, err := instrumentCopy(options.Module, work, modulePath)
	if err != nil {
		return fail(err)
	}
	routes, routeProblems := http.resolve()
	run.catalog, run.sources, run.routes, run.catalogProblems = catalog, sources, routes, append(catalogProblems, routeProblems...)
	if err := goCommand(work, "mod", "edit", "-require="+RecorderModulePath+"@v0.0.0", "-replace="+RecorderModulePath+"="+options.RecorderModule).Run(); err != nil {
		return fail(fmt.Errorf("pointing the copy at the recorder: %w", err))
	}
	if err := absoluteReplaces(work, options.Module); err != nil {
		return fail(err)
	}
	if err := os.RemoveAll(run.directory); err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(filepath.Join(run.directory, "scenarios"), 0o755); err != nil {
		return fail(err)
	}
	return run, nil
}

func (run *preparedRun) cleanup() { os.RemoveAll(run.work) }

// finish writes the manifest and makes the run latest. Nothing recorded is a failed recording,
// not an empty one: it says why (nothingRecorded) and leaves latest alone.
func (run *preparedRun) finish(options Options, sessionProblems []string, nothingRecorded func() string) error {
	scenarios, err := scenarioIndex(run.directory)
	if err != nil {
		return err
	}
	if len(scenarios) == 0 {
		return errors.New(nothingRecorded())
	}
	goVersion, _ := goCommand(run.work, "env", "GOVERSION").Output()
	manifest := map[string]any{
		"format": "runshape-trace", "version": 2, "createdAt": run.createdAt,
		"language": "go", "runtime": strings.TrimSpace(string(goVersion)), "recorder": Version, "backend": "instrument",
		"root": options.Module, "framework": frameworkOf(run.routes), "catalog": run.catalog, "sources": run.sources,
		"catalogProblems": run.catalogProblems, "sessionProblems": sessionProblems, "scenarios": scenarios,
	}
	if err := writeJSON(filepath.Join(run.directory, "manifest.json"), manifest); err != nil {
		return err
	}
	return movePointers(options.Out, options.Run)
}

// instrumentCopy copies the module into work, instrumenting the .go files its build compiles.
// Copied as they are: testdata (test inputs, often Go source compared byte for byte), vendor,
// modules nested inside (they're other modules), and files this build excludes.
func instrumentCopy(module, work, modulePath string) ([]catalogEntry, map[string][]string, httpShape, []problem, error) {
	catalog := []catalogEntry{}
	sources := map[string][]string{}
	http := httpShape{}
	problems := []problem{}
	verbatim := []string{}
	err := filepath.WalkDir(module, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(module, path)
		target := filepath.Join(work, relative)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return copySymlink(path, target)
		}
		if entry.IsDir() {
			if relative != "." && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			_, nested := os.Stat(filepath.Join(path, "go.mod"))
			if relative != "." && (nested == nil || entry.Name() == "testdata" || entry.Name() == "vendor") {
				verbatim = append(verbatim, relative+string(filepath.Separator))
			}
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		file := filepath.ToSlash(relative)
		code := src
		copyAsIs := !strings.HasSuffix(file, ".go")
		for _, prefix := range verbatim {
			copyAsIs = copyAsIs || strings.HasPrefix(relative, prefix)
		}
		if !copyAsIs {
			if matched, err := build.Default.MatchFile(filepath.Dir(path), entry.Name()); err != nil || !matched {
				copyAsIs = true
			}
		}
		switch {
		case copyAsIs:
		case strings.HasSuffix(file, "_test.go"):
			if code, err = instrument.InstrumentTest(file, src); err != nil {
				problems = append(problems, problem{file, err.Error()})
				code = src
			}
		case strings.HasSuffix(file, ".go"):
			sources[file] = strings.Split(string(src), "\n")
			pkgPath := modulePath
			if dir := filepath.ToSlash(filepath.Dir(relative)); dir != "." {
				pkgPath += "/" + dir
			}
			result, err := instrument.Instrument(file, pkgPath, src)
			if err != nil {
				problems = append(problems, problem{file, err.Error()})
				break
			}
			code = result.Code
			catalog = append(catalog, result.Functions...)
			http.add(pkgPath, file, result)
		}
		return os.WriteFile(target, code, info.Mode().Perm())
	})
	return catalog, sources, http, problems, err
}

type route struct {
	Methods []string `json:"methods"`
	Path    string   `json:"path"`
	Handler []string `json:"handler"`
}

type registration struct {
	file  string
	route instrument.Route
}

// httpShape is what the source says about HTTP, by package: its handlers and its routes.
type httpShape map[string]*packageHTTP

type packageHTTP struct {
	handlers      []instrument.Symbol
	registrations []registration
}

func (h httpShape) add(pkgPath, file string, result instrument.Result) {
	if h[pkgPath] == nil {
		h[pkgPath] = &packageHTTP{}
	}
	h[pkgPath].handlers = append(h[pkgPath].handlers, result.Handlers...)
	for _, r := range result.Routes {
		h[pkgPath].registrations = append(h[pkgPath].registrations, registration{file, r})
	}
}

// resolve names each route's handler among its package's handlers: a method value by method name,
// a function by function name. One it can't find (another package's, ambiguous) is a problem.
func (h httpShape) resolve() ([]route, []problem) {
	routes := []route{}
	problems := []problem{}
	packages := make([]string, 0, len(h))
	for pkg := range h {
		packages = append(packages, pkg)
	}
	sort.Strings(packages)
	for _, pkg := range packages {
		for _, reg := range h[pkg].registrations {
			// web.Index names package web's function; otherwise the handler is this package's.
			home := pkg
			if reg.route.Package != "" {
				home = reg.route.Package
			}
			var matches []instrument.Symbol
			if shape := h[home]; shape != nil {
				for _, handler := range shape.handlers {
					if handler.Name == reg.route.Handler && (len(handler.Container) == 1) == reg.route.Method {
						matches = append(matches, handler)
					}
				}
			}
			// None: a variable, or a package outside the module (not a problem); several: ambiguous.
			if len(matches) > 1 {
				problems = append(problems, problem{reg.file, fmt.Sprintf("route %q: %d handlers named %s in %s; can't tell which", reg.route.Pattern, len(matches), reg.route.Handler, home)})
			}
			if len(matches) != 1 {
				continue
			}
			methods, path := []string{}, reg.route.Pattern
			if fields := strings.Fields(reg.route.Pattern); len(fields) == 2 && strings.ToUpper(fields[0]) == fields[0] {
				methods, path = []string{fields[0]}, fields[1]
			}
			symbol := matches[0]
			handler := append(append(append([]string{}, symbol.Namespace...), symbol.Container...), symbol.Name)
			routes = append(routes, route{Methods: methods, Path: path, Handler: handler})
		}
	}
	return routes, problems
}

// frameworkOf is the manifest's framework: net/http's routes, when the source registers any.
func frameworkOf(routes []route) any {
	if len(routes) == 0 {
		return nil
	}
	return map[string]any{"framework": "net/http", "entry": "net/http", "middleware": []string{}, "router": nil, "routes": routes, "externals": []any{}}
}

// copySymlink recreates a link in the copy, pointing where the original points.
func copySymlink(path, target string) error {
	destination, err := os.Readlink(path)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(destination) {
		destination = filepath.Join(filepath.Dir(path), destination)
	}
	return os.Symlink(destination, target)
}

// absoluteReplaces points the copy's relative replace directives (../dep, ./sub) where they
// pointed from the original module: the copy lives elsewhere.
func absoluteReplaces(work, module string) error {
	listing, err := goCommand(work, "mod", "edit", "-json").Output()
	if err != nil {
		return fmt.Errorf("reading the copy's go.mod: %w", err)
	}
	var parsed struct {
		Replace []struct {
			Old struct{ Path, Version string }
			New struct{ Path, Version string }
		}
	}
	if err := json.Unmarshal(listing, &parsed); err != nil {
		return err
	}
	for _, replace := range parsed.Replace {
		if !strings.HasPrefix(replace.New.Path, "./") && !strings.HasPrefix(replace.New.Path, "../") {
			continue
		}
		old := replace.Old.Path
		if replace.Old.Version != "" {
			old += "@" + replace.Old.Version
		}
		if err := goCommand(work, "mod", "edit", "-replace="+old+"="+filepath.Join(module, replace.New.Path)).Run(); err != nil {
			return fmt.Errorf("pointing %s at %s: %w", old, replace.New.Path, err)
		}
	}
	return nil
}

var modulePattern = regexp.MustCompile(`(?m)^module\s+(\S+)`)

func modulePathOf(module string) (string, error) {
	data, err := os.ReadFile(filepath.Join(module, "go.mod"))
	if err != nil {
		return "", fmt.Errorf("%s isn't a Go module: %w", module, err)
	}
	match := modulePattern.FindSubmatch(data)
	if match == nil {
		return "", fmt.Errorf("%s/go.mod names no module", module)
	}
	return string(match[1]), nil
}

type scenarioEntry struct {
	Nodeid         string `json:"nodeid"`
	File           string `json:"file"`
	Outcome        string `json:"outcome"`
	DurationUs     int64  `json:"durationUs"`
	EventCount     int    `json:"eventCount"`
	RecorderErrors int    `json:"recorderErrors"`
}

// scenarioIndex lists the scenario files the tests wrote, in the order they ran (their names
// start with the time they were written).
func scenarioIndex(runDirectory string) ([]scenarioEntry, error) {
	entries, err := os.ReadDir(filepath.Join(runDirectory, "scenarios"))
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	index := []scenarioEntry{}
	for _, name := range names {
		var scenario struct {
			Nodeid         string  `json:"nodeid"`
			Outcome        string  `json:"outcome"`
			DurationUs     int64   `json:"durationUs"`
			Events         []any   `json:"events"`
			RecorderErrors []string `json:"recorderErrors"`
		}
		data, err := os.ReadFile(filepath.Join(runDirectory, "scenarios", name))
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, &scenario); err != nil {
			return nil, fmt.Errorf("scenarios/%s: %w", name, err)
		}
		index = append(index, scenarioEntry{scenario.Nodeid, "scenarios/" + name, scenario.Outcome, scenario.DurationUs, len(scenario.Events), len(scenario.RecorderErrors)})
	}
	return index, nil
}

type testEvent struct {
	Action      string
	Package     string
	Test        string
	Output      string
	FailedBuild string
}

// testProblems reads go test -json for tests that are missing from the recording rather than
// removed: packages that didn't build, test binaries a panic stopped, failures outside any test.
// raw holds the lines that weren't JSON (go's own errors).
func testProblems(output string) ([]string, []string) {
	problems := []string{}
	raw := []string{}
	var order []string
	seen := map[string]bool{}
	failed := map[string]bool{}
	testFailed := map[string]bool{}
	panicked := map[string]bool{}
	buildFailed := map[string]bool{}
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		var event testEvent
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			raw = append(raw, scanner.Text())
			continue
		}
		if event.Package != "" && !seen[event.Package] {
			seen[event.Package] = true
			order = append(order, event.Package)
		}
		switch {
		case event.Action == "output" && strings.HasPrefix(event.Output, "panic: "):
			panicked[event.Package] = true
		case event.Action == "fail" && event.Test != "":
			testFailed[event.Package] = true
		case event.Action == "fail" && event.FailedBuild != "":
			buildFailed[event.Package] = true
			failed[event.Package] = true
		case event.Action == "fail":
			failed[event.Package] = true
		}
	}
	for _, pkg := range order {
		switch {
		case buildFailed[pkg]:
			problems = append(problems, fmt.Sprintf("%s: build failed, so none of its tests are in this recording", pkg))
		case panicked[pkg]:
			problems = append(problems, fmt.Sprintf("%s: a test panicked and stopped the test binary, so the tests after it didn't run", pkg))
		case failed[pkg] && !testFailed[pkg]:
			problems = append(problems, fmt.Sprintf("%s: failed outside its tests (TestMain, init or the test binary), so some tests may be missing", pkg))
		}
	}
	return problems, raw
}

// movePointers makes the new run latest, and the run that was latest previous.
func movePointers(out, run string) error {
	latest := filepath.Join(out, "latest.json")
	if data, err := os.ReadFile(latest); err == nil {
		var pointer map[string]string
		if json.Unmarshal(data, &pointer) == nil && pointer["run"] != run {
			if err := os.WriteFile(filepath.Join(out, "previous.json"), data, 0o644); err != nil {
				return err
			}
		}
	}
	return writeJSON(latest, map[string]string{"run": run})
}

func goCommand(dir string, args ...string) *exec.Cmd {
	command := exec.Command("go", args...)
	command.Dir = dir
	return command
}

func writeJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
