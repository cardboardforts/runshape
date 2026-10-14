// Package e2e drives the shop the way it runs: app.New wires every layer as main does, and each
// test sends real HTTP requests through the router, in process.
package e2e

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/shop/internal/app"
)

func send(t *testing.T, handler http.Handler, method, path, body string) (int, string) {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response.Code, strings.TrimSpace(response.Body.String())
}

func newShop() http.Handler {
	return app.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestPlaceThenFetchAnOrder(t *testing.T) {
	shop := newShop()

	status, body := send(t, shop, "POST", "/orders", `{"customer":"ada","items":[{"sku":"tea","quantity":2,"priceCents":350}]}`)
	if status != http.StatusOK || !strings.Contains(body, `"valid":true`) || !strings.Contains(body, `"id":"ord-1"`) {
		t.Fatalf("placing: %d %s", status, body)
	}
	status, body = send(t, shop, "GET", "/orders/ord-1", "")
	if status != http.StatusOK || !strings.Contains(body, `"totalCents":700`) {
		t.Fatalf("fetching: %d %s", status, body)
	}
}

func TestAnInvalidOrderListsEveryProblem(t *testing.T) {
	status, body := send(t, newShop(), "POST", "/orders", `{"items":[{"sku":"tea","quantity":0,"priceCents":-1}]}`)
	for _, want := range []string{`"valid":false`, "customer is required", "item 0: quantity must be 1 to 100", "item 0: price can't be negative"} {
		if status != http.StatusOK || !strings.Contains(body, want) {
			t.Errorf("want %q in %d %s", want, status, body)
		}
	}
}

func TestAnUnknownOrderIsNotFound(t *testing.T) {
	if status, body := send(t, newShop(), "GET", "/orders/ord-9", ""); status != http.StatusNotFound {
		t.Fatalf("got %d %s", status, body)
	}
}

func TestAMalformedOrderIsRefusedBeforeTheService(t *testing.T) {
	if status, body := send(t, newShop(), "POST", "/orders", `{"customer": 7}`); status != http.StatusUnprocessableEntity {
		t.Fatalf("got %d %s", status, body)
	}
}
