//go:build darwin

package hoststate

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

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
	dev          int32
	ino          uint64
}

type attrs struct {
	Count                        uint16
	Reserved                     uint16
	Common, Vol, Dir, File, Fork uint32
}

func setEmptyACL(fd int) error {
	a := attrs{Count: 5, Common: unix.ATTR_CMN_EXTENDED_SECURITY}
	var b [52]byte
	binary.LittleEndian.PutUint32(b[0:4], 8)
	binary.LittleEndian.PutUint32(b[4:8], 44)
	binary.LittleEndian.PutUint32(b[8:12], 0x012cc16d)
	_, _, e := unix.Syscall6(unix.SYS_FSETATTRLIST, uintptr(fd), uintptr(unsafe.Pointer(&a)), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), 0, 0)
	if e != 0 {
		return e
	}
	return nil
}

func emptyACL(fd int) error {
	a := attrs{Count: 5, Common: unix.ATTR_CMN_EXTENDED_SECURITY | unix.ATTR_CMN_RETURNED_ATTRS}
	var b [76]byte
	_, _, e := unix.Syscall6(unix.SYS_FGETATTRLIST, uintptr(fd), uintptr(unsafe.Pointer(&a)), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), unix.FSOPT_REPORT_FULLSIZE, 0)
	if e != 0 {
		return e
	}
	if binary.LittleEndian.Uint32(b[:4]) != 76 || binary.LittleEndian.Uint32(b[4:8]) != unix.ATTR_CMN_EXTENDED_SECURITY|unix.ATTR_CMN_RETURNED_ATTRS || binary.LittleEndian.Uint32(b[24:28]) != 8 || binary.LittleEndian.Uint32(b[28:32]) != 44 || binary.LittleEndian.Uint32(b[32:36]) != 0x012cc16d || binary.LittleEndian.Uint32(b[68:72]) != 0 || binary.LittleEndian.Uint32(b[72:76]) != 0 {
		return ErrUnavailable
	}
	return nil
}

func checked(fd int, dir bool) (unix.Stat_t, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return st, err
	}
	kind := uint16(unix.S_IFREG)
	if dir {
		kind = unix.S_IFDIR
	}
	if st.Mode&unix.S_IFMT != kind || st.Uid != uint32(os.Geteuid()) || st.Mode&07777 != map[bool]uint16{true: 0700, false: 0600}[dir] || (!dir && st.Nlink != 1) {
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
		if err := setEmptyACL(fd); err != nil {
			return fail()
		}
	}
	var fs unix.Statfs_t
	if err := unix.Fstatfs(fd, &fs); err != nil || string(bytes.TrimRight(fs.Fstypename[:], "\x00")) != "apfs" || fs.Flags&unix.MNT_LOCAL == 0 {
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
	if made && s.syncCreatedDirectory(path) != nil {
		s.Close()
		return nil, ErrUnavailable
	}
	return s, nil
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
	if err == nil {
		_, err = unix.FcntlInt(parent.Fd(), unix.F_FULLFSYNC, 0)
	}
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
			if err = setEmptyACL(fd); err != nil {
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
	_, err := unix.FcntlInt(s.dir.Fd(), unix.F_FULLFSYNC, 0)
	return err
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
	if err = setEmptyACL(int(f.Fd())); err != nil {
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
	if _, err = unix.FcntlInt(f.Fd(), unix.F_FULLFSYNC, 0); err != nil {
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
