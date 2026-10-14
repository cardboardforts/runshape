package shapes

import (
	"os"
	"strings"
	"testing"
)

func TestShapes(t *testing.T) {
	if Greeting != "red" {
		t.Errorf("Greeting %q", Greeting)
	}
	if Kind(1) != "int" || Kind("a") != "string" || Skip(5) != 5 || Skip(0) != 1 {
		t.Error("shapes")
	}
	a, b := make(chan int, 1), make(chan int, 1)
	b <- 7
	if First(a, b) != 7 {
		t.Error("select")
	}
	(&Marker{}).Mark()
	(&Marker{}).Mark()
	if Elsewhere() != "subx4" {
		t.Errorf("elsewhere %q", Elsewhere())
	}
}

func TestGoldenFileIsUntouched(t *testing.T) {
	data, err := os.ReadFile("testdata/golden.go")
	if err != nil || strings.Contains(string(data), "__rs") {
		t.Errorf("testdata was rewritten: %s %v", data, err)
	}
}

func TestCleanupFails(t *testing.T) {
	t.Cleanup(func() { t.Error("failed in cleanup") })
}

func TestPanics(t *testing.T) {
	panic("boom")
}

func TestAfterThePanic(t *testing.T) {}
