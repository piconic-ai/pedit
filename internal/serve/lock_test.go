//go:build unix

package serve

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func lockTestFile(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "a.md")
	write(t, file, "x\n")
	return file
}

func wantNotLock(t *testing.T, file string) {
	t.Helper()
	s, err := Open(file, Options{SocketBase: base(t)})
	if err == nil {
		_ = s.Close()
		t.Fatal("Open succeeded on a lock path that is not a lock file")
	}
	want := "cannot take the lock: " + lockPath(lockedFile(t, file)) + " is not a lock file pedit made"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err, want)
	}
}

func TestPlantedSymlinkAtLockPathIsNotFollowed(t *testing.T) {
	file := lockTestFile(t)
	target := filepath.Join(t.TempDir(), "victim")
	const content = "ssh-ed25519 AAAA victim key\n"
	write(t, target, content)
	if err := os.Symlink(target, lockPath(file)); err != nil {
		t.Fatal(err)
	}
	wantNotLock(t, file)
	if b, _ := os.ReadFile(target); string(b) != content {
		t.Fatalf("target changed: %q", b)
	}
	if _, err := os.Lstat(lockPath(file)); err != nil {
		t.Fatalf("symlink was removed: %v", err)
	}
}

func TestSymlinkToServedFileAtLockPathIsNotFollowed(t *testing.T) {
	file := lockTestFile(t)
	if err := os.Symlink(file, lockPath(file)); err != nil {
		t.Fatal(err)
	}
	wantNotLock(t, file)
	if b, _ := os.ReadFile(file); string(b) != "x\n" {
		t.Fatalf("served file changed: %q", b)
	}
}

func TestDirectoryAtLockPathIsRefused(t *testing.T) {
	file := lockTestFile(t)
	if err := os.Mkdir(lockPath(file), 0o755); err != nil {
		t.Fatal(err)
	}
	wantNotLock(t, file)
	if _, err := os.Stat(lockPath(file)); err != nil {
		t.Fatalf("directory was removed: %v", err)
	}
}

func TestFIFOAtLockPathIsRefused(t *testing.T) {
	file := lockTestFile(t)
	if err := syscall.Mkfifo(lockPath(file), 0o600); err != nil {
		t.Skip(err)
	}
	wantNotLock(t, file)
	if _, err := os.Lstat(lockPath(file)); err != nil {
		t.Fatalf("fifo was removed: %v", err)
	}
}

func TestHolderNameFromLockFileIsCappedAndClean(t *testing.T) {
	file := lockTestFile(t)
	app := "evil\x1b[31m\nname\r\x00" + strings.Repeat("A", 1024)
	b, _ := json.Marshal(holder{PID: 4242, App: app})
	root, err := os.OpenRoot(filepath.Dir(file))
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	f, err := openLock(root, filepath.Base(lockPath(file)))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(b); err != nil {
		t.Fatal(err)
	}
	if ok, err := lockFile(f); !ok || err != nil {
		t.Fatalf("lockFile = %v, %v", ok, err)
	}
	_, err = Open(file, Options{SocketBase: base(t)})
	var held *HeldError
	if !errors.As(err, &held) {
		t.Fatalf("Open = %v, want *HeldError", err)
	}
	msg := err.Error()
	if strings.ContainsAny(msg, "\x1b\r\x00\n") {
		t.Fatalf("message has control characters: %q", msg)
	}
	if len(held.Holder.App) > maxAppLen || len(msg) > len(file)+200 {
		t.Fatalf("message not capped: %d bytes", len(msg))
	}
	if !strings.Contains(msg, "pid 4242") {
		t.Fatalf("message %q lacks the pid", msg)
	}
}
