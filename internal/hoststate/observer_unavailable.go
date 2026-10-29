//go:build !darwin

package hoststate

func (s *Store) SaveObserver(string, []byte, []byte) error { return ErrUnavailable }
func (s *Store) LoadObserver(string) ([]byte, error)       { return nil, ErrUnavailable }
