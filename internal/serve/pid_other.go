//go:build !unix

package serve

// pidAlive is conservative where liveness is not checked: a lock is never
// taken over, and its file is removed by hand.
func pidAlive(pid int) bool { return true }
