// Package server holds a handler other packages register.
package server

import "net/http"

func Index(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
