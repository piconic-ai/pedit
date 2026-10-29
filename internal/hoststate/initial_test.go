//go:build darwin || linux

package hoststate

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestInitialRecordIsDurableAndImmutable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state")
	s, err := Open(path)
	if errors.Is(err, ErrUnavailable) {
		t.Skip("private store unavailable")
	}
	if err != nil {
		t.Fatal(err)
	}
	c := credentials()
	input := []byte("baseline")
	saved, err := c.BindInitial(input)
	if err != nil {
		t.Fatal(err)
	}
	input[0] = 'X'
	if err = s.Save(saved); err != nil {
		t.Fatal(err)
	}
	alternative, err := c.BindInitial([]byte("different"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Save(alternative) == nil {
		t.Fatal("accepted changed baseline")
	}
	tampered := saved
	record := *saved.Initial
	record.Payload = bytes.Clone(record.Payload)
	record.Payload[0] ^= 1
	tampered.Initial = &record
	if s.Save(tampered) == nil {
		t.Fatal("accepted invalid signature")
	}
	saved.Generation = 2
	s.syncFileHook = func(*os.File) error { return errors.New("failed sync") }
	if s.Save(saved) == nil {
		t.Fatal("accepted failed sync")
	}
	s.syncFileHook = nil
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.Load(c.RoomID)
	if err != nil || got.Generation != 1 || !bytes.Equal(got.Initial.Payload, []byte("baseline")) {
		t.Fatalf("reopened state: %v", err)
	}
}
