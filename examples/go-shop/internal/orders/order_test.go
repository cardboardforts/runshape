package orders

import "testing"

func TestTotalAddsEveryItem(t *testing.T) {
	order := Order{Items: []Item{{SKU: "tea", Quantity: 2, PriceCents: 350}, {SKU: "cake", Quantity: 1, PriceCents: 425}}}
	if got := order.TotalCents(); got != 1125 {
		t.Fatalf("total %d", got)
	}
}
