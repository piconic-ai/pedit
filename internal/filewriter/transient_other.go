//go:build !windows

package filewriter

func transientRename(error) bool { return false }
