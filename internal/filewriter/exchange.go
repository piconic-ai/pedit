package filewriter

import "errors"

// errUnsupported means the file system (or the platform) cannot exchange two
// files, or rename one without replacing another.
var errUnsupported = errors.New("not supported by the file system")
