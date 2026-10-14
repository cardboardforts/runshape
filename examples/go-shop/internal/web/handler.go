// Package web is the HTTP adapter: it turns requests into calls on the orders service.
package web

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"example.com/shop/internal/orders"
)

// Handler serves the orders API.
type Handler struct {
	service *orders.Service
	logger  *slog.Logger
	mux     *http.ServeMux
}

// NewHandler routes the API onto a service.
func NewHandler(service *orders.Service, logger *slog.Logger) *Handler {
	h := &Handler{service: service, logger: logger, mux: http.NewServeMux()}
	h.mux.HandleFunc("POST /orders", h.placeOrder)
	h.mux.HandleFunc("GET /orders/{id}", h.getOrder)
	return h
}

var requestCount atomic.Int64

// ServeHTTP gives every request a correlation id and logs it on the way in and out.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id := r.Header.Get("X-Request-ID")
	if id == "" {
		id = "req-" + strconv.FormatInt(requestCount.Add(1), 10)
	}
	started := time.Now()
	h.logger.Info("request received", "request_id", id, "method", r.Method, "path", r.URL.Path)
	recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	recorder.Header().Set("X-Request-ID", id)
	h.mux.ServeHTTP(recorder, r)
	h.logger.Info("request completed", "request_id", id, "status", recorder.status, "duration_ms", time.Since(started).Milliseconds())
}

func (h *Handler) placeOrder(w http.ResponseWriter, r *http.Request) {
	var order orders.Order
	if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "malformed order: " + err.Error()})
		return
	}
	placement, err := h.service.Place(order)
	if err != nil {
		h.logger.Error("placing order failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, placement)
}

func (h *Handler) getOrder(w http.ResponseWriter, r *http.Request) {
	order, err := h.service.Get(r.PathValue("id"))
	if errors.Is(err, orders.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"order": order, "totalCents": order.TotalCents()})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(status int) {
	s.status = status
	s.ResponseWriter.WriteHeader(status)
}
