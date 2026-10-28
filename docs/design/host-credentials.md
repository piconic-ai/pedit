# Host recovery credentials

The internal host credential store saves the relay origin, room ID, host token,
editor secret, host signing seed, and last accepted checkpoint generation. It
derives the room keys locally. The caller must verify the checkpoint and make
its recovery state durable before advancing the generation. This store does not
persist the checkpoint, ledger, pending edits, or attachment inventory.

The implementation is available only on local APFS on macOS; other platforms
and uninspectable filesystems fail closed. It creates a dedicated directory,
sets and checks an explicit empty ACL before putting secrets inside it, checks
owner and mode, and holds an exclusive process lock until close. Existing
unverified directories, symbolic links, hard-linked credential files, invalid
records, changed identities, and decreasing generations are rejected. Records
are written through an exclusive temporary file, synced with `fsync` and
`F_FULLFSYNC`, renamed, and followed by directory synchronization. A failed
sync returns an error; after a failure following rename, the caller must reload
and reconcile the complete record under the lock.

The caller must put the directory under a parent that other users cannot move,
replace, or use to access it. This implementation does not prove every parent
ACL or defend against a process running as the same user. The tests establish
process termination behavior, not power-loss durability: macOS does not provide
an established guarantee here that a synced directory rename survives power
loss. Filesystem, hardware, or backup rollback can also restore an older whole
record without detection. A backup containing the directory contains secrets.

The store is an internal API and is not wired into the CLI, room creation, or
resume. It must not be taken as evidence that the host can yet recover a room
or acknowledge guest operations safely.

## Internal host transport

The internal Go host client loads saved credentials and validates the initial
checkpoint signature and supported text payload before calling the Room's
internal initialize route. It returns the relay's effective keep duration and
uses the host socket to signal presence. A fixed read verifies the checkpoint
and records, but does not apply them or acknowledge a cut. The client is not
connected to the CLI or to a production forwarding route.

A read that fails after receiving a session ID makes a bounded best-effort
cancellation. The Room accepts cancellation only from the same or a higher
read tier; an unreachable Room falls back to session expiry.

The caller must durably save a consistent initial checkpoint and baseline before
initialization, and must validate attachment inventory. The credential store
alone does not establish those conditions. A socket disconnect starts an away
transition at the Room; the Go client has no durable departure confirmation and
must not report retention as complete on that basis. Close uses a host-authorized
internal route. A lost close response is ambiguous: the room may already be
closed, and the current route cannot authenticate a retry after admission is
removed. Public close, reconnect UX, applying recovered records, durable local
save, and acknowledgement remain unimplemented.

The host read rejects a checkpoint below the saved credential generation, even
without a full anchor. An anchor also checks epoch, cutoff, ciphertext and tail.
The store is read before and after inspection, so an advancement observed during
the read rejects an older result. Callers must serialize saving credentials with
using an inspection: the final check alone cannot prevent a concurrent save
immediately after it. A generation bound does not establish tail completeness.

Initialization also rereads credentials after the relay response. If they
changed or cannot be read, it reports an uncertain outcome: the relay may
already have initialized the room. The caller must reconcile the room and
must not infer that it is closed. The caller must serialize credential changes
with use of the result, because a save can occur after the final check.
