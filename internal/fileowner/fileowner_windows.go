//go:build windows

package fileowner

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	sidSystem   = "S-1-5-18"
	sidAdmins   = "S-1-5-32-544"
	sidCreator  = "S-1-3-0" // CREATOR OWNER
	aclRevision = 2

	// Access that lets a holder change a file, remove it, or change who may.
	writeMask = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | // data, append, EAs, delete child, attributes
		0x10000 | 0x40000 | 0x80000 | // DELETE, WRITE_DAC, WRITE_OWNER
		0x40000000 | 0x10000000 // GENERIC_WRITE, GENERIC_ALL
)

// SIDs returns the SID of the owner of f (a file or a directory) and the SID
// of the user this process runs as.
func SIDs(f *os.File) (owner, me string, err error) {
	sd, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return "", "", err
	}
	o, _, err := sd.Owner()
	if err != nil {
		return "", "", err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", "", err
	}
	return o.String(), user.User.Sid.String(), nil
}

// Private reports whether only the user this process runs as (and SYSTEM and
// the Administrators group) can change f, a file or a directory already open:
// its owner is one of them, and its access list grants write, delete or
// change-permissions to no one else. Owning a file is not enough: a directory
// can pass on "Authenticated Users: Modify" to what is made in it.
func Private(f *os.File) bool {
	owner, me, err := SIDs(f)
	if err != nil || !TrustedSID(owner, me) {
		return false
	}
	sd, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil { // no list at all: everyone may do anything
		return false
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &ace) != nil {
			return false
		}
		if UnparsedAllow(ace.Header.AceType) && ace.Header.AceFlags&windows.INHERIT_ONLY_ACE == 0 {
			return false // grants access in a form this check does not read
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 || ace.Mask&writeMask == 0 {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if sid != owner && sid != me && sid != sidSystem && sid != sidAdmins && sid != sidCreator {
			return false
		}
	}
	return true
}

// PrivatePath is Private for the file or directory at path.
func PrivatePath(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	return Private(f)
}

// MakePrivate gives the directory at path a protected access list (nothing
// inherited) that grants full control to the user this process runs as, SYSTEM
// and the Administrators group only, and passes it on to what is made in it.
func MakePrivate(path string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	var entries []windows.EXPLICIT_ACCESS
	for _, sid := range []*windows.SID{user.User.Sid, mustSID(sidSystem), mustSID(sidAdmins)} {
		entries = append(entries, windows.EXPLICIT_ACCESS{
			AccessPermissions: windows.GENERIC_ALL,
			AccessMode:        windows.GRANT_ACCESS,
			Inheritance:       windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeValue: windows.TrusteeValueFromSID(sid),
			},
		})
	}
	acl, err := windows.ACLFromEntries(entries, nil)
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

func mustSID(s string) *windows.SID {
	sid, err := windows.StringToSid(s)
	if err != nil {
		panic(err)
	}
	return sid
}
