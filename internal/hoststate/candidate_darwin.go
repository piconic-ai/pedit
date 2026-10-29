//go:build darwin

package hoststate

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/sys/unix"
)

const maxCandidateBytes = 16 << 20

var candidateName = regexp.MustCompile(`^[A-Za-z0-9_-]{22}-[0-9a-f]{32}\.recovery\.json$`)

// PublishCandidate creates a new private candidate without replacing an
// existing file. A nonempty path with an error means publication occurred but
// directory synchronization failed; callers must retain and inspect that path.
func (s *Store) PublishCandidate(room string, data []byte) (string, error) {
	return s.publishRecoveryFile(room, data, ".recovery.json", false)
}

// PublishRecoveryOutput creates a private text or comments inspection file.
func (s *Store) PublishRecoveryOutput(room string, kind RecoveryOutputKind, data []byte) (string, error) {
	suffix, ok := recoveryOutputSuffix(kind)
	if !ok {
		return "", ErrInvalid
	}
	return s.publishRecoveryFile(room, data, suffix, true)
}

func (s *Store) publishRecoveryFile(room string, data []byte, fileSuffix string, allowEmpty bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !roomPattern.MatchString(room) || (!allowEmpty && len(data) == 0) || len(data) > maxCandidateBytes {
		return "", ErrInvalid
	}
	if err := s.identity(); err != nil {
		return "", err
	}
	if _, err := s.load(room); err != nil {
		return "", ErrInvalid
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", ErrUnavailable
	}
	suffix := hex.EncodeToString(random[:])
	tmp := ".pending-candidate-" + suffix
	name := room + "-" + suffix + fileSuffix
	fd, err := unix.Openat(int(s.dir.Fd()), tmp, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_CREAT|unix.O_EXCL, 0600)
	if err != nil {
		return "", ErrUnavailable
	}
	f := os.NewFile(uintptr(fd), tmp)
	defer func() { f.Close(); unix.Unlinkat(int(s.dir.Fd()), tmp, 0) }()
	if err = setEmptyACL(fd); err != nil {
		return "", ErrUnavailable
	}
	if _, err = checked(fd, false); err != nil {
		return "", ErrUnavailable
	}
	if err = s.identity(); err != nil {
		return "", err
	}
	if _, err = f.Write(data); err != nil {
		return "", ErrUnavailable
	}
	if s.syncFileHook != nil {
		if err = s.syncFileHook(f); err != nil {
			return "", ErrUnavailable
		}
	}
	if err = f.Sync(); err != nil {
		return "", ErrUnavailable
	}
	if _, err = unix.FcntlInt(f.Fd(), unix.F_FULLFSYNC, 0); err != nil {
		return "", ErrUnavailable
	}
	if err = f.Close(); err != nil {
		return "", ErrUnavailable
	}
	if err = s.identity(); err != nil {
		return "", err
	}
	if err = unix.RenameatxNp(int(s.dir.Fd()), tmp, int(s.dir.Fd()), name, unix.RENAME_EXCL); err != nil {
		return "", ErrUnavailable
	}
	path := filepath.Join(s.path, name)
	if err = s.syncDir(); err != nil {
		return path, ErrUnavailable
	}
	return path, nil
}

// ReadCandidate reads a candidate only from this locked credential directory.
func (s *Store) ReadCandidate(room, path string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !roomPattern.MatchString(room) || filepath.Dir(path) != s.path || !candidateName.MatchString(filepath.Base(path)) || !strings.HasPrefix(filepath.Base(path), room+"-") {
		return nil, ErrInvalid
	}
	if err := s.identity(); err != nil {
		return nil, err
	}
	if _, err := s.load(room); err != nil {
		return nil, ErrInvalid
	}
	f, err := s.file(filepath.Base(path), false)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxCandidateBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxCandidateBytes {
		return nil, ErrInvalid
	}
	return data, nil
}

// ReadRecoveryOutput reads a private output from this credential directory.
func (s *Store) ReadRecoveryOutput(room string, kind RecoveryOutputKind, path string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	suffix, ok := recoveryOutputSuffix(kind)
	base := filepath.Base(path)
	if !ok || !roomPattern.MatchString(room) || filepath.Dir(path) != s.path || !strings.HasPrefix(base, room+"-") || !strings.HasSuffix(base, suffix) {
		return nil, ErrInvalid
	}
	middle := strings.TrimSuffix(strings.TrimPrefix(base, room+"-"), suffix)
	decoded, err := hex.DecodeString(middle)
	if err != nil || len(decoded) != 16 || hex.EncodeToString(decoded) != middle {
		return nil, ErrInvalid
	}
	if err = s.identity(); err != nil {
		return nil, err
	}
	if _, err = s.load(room); err != nil {
		return nil, ErrInvalid
	}
	f, err := s.file(base, false)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxCandidateBytes+1))
	if err != nil || len(data) > maxCandidateBytes {
		return nil, ErrInvalid
	}
	return data, nil
}

// ListCandidates locates retained recovery artifacts after a process restart.
// Names are not trusted until ReadCandidate has checked the corresponding file.
func (s *Store) ListCandidates(room string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !roomPattern.MatchString(room) {
		return nil, ErrInvalid
	}
	if err := s.identity(); err != nil {
		return nil, err
	}
	if _, err := s.load(room); err != nil {
		return nil, ErrInvalid
	}
	fd, err := unix.Openat(int(s.dir.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrUnavailable
	}
	dir := os.NewFile(uintptr(fd), "recovery directory")
	defer dir.Close()
	entries, err := dir.ReadDir(4097)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, ErrUnavailable
	}
	if len(entries) > 4096 {
		return nil, ErrUnavailable
	}
	var paths []string
	for _, entry := range entries {
		name := entry.Name()
		if candidateName.MatchString(name) && strings.HasPrefix(name, room+"-") {
			paths = append(paths, filepath.Join(s.path, name))
		}
	}
	return paths, nil
}
