// Package wiring registers another package's handler, and has a method of the same name.
package wiring

import (
	"net/http"

	"example.com/probe/server"
)

type Wiring struct{}

func (w *Wiring) Index(rw http.ResponseWriter, r *http.Request) {}

func Routes(mux *http.ServeMux) {
	mux.HandleFunc("/index", server.Index)
}
