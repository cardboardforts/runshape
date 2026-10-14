package server

import (
	"net/http/httptest"
	"testing"
)

// A handler may be called with no request at all: recording must not change that.
func TestANilRequestIsServed(t *testing.T) {
	Index(httptest.NewRecorder(), nil)
}
