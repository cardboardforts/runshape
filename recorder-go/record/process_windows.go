package record

import (
	"os"
	"os/exec"
)

// RecordProcess refuses to run on Windows before these are reached; they exist so it builds.
func ownProcessGroup(command *exec.Cmd)  {}
func askToFlush(process *os.Process)     {}
func askToTerminate(process *os.Process) { _ = process.Kill() }
