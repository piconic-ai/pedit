// Package fileowner tells who owns a file on Windows, by SID. Windows has no
// 0600 mode, so a file or directory that only the user may be trusted with is
// checked by its owner.
package fileowner

// TrustedSID reports whether a file owned by owner (a SID string) may be
// trusted by the user me: their own file, or one written by SYSTEM or an
// administrator, whose files the Administrators group owns. An elevated user
// creates files owned by that group, not by themselves.
func TrustedSID(owner, me string) bool {
	return owner == me || owner == "S-1-5-18" || owner == "S-1-5-32-544"
}
