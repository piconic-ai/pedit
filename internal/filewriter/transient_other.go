//go:build !windows

package filewriter

func transientRename(error) bool { return false }

func (f *BoundFile) deniedForGood() bool { return false }
