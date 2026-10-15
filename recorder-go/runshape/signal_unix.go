//go:build !windows

package runshape

import (
	"os"
	"os/signal"
	"syscall"
)

// onFlushSignal runs flush on each SIGUSR1: runshape-go sends it before stopping the program.
func onFlushSignal(flush func()) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGUSR1)
	go func() {
		for range signals {
			flush()
		}
	}()
}
