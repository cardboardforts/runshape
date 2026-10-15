package record

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ProcessOptions record a running program instead of tests (see RecordProcess).
type ProcessOptions struct {
	Options
	// Package is the main package to build and run, as go build names it (./cmd/shop).
	Package string
	Args    []string
	// Env is added to the program's environment.
	Env []string
	// Drive sends the program its traffic and returns when done; the program is stopped then.
	Drive func() error
	// Output receives the program's stdout and stderr.
	Output io.Writer
}

// flushWait is how long a stopping program gets to write what ran outside requests.
const flushWait = 5 * time.Second

// RecordProcess builds the module's program instrumented, runs it while Drive sends it traffic,
// then stops it. Startup (everything before the first request) is one scenario; each request
// is another, rooted at its client; what ran between requests is a background scenario.
func RecordProcess(options ProcessOptions) error {
	if runtime.GOOS == "windows" {
		return errors.New("recording a running program needs signals Windows doesn't have; record its tests instead")
	}
	run, err := prepare(options.Options)
	if err != nil {
		return err
	}
	defer run.cleanup()
	program := filepath.Join(run.work, "runshape-program")
	if output, err := goCommand(run.work, "build", "-o", program, options.Package).CombinedOutput(); err != nil {
		return fmt.Errorf("building %s: %v\n%s", options.Package, err, output)
	}

	command := exec.Command(program, options.Args...)
	command.Dir = options.Module
	command.Env = append(append(os.Environ(), options.Env...), "RUNSHAPE_PROCESS=1", "RUNSHAPE_RUN_DIR="+run.directory)
	command.Stdout, command.Stderr = options.Output, options.Output
	// Its own process group: Ctrl-C at the terminal stops the recording, not the program.
	ownProcessGroup(command)
	if err := command.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()

	// Until the traffic is done, or the program ends by itself (it crashed, or main returned).
	driven := make(chan error, 1)
	go func() { driven <- options.Drive() }()
	var problems []string
	select {
	case driveErr := <-driven:
		problems = stop(command, run.directory, exited)
		if driveErr != nil {
			problems = append(problems, "sending traffic: "+driveErr.Error())
		}
	case err := <-exited:
		problems = []string{"the program ended by itself: " + exitDescription(err)}
	}
	return run.finish(options.Options, problems, func() string {
		return fmt.Sprintf("nothing was recorded from %s: %s", options.Package, strings.Join(problems, "; "))
	})
}

func exitDescription(err error) string {
	if err == nil {
		return "exit status 0"
	}
	return err.Error()
}

// stop asks the program to write its background scenario (SIGUSR1, answered with a "flushed"
// file), then stops it (SIGTERM, then SIGKILL). What went wrong is a session problem.
func stop(command *exec.Cmd, directory string, exited chan error) []string {
	select {
	case err := <-exited:
		return []string{"the program ended by itself before it was stopped: " + exitDescription(err)}
	default:
	}
	flushed := filepath.Join(directory, "flushed")
	askToFlush(command.Process)
	deadline := time.After(flushWait)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	defer os.Remove(flushed)
	for {
		select {
		case err := <-exited:
			// It ended while flushing: main returning writes the background itself.
			if _, statErr := os.Stat(flushed); statErr == nil {
				return nil
			}
			return []string{"the program ended by itself before it was stopped: " + exitDescription(err)}
		case <-deadline:
			terminate(command.Process, exited)
			return []string{"the program didn't write what ran outside requests before it was stopped"}
		case <-tick.C:
			if _, err := os.Stat(flushed); err == nil {
				terminate(command.Process, exited)
				return nil
			}
		}
	}
}

// terminate stops the program (SIGTERM, then SIGKILL) and waits for it.
func terminate(process *os.Process, exited chan error) {
	askToTerminate(process)
	select {
	case <-exited:
	case <-time.After(flushWait):
		_ = process.Kill()
		<-exited
	}
}
