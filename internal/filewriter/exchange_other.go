//go:build !linux && !darwin

package filewriter

import "os"

// exchange is not supported: Windows and the BSDs have no exchange that Write
// could anchor in root.
func exchange(*os.Root, string, string) error { return errUnsupported }

// renameNoReplace is not supported either; create falls back to a hard link or
// a checked rename.
func renameNoReplace(*os.Root, string, string) error { return errUnsupported }
