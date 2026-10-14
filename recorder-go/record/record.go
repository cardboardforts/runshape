// Package record records a Go module's tests in trace format version 2: it copies the module,
// instruments the copy (package instrument), runs `go test` against the runtime (package
// runshape) and writes the run's manifest beside the scenarios the tests wrote.
package record

import (
	"bufio"
	"encoding/json"
	"fmt"
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
	modulePath, err := modulePathOf(options.Module)
	if err != nil {
		return err
	}
	work, err := os.MkdirTemp("", "runshape-go-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	catalog, sources, catalogProblems, err := instrumentCopy(options.Module, work, modulePath)
	if err != nil {
		return err
	}
	if err := goCommand(work, "mod", "edit", "-require="+RecorderModulePath+"@v0.0.0", "-replace="+RecorderModulePath+"="+options.RecorderModule).Run(); err != nil {
		return fmt.Errorf("pointing the copy at the recorder: %w", err)
	}

	runDirectory := filepath.Join(options.Out, options.Run)
	if err := os.RemoveAll(runDirectory); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(runDirectory, "scenarios"), 0o755); err != nil {
		return err
	}
	createdAt := time.Now().Format(time.RFC3339)
	packages := options.Packages
	if len(packages) == 0 {
		packages = []string{"./..."}
	}
	// One package and one test at a time: the runtime records one scenario at a time.
	test := goCommand(work, append([]string{"test", "-count=1", "-p=1", "-parallel=1"}, packages...)...)
	test.Env = append(os.Environ(), "RUNSHAPE_RUN_DIR="+runDirectory)
	output, _ := test.CombinedOutput()

	scenarios, err := scenarioIndex(runDirectory)
	if err != nil {
		return err
	}
	sessionProblems := failedPackages(string(output))
	if len(scenarios) == 0 && len(sessionProblems) > 0 {
		return fmt.Errorf("no test ran:\n%s", output)
	}
	goVersion, _ := goCommand(work, "env", "GOVERSION").Output()

	manifest := map[string]any{
		"format": "runshape-trace", "version": 2, "createdAt": createdAt,
		"language": "go", "runtime": strings.TrimSpace(string(goVersion)), "recorder": Version, "backend": "instrument",
		"root": options.Module, "framework": nil, "catalog": catalog, "sources": sources,
		"catalogProblems": catalogProblems, "sessionProblems": sessionProblems, "scenarios": scenarios,
	}
	if err := writeJSON(filepath.Join(runDirectory, "manifest.json"), manifest); err != nil {
		return err
	}
	return movePointers(options.Out, options.Run)
}

// instrumentCopy copies the module into work, instrumenting .go files on the way.
func instrumentCopy(module, work, modulePath string) ([]catalogEntry, map[string][]string, []problem, error) {
	catalog := []catalogEntry{}
	sources := map[string][]string{}
	problems := []problem{}
	err := filepath.WalkDir(module, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(module, path)
		if entry.IsDir() {
			if relative != "." && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "vendor" || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(work, relative), 0o755)
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		file := filepath.ToSlash(relative)
		code := src
		switch {
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
		}
		return os.WriteFile(filepath.Join(work, relative), code, 0o644)
	})
	return catalog, sources, problems, err
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

var failedPattern = regexp.MustCompile(`^FAIL\s+(\S+)\s+\[(build failed|setup failed)\]`)

// failedPackages names packages whose tests never ran: their tests are missing, not removed.
func failedPackages(output string) []string {
	problems := []string{}
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		if match := failedPattern.FindStringSubmatch(scanner.Text()); match != nil {
			problems = append(problems, fmt.Sprintf("%s: %s, so none of its tests are in this recording", match[1], match[2]))
		}
	}
	return problems
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
