package orders

import "fmt"

// Repository is the port the service stores orders through; storage adapters implement it.
type Repository interface {
	Save(order Order) error
	Find(id string) (Order, error)
}

// Placement is the outcome of placing an order: the order, or every reason it was refused.
type Placement struct {
	Order    Order    `json:"order"`
	Valid    bool     `json:"valid"`
	Problems []string `json:"problems,omitempty"`
}

// Service places and looks up orders.
type Service struct {
	repository Repository
	nextID     int
}

// NewService builds a service on a repository.
func NewService(repository Repository) *Service {
	return &Service{repository: repository}
}

// Place validates and stores an order. A refused order is not an error: it's a Placement with
// its problems.
func (s *Service) Place(order Order) (Placement, error) {
	if problems := order.Problems(); len(problems) > 0 {
		return Placement{Order: order, Valid: false, Problems: problems}, nil
	}
	s.nextID++
	order.ID = fmt.Sprintf("ord-%d", s.nextID)
	if err := s.repository.Save(order); err != nil {
		return Placement{}, fmt.Errorf("saving order: %w", err)
	}
	return Placement{Order: order, Valid: true}, nil
}

// Get returns a placed order.
func (s *Service) Get(id string) (Order, error) {
	return s.repository.Find(id)
}
