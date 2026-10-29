//go:build darwin

package hoststate

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

// SaveObserver atomically replaces the private observation slot. An error
// after rename is uncertain: callers must not publish the proposed state.
func (s *Store) SaveObserver(room string, expected, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !roomPattern.MatchString(room) || len(data) == 0 || len(data) > maxCandidateBytes {
		return ErrInvalid
	}
	if s.identity() != nil {
		return ErrUnavailable
	}
	if _, err := s.load(room); err != nil {
		return err
	}
	prior, err := s.file(room+".observer", false)
	if errors.Is(err, os.ErrNotExist) {
		if expected != nil {
			return ErrInvalid
		}
	} else if err != nil {
		return err
	} else {
		old, readErr := io.ReadAll(io.LimitReader(prior, maxCandidateBytes+1))
		prior.Close()
		if readErr != nil || expected == nil || len(old) == 0 || len(old) > maxCandidateBytes || !bytes.Equal(expected, old) {
			return ErrInvalid
		}
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return ErrUnavailable
	}
	name := ".pending-observer-" + hex.EncodeToString(random[:])
	fd, err := unix.Openat(int(s.dir.Fd()), name, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_CREAT|unix.O_EXCL, 0600)
	if err != nil {
		return ErrUnavailable
	}
	f := os.NewFile(uintptr(fd), name)
	defer func() { f.Close(); unix.Unlinkat(int(s.dir.Fd()), name, 0) }()
	if err = s.writePending(f, data); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return ErrUnavailable
	}
	if err = s.identity(); err != nil {
		return err
	}
	if err = unix.Renameat(int(s.dir.Fd()), name, int(s.dir.Fd()), room+".observer"); err != nil {
		return ErrUnavailable
	}
	return s.syncDir()
}

// LoadObserver synchronizes the directory before using a previously published
// slot, including one whose prior publication returned an uncertain error.
func (s *Store) LoadObserver(room string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !roomPattern.MatchString(room) {
		return nil, ErrInvalid
	}
	if err := s.identity(); err != nil {
		return nil, err
	}
	if _, err := s.load(room); err != nil {
		return nil, err
	}
	f, err := s.file(room+".observer", false)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxCandidateBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxCandidateBytes {
		return nil, ErrInvalid
	}
	if err = s.syncDir(); err != nil {
		return nil, err
	}
	return data, nil
}
