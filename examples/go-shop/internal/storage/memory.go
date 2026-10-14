// Package storage holds the repositories the domain stores orders through.
package storage

import (
	"sync"

	"example.com/shop/internal/orders"
)

// MemoryRepository keeps orders in memory; it implements orders.Repository.
type MemoryRepository struct {
	mu     sync.Mutex
	orders map[string]orders.Order
}

// NewMemoryRepository builds an empty repository.
func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{orders: map[string]orders.Order{}}
}

// Save stores an order under its id.
func (r *MemoryRepository) Save(order orders.Order) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.orders[order.ID] = order
	return nil
}

// Find returns the order with that id, or orders.ErrNotFound.
func (r *MemoryRepository) Find(id string) (orders.Order, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	order, ok := r.orders[id]
	if !ok {
		return orders.Order{}, orders.ErrNotFound
	}
	return order, nil
}
