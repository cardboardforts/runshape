//go:build !windows

package record

import (
	"os"
	"os/exec"
	"syscall"
)

func ownProcessGroup(command *exec.Cmd) { command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// askToFlush sends SIGUSR1: the runtime writes the background scenario and a "flushed" file.
func askToFlush(process *os.Process) { _ = process.Signal(syscall.SIGUSR1) }

func askToTerminate(process *os.Process) { _ = process.Signal(syscall.SIGTERM) }
