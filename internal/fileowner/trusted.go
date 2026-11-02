// Package fileowner tells who owns a file on Windows, by SID. Windows has no
// 0600 mode, so a file or directory that only the user may be trusted with is
// checked by its owner and its access list.
package fileowner

// TrustedSID reports whether a file owned by owner (a SID string) may be
// trusted by the user me: their own file, or one written by SYSTEM or an
// administrator, whose files the Administrators group owns. An elevated user
// creates files owned by that group, not by themselves.
func TrustedSID(owner, me string) bool {
	return owner == me || owner == "S-1-5-18" || owner == "S-1-5-32-544"
}

// UnparsedAllow reports an access-control entry type that grants access but
// that Private does not read: compound, object, conditional (callback) and
// conditional object allow entries. A list holding one is not trusted.
func UnparsedAllow(aceType byte) bool {
	switch aceType {
	case 0x04, 0x05, 0x09, 0x0B: // COMPOUND, OBJECT, CALLBACK, CALLBACK_OBJECT allowed
		return true
	}
	return false
}
