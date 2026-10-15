// Package work is what the probe server's handlers and background loop call.
package work

import "time"

// Helper is called from goroutines requests start.
func Helper(n int) int { return n * 2 }

// Tick is the background loop's work.
func Tick() int { return 1 }

// Loop ticks until quit is closed: started during startup, it outlives every request.
func Loop(quit chan struct{}) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-quit:
			return
		case <-ticker.C:
			Tick()
		}
	}
}
