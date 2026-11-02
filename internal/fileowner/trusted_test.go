package fileowner

import "testing"

func TestUnparsedAllow(t *testing.T) {
	for _, typ := range []byte{0x04, 0x05, 0x09, 0x0B} {
		if !UnparsedAllow(typ) {
			t.Errorf("type %#x grants access but is not refused", typ)
		}
	}
	for _, typ := range []byte{0x00, 0x01, 0x02, 0x06, 0x0A, 0x11} { // allow, deny, audit, ...
		if UnparsedAllow(typ) {
			t.Errorf("type %#x is read or grants nothing, but is refused", typ)
		}
	}
}

func TestTrustedSID(t *testing.T) {
	if !TrustedSID("S-1-5-21-1", "S-1-5-21-1") || !TrustedSID("S-1-5-32-544", "S-1-5-21-1") || !TrustedSID("S-1-5-18", "S-1-5-21-1") {
		t.Error("own, Administrators and SYSTEM owners must be trusted")
	}
	if TrustedSID("S-1-5-21-2", "S-1-5-21-1") {
		t.Error("another user's file must not be trusted")
	}
}
