// Package flock takes an exclusive advisory lock on an open file without
// waiting. The operating system releases it when the process ends, crash
// included, so a lock file left behind is stale by itself.
package flock
