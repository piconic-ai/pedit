//go:build !darwin

package hoststate

// Candidate persistence is unavailable until its filesystem guarantees are verified.
func (s *Store) PublishCandidate(string, []byte) (string, error) { return "", ErrUnavailable }
func (s *Store) ReadCandidate(string, string) ([]byte, error)    { return nil, ErrUnavailable }
func (s *Store) ListCandidates(string) ([]string, error)         { return nil, ErrUnavailable }

func (s *Store) PublishRecoveryOutput(string, RecoveryOutputKind, []byte) (string, error) {
	return "", ErrUnavailable
}
func (s *Store) ReadRecoveryOutput(string, RecoveryOutputKind, string) ([]byte, error) {
	return nil, ErrUnavailable
}
