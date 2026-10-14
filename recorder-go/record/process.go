package record

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
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
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()

	driveErr := options.Drive()
	stopProblems := stop(command, run.directory, exited)
	if driveErr != nil {
		stopProblems = append(stopProblems, "sending traffic: "+driveErr.Error())
	}
	return run.finish(options.Options, stopProblems, func() string {
		return fmt.Sprintf("nothing was recorded from %s (%v)", options.Package, driveErr)
	})
}

// stop asks the program to write its background scenario (SIGUSR1, answered with a "flushed"
// file), then stops it (SIGTERM, then SIGKILL). What went wrong is a session problem.
func stop(command *exec.Cmd, directory string, exited chan error) []string {
	problems := []string{}
	select {
	case err := <-exited:
		return append(problems, fmt.Sprintf("the program exited before it was stopped: %v", err))
	default:
	}
	flushed := filepath.Join(directory, "flushed")
	_ = command.Process.Signal(syscall.SIGUSR1)
	deadline := time.Now().Add(flushWait)
	for {
		if _, err := os.Stat(flushed); err == nil {
			_ = os.Remove(flushed)
			break
		}
		if time.Now().After(deadline) {
			problems = append(problems, "the program didn't write what ran outside requests before it was stopped")
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = command.Process.Signal(syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(flushWait):
		_ = command.Process.Kill()
		<-exited
	}
	return problems
}
