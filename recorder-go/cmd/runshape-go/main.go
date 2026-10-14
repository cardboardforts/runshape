// Command runshape-go records a Go module's tests for Runshape:
//
//	runshape-go record [-out dir] [-run name] <module dir> [packages...]
//
// The run is written to <out>/<run> (default <module>/.runshape/traces/<time>), latest.json is
// pointed at it, and the run that was latest becomes previous.json, for compare mode.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/cardboardforts/runshape/recorder-go/record"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "record" {
		fmt.Fprintln(os.Stderr, "usage: runshape-go record [-out dir] [-run name] <module dir> [packages...]")
		os.Exit(2)
	}
	flags := flag.NewFlagSet("record", flag.ExitOnError)
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
	exitOn(record.Record(record.Options{Module: module, Out: *out, Run: *run, Packages: flags.Args()[1:], RecorderModule: recorderModule()}))
	fmt.Printf("runshape-go: recorded %s in %s\n", module, filepath.Join(*out, *run))
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
