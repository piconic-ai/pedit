//go:build !darwin && !linux

package hoststate

type Store struct{}

func Open(string) (*Store, error)                 { return nil, ErrUnavailable }
func (s *Store) Load(string) (Credentials, error) { return Credentials{}, ErrUnavailable }
func (s *Store) Save(Credentials) error           { return ErrUnavailable }
func (s *Store) Close() error                     { return nil }
