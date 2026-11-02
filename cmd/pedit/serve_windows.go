//go:build windows

package main

// Windows has no SIGPIPE: a write to a closed pipe only fails.
func ignoreSIGPIPE() {}
