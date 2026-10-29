//go:build linux

package hoststate

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// Store holds a process-wide lock until Close. The caller must protect the
// parent directory against other users moving or replacing this directory.
type Store struct {
	mu           sync.Mutex
	syncFileHook func(*os.File) error
	syncDirHook  func() error
	dir          *os.File
	path         string
	lock         *os.File
	dev          uint64
	ino          uint64
}

func removeACL(fd int) error {
	for _, name := range []string{"system.posix_acl_access", "system.posix_acl_default"} {
		err := unix.Fremovexattr(fd, name)
		if err != nil && !errors.Is(err, unix.ENODATA) {
			return err
		}
	}
	return nil
}

func emptyACL(fd int) error {
	for _, name := range []string{"system.posix_acl_access", "system.posix_acl_default"} {
		_, err := unix.Fgetxattr(fd, name, nil)
		if !errors.Is(err, unix.ENODATA) {
			return ErrUnavailable
		}
	}
	return nil
}

func localExt4(fd int) error {
	var fs unix.Statfs_t
	if unix.Fstatfs(fd, &fs) != nil || fs.Type != unix.EXT4_SUPER_MAGIC {
		return ErrUnavailable
	}
	var st unix.Statx_t
	if unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &st) != nil || st.Mask&unix.STATX_MNT_ID == 0 {
		return ErrUnavailable
	}
	mounts, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return ErrUnavailable
	}
	defer mounts.Close()
	scanner := bufio.NewScanner(io.LimitReader(mounts, 1<<20))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 || fields[0] != strconv.FormatUint(st.Mnt_id, 10) {
			continue
		}
		for i, field := range fields {
			if field == "-" && i+1 < len(fields) && fields[i+1] == "ext4" {
				return nil
			}
		}
		return ErrUnavailable
	}
	return ErrUnavailable
}

func checked(fd int, dir bool) (unix.Stat_t, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return st, err
	}
	kind := uint32(unix.S_IFREG)
	if dir {
		kind = uint32(unix.S_IFDIR)
	}
	if st.Mode&unix.S_IFMT != kind || st.Uid != uint32(os.Geteuid()) || st.Mode&07777 != map[bool]uint32{true: 0700, false: 0600}[dir] || (!dir && st.Nlink != 1) {
		return st, ErrUnavailable
	}
	if err := emptyACL(fd); err != nil {
		return st, ErrUnavailable
	}
	return st, nil
}

// Open creates or opens a private directory and obtains its exclusive lock.
// Existing directories are never chmod'ed or have their ACL modified.
func Open(path string) (*Store, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, ErrUnavailable
	}
	made := false
	if err := os.Mkdir(path, 0700); err == nil {
		made = true
	} else if !errors.Is(err, os.ErrExist) {
		return nil, ErrUnavailable
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrUnavailable
	}
	f := os.NewFile(uintptr(fd), path)
	fail := func() (*Store, error) { f.Close(); return nil, ErrUnavailable }
	if made {
		if err := removeACL(fd); err != nil {
			return fail()
		}
		if err := unix.Fchmod(fd, 0700); err != nil {
			return fail()
		}
	}
	if localExt4(fd) != nil {
		return fail()
	}
	st, err := checked(fd, true)
	if err != nil {
		return fail()
	}
	s := &Store{dir: f, path: path, dev: st.Dev, ino: st.Ino}
	if err := s.identity(); err != nil {
		return fail()
	}
	lock, err := s.file("lock", true)
	if err != nil {
		return fail()
	}
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return fail()
	}
	s.lock = lock
	if s.probeACL() != nil {
		s.Close()
		return nil, ErrUnavailable
	}
	if made && s.syncCreatedDirectory(path) != nil {
		s.Close()
		return nil, ErrUnavailable
	}
	return s, nil
}

func (s *Store) probeACL() error {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return ErrUnavailable
	}
	name := ".acl-probe-" + hex.EncodeToString(random[:])
	fd, err := unix.Openat(int(s.dir.Fd()), name, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_CREAT|unix.O_EXCL, 0600)
	if err != nil {
		return ErrUnavailable
	}
	defer unix.Close(fd)
	defer unix.Unlinkat(int(s.dir.Fd()), name, 0)
	acl := probeACLValue()
	if unix.Fsetxattr(fd, "system.posix_acl_access", acl, 0) != nil {
		return ErrUnavailable
	}
	buf := make([]byte, len(acl))
	n, err := unix.Fgetxattr(fd, "system.posix_acl_access", buf)
	if err != nil || n != len(acl) || !bytes.Equal(buf, acl) {
		return ErrUnavailable
	}
	if unix.Fremovexattr(fd, "system.posix_acl_access") != nil {
		return ErrUnavailable
	}
	return emptyACL(fd)
}

func probeACLValue() []byte {
	acl := make([]byte, 44)
	binary.LittleEndian.PutUint32(acl, 2)
	entries := [][3]uint32{{1, 6, ^uint32(0)}, {2, 4, uint32(os.Geteuid()) + 1}, {4, 0, ^uint32(0)}, {16, 0, ^uint32(0)}, {32, 0, ^uint32(0)}}
	for i, entry := range entries {
		at := 4 + 8*i
		binary.LittleEndian.PutUint16(acl[at:], uint16(entry[0]))
		binary.LittleEndian.PutUint16(acl[at+2:], uint16(entry[1]))
		binary.LittleEndian.PutUint32(acl[at+4:], entry[2])
	}
	return acl
}

func (s *Store) syncCreatedDirectory(path string) error {
	if err := s.syncDir(); err != nil {
		return err
	}
	parent, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer parent.Close()
	err = parent.Sync()
	return err
}

func (s *Store) identity() error {
	if s == nil || s.dir == nil {
		return ErrUnavailable
	}
	st, err := checked(int(s.dir.Fd()), true)
	if err != nil || st.Dev != s.dev || st.Ino != s.ino {
		return ErrUnavailable
	}
	var at unix.Stat_t
	if err := unix.Lstat(s.path, &at); err != nil || at.Mode&unix.S_IFMT != unix.S_IFDIR || at.Dev != s.dev || at.Ino != s.ino {
		return ErrUnavailable
	}
	return nil
}

func (s *Store) file(name string, create bool) (*os.File, error) {
	flags := unix.O_RDWR | unix.O_NOFOLLOW | unix.O_CLOEXEC
	fd, err := unix.Openat(int(s.dir.Fd()), name, flags, 0)
	if errors.Is(err, unix.ENOENT) && create {
		fd, err = unix.Openat(int(s.dir.Fd()), name, flags|unix.O_CREAT|unix.O_EXCL, 0600)
		if err == nil {
			if err = removeACL(fd); err != nil {
				unix.Close(fd)
				return nil, ErrUnavailable
			}
			if err = unix.Fchmod(fd, 0600); err != nil {
				unix.Close(fd)
				return nil, ErrUnavailable
			}
		}
	}
	if err != nil {
		return nil, err
	}
	if _, err = checked(fd, false); err != nil {
		unix.Close(fd)
		return nil, ErrUnavailable
	}
	return os.NewFile(uintptr(fd), name), nil
}

func (s *Store) syncDir() error {
	if err := s.identity(); err != nil {
		return err
	}
	if s.syncDirHook != nil {
		return s.syncDirHook()
	}
	if err := s.dir.Sync(); err != nil {
		return err
	}
	return nil
}
func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s == nil || s.dir == nil {
		return nil
	}
	if s.lock != nil {
		s.lock.Close()
		s.lock = nil
	}
	e := s.dir.Close()
	s.dir = nil
	return e
}

func (s *Store) Load(room string) (Credentials, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load(room)
}

func (s *Store) load(room string) (Credentials, error) {
	var c Credentials
	if !roomPattern.MatchString(room) || s.identity() != nil {
		return c, ErrInvalid
	}
	f, err := s.file(room, false)
	if err != nil {
		return c, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxCredentialsBytes+1))
	if err != nil || len(b) > maxCredentialsBytes {
		return c, ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || d.Decode(&struct{}{}) != io.EOF || c.validate() != nil || c.RoomID != room {
		return Credentials{}, ErrInvalid
	}
	return c, nil
}

func (s *Store) writePending(f *os.File, b []byte) error {
	var err error
	if err = removeACL(int(f.Fd())); err != nil {
		return ErrUnavailable
	}
	if _, err = checked(int(f.Fd()), false); err != nil {
		return ErrUnavailable
	}
	if err = s.identity(); err != nil {
		return err
	}
	if _, err = f.Write(b); err != nil {
		return ErrUnavailable
	}
	if s.syncFileHook != nil {
		if err = s.syncFileHook(f); err != nil {
			return ErrUnavailable
		}
	}
	if err = f.Sync(); err != nil {
		return ErrUnavailable
	}
	return nil
}

func (s *Store) Save(c Credentials) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := c.validate(); err != nil {
		return err
	}
	if err := s.identity(); err != nil {
		return err
	}
	old, err := s.load(c.RoomID)
	if err == nil {
		if old.Origin != c.Origin || old.HostToken != c.HostToken || old.EditSecret != c.EditSecret || old.HostSeed != c.HostSeed || old.Generation > c.Generation || !sameInitial(old.Initial, c.Initial) {
			return ErrInvalid
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return ErrInvalid
	}
	b, err := json.Marshal(c)
	if err != nil {
		return ErrInvalid
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return ErrUnavailable
	}
	name := ".pending-" + hex.EncodeToString(random[:])
	fd, err := unix.Openat(int(s.dir.Fd()), name, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_CREAT|unix.O_EXCL, 0600)
	if err != nil {
		return ErrUnavailable
	}
	f := os.NewFile(uintptr(fd), name)
	defer func() { f.Close(); unix.Unlinkat(int(s.dir.Fd()), name, 0) }()
	if err = s.writePending(f, b); err != nil {
		return err
	}
	if err = s.identity(); err != nil {
		return err
	}
	if err = unix.Renameat(int(s.dir.Fd()), name, int(s.dir.Fd()), c.RoomID); err != nil {
		return ErrUnavailable
	}
	if err = s.syncDir(); err != nil {
		return ErrUnavailable
	}
	return nil
}
