// Package app is the composition root: the only place that knows every layer.
package app

import (
	"log/slog"
	"net/http"

	"example.com/shop/internal/orders"
	"example.com/shop/internal/storage"
	"example.com/shop/internal/web"
)

// New wires storage, the orders service and the HTTP adapter into one handler, as main runs it.
func New(logger *slog.Logger) http.Handler {
	repository := storage.NewMemoryRepository()
	service := orders.NewService(repository)
	return web.NewHandler(service, logger)
}
