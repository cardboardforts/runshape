// Command server is a probe for recording a running program: requests that start goroutines,
// one that panics, a background loop, and a /quit that makes main return.
package main

import (
	"context"
	"net/http"
	"os"
	"sync"
	"time"

	"example.com/probe/work"
)

var (
	quit   = make(chan struct{})
	server = &http.Server{Addr: os.Getenv("PROBE_ADDR")}
)

// spawn waits for the goroutine it starts: that goroutine's work is this request's.
func spawn(w http.ResponseWriter, r *http.Request) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); work.Helper(1) }()
	wg.Wait()
}

// spawnLater returns before its goroutine works: that work belongs to no request.
func spawnLater(w http.ResponseWriter, r *http.Request) {
	go func() { time.Sleep(150 * time.Millisecond); work.Helper(2) }()
}

func slow(w http.ResponseWriter, r *http.Request) {
	time.Sleep(400 * time.Millisecond)
	work.Helper(3)
}

func boom(w http.ResponseWriter, r *http.Request) {
	panic("boom")
}

func stop(w http.ResponseWriter, r *http.Request) {
	close(quit)
	go server.Shutdown(context.Background())
}

func main() {
	go work.Loop(quit)
	mux := http.NewServeMux()
	mux.HandleFunc("/spawn", spawn)
	mux.HandleFunc("/spawnlater", spawnLater)
	mux.HandleFunc("/slow", slow)
	mux.HandleFunc("/panic", boom)
	mux.HandleFunc("/quit", stop)
	server.Handler = mux
	_ = server.ListenAndServe()
}
