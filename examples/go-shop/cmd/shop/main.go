// Command shop serves the orders API.
package main

import (
	"log/slog"
	"net/http"
	"os"

	"example.com/shop/internal/app"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "shop")
	address := os.Getenv("SHOP_ADDR")
	if address == "" {
		address = ":8080"
	}
	logger.Info("starting", "address", address)
	if err := http.ListenAndServe(address, app.New(logger)); err != nil {
		logger.Error("stopped", "error", err)
		os.Exit(1)
	}
}
