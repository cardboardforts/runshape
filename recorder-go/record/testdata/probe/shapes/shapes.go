// Package shapes holds the Go constructs the instrumenter has to leave working.
package shapes

import (
	"example.com/dep"
	"example.com/probe/sub"
)

// Color has a String method other files reach during package initialisation.
type Color int

func (c Color) String() string {
	switch c {
	case 1:
		return "red"
	default:
		return "other"
	}
}

// Kind tells values apart with a type switch.
func Kind(v any) string {
	switch v.(type) {
	case int:
		return "int"
	case string:
		return "string"
	}
	return "?"
}

// First takes whichever channel is ready.
func First(a, b chan int) int {
	select {
	case n := <-a:
		return n
	case n := <-b:
		return n
	}
}

// Skip jumps to a label: the labelled line still runs, and is recorded.
func Skip(n int) int {
	if n > 0 {
		goto end
	}
	n = 1
end:
	return n
}

// Marker is an empty method, as interface markers are.
type Marker struct{}

func (m *Marker) Mark() {}

// Elsewhere is reached through other modules.
func Elsewhere() string { return sub.Name() + "x" + string(rune('0'+dep.Double(2))) }
