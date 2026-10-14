// Package orders is the domain: orders, the rules for placing them, and the port to store them.
package orders

import (
	"errors"
	"fmt"
)

// Item is one line of an order.
type Item struct {
	SKU      string `json:"sku"`
	Quantity int    `json:"quantity"`
	// PriceCents avoids float rounding in totals.
	PriceCents int `json:"priceCents"`
}

// Order is what a customer placed.
type Order struct {
	ID       string `json:"id"`
	Customer string `json:"customer"`
	Items    []Item `json:"items"`
}

// MaxQuantity is the most of one SKU a single order may hold.
const MaxQuantity = 100

// ErrNotFound is returned for an order id nobody placed.
var ErrNotFound = errors.New("order not found")

// TotalCents is what the order costs.
func (o Order) TotalCents() int {
	total := 0
	for _, item := range o.Items {
		total += item.Quantity * item.PriceCents
	}
	return total
}

// Problems lists everything wrong with the order, not just the first thing.
func (o Order) Problems() []string {
	var problems []string
	if o.Customer == "" {
		problems = append(problems, "customer is required")
	}
	if len(o.Items) == 0 {
		problems = append(problems, "an order needs at least one item")
	}
	for i, item := range o.Items {
		if item.Quantity < 1 || item.Quantity > MaxQuantity {
			problems = append(problems, fmt.Sprintf("item %d: quantity must be 1 to %d", i, MaxQuantity))
		}
		if item.PriceCents < 0 {
			problems = append(problems, fmt.Sprintf("item %d: price can't be negative", i))
		}
	}
	return problems
}
