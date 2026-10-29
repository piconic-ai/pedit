//go:build !darwin && !linux

package hoststate

import (
	"errors"
	"testing"
)

func TestUnsupportedStoreFailsClosed(t *testing.T) {
	if _, err := Open("/tmp/host"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("unsupported platform accepted credential storage")
	}
}
