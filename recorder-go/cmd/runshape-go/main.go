// Command runshape-go records a Go module for Runshape, its tests or its program running:
//
//	runshape-go record [-out dir] [-run name] <module dir> [packages...]
//	runshape-go run    [-out dir] [-run name] <module dir> <main package> [args...]
//
// run builds and starts the program; send it traffic, then press Ctrl-C: startup is one
// scenario and each HTTP request another. The run is written to <out>/<run> (default
// <module>/.runshape/traces/<time>), latest.json is pointed at it, and the run that was latest
// becomes previous.json, for compare mode.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"time"

	"github.com/cardboardforts/runshape/recorder-go/record"
)

func main() {
	if len(os.Args) < 2 || (os.Args[1] != "record" && os.Args[1] != "run") {
		fmt.Fprintln(os.Stderr, "usage: runshape-go record [-out dir] [-run name] <module dir> [packages...]")
		fmt.Fprintln(os.Stderr, "       runshape-go run    [-out dir] [-run name] <module dir> <main package> [args...]")
		os.Exit(2)
	}
	mode := os.Args[1]
	flags := flag.NewFlagSet(mode, flag.ExitOnError)
	out := flags.String("out", "", "traces directory (default <module>/.runshape/traces)")
	run := flags.String("run", time.Now().Format("20060102-150405"), "the run's directory name")
	_ = flags.Parse(os.Args[2:])
	if flags.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "runshape-go record: name the module directory")
		os.Exit(2)
	}
	module := fromInvocation(flags.Arg(0))
	if *out == "" {
		*out = filepath.Join(module, ".runshape", "traces")
	}
	*out = fromInvocation(*out)
	options := record.Options{Module: module, Out: *out, Run: *run, RecorderModule: recorderModule()}
	if mode == "record" {
		options.Packages = flags.Args()[1:]
		exitOn(record.Record(options))
	} else {
		if flags.NArg() < 2 {
			fmt.Fprintln(os.Stderr, "runshape-go run: name the main package to run, e.g. ./cmd/shop")
			os.Exit(2)
		}
		exitOn(record.RecordProcess(record.ProcessOptions{
			Options: options, Package: flags.Arg(1), Args: flags.Args()[2:], Output: os.Stdout, Drive: untilInterrupted,
		}))
	}
	fmt.Printf("runshape-go: recorded %s in %s\n", module, filepath.Join(*out, *run))
}

// untilInterrupted is the traffic a person sends by hand: it returns at Ctrl-C (or when the
// terminal closes). Later signals are swallowed while the program is stopped, so the recorder
// isn't killed half way and the program left running.
func untilInterrupted() error {
	fmt.Fprintln(os.Stderr, "runshape-go: recording; send the program traffic, then press Ctrl-C to stop")
	interrupted := make(chan os.Signal, 4)
	signal.Notify(interrupted, stopSignals...)
	<-interrupted
	return nil
}

// fromInvocation resolves a path given on the command line. Run through npm (`go -C
// recorder-go run ...`), the working directory is recorder-go: npm's INIT_CWD is where the
// command was typed.
func fromInvocation(path string) string {
	if !filepath.IsAbs(path) {
		if invoked := os.Getenv("INIT_CWD"); invoked != "" {
			path = filepath.Join(invoked, path)
		}
	}
	absolute, err := filepath.Abs(path)
	exitOn(err)
	return absolute
}

// recorderModule is this module's directory, which the recorded copy's go.mod points at.
func recorderModule() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..")
}

func exitOn(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "runshape-go:", err)
		os.Exit(1)
	}
}
