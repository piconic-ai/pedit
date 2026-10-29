# Host recovery credentials

The internal host credential store saves the relay origin, room ID, host token,
editor secret, host signing seed, and last accepted checkpoint generation. It
derives the room keys locally. The caller must verify the checkpoint and make
its recovery state durable before advancing the generation. This store does not
persist the checkpoint, ledger, pending edits, or attachment inventory.

The implementation is available on local APFS on macOS and inspectable ext4
on Linux; other platforms and uninspectable filesystems fail closed. Linux
requires a working statx mount ID, matching ext4 mountinfo, and working POSIX
ACL extended attributes, verified by a temporary ACL probe before secrets are
written. The directory and files must have no access ACL; the directory must
also have no default ACL. It creates a dedicated directory,
sets and checks an explicit empty ACL before putting secrets inside it, checks
owner and mode, and holds an exclusive process lock until close. Existing
unverified directories, symbolic links, hard-linked credential files, invalid
records, changed identities, and decreasing generations are rejected. Records
are written through an exclusive temporary file, synced with `fsync` (and
`F_FULLFSYNC` on macOS), renamed, and followed by directory synchronization. A failed
sync returns an error; after a failure following rename, the caller must reload
and reconcile the complete record under the lock.

The caller must put the directory under a parent that other users cannot move,
replace, or use to access it. This implementation does not prove every parent
ACL or defend against a process running as the same user. The tests establish
process termination behavior, not power-loss durability: filesystem and hardware
behavior after power loss is not proven here. Filesystem, hardware, or backup rollback can also restore an older whole
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
changed or cannot be read, the response is lost, or the response is not a
valid success, it reports an uncertain outcome: the relay may already have
initialized the room. This includes 4xx and 5xx responses because an
intermediary may have replaced a response after the relay committed. The caller must reconcile the room and
must not infer that it is closed. The caller must serialize credential changes
with use of the result, because a save can occur after the final check.

The fixed host read accepts at most 10,000 receipts in its authenticated
checkpoint baseline and independently reads at most 1,024 tail records and
16 MiB of decoded tail ciphertext. Its provisional ledger has room for both
limits; it does not change the returned baseline or persist the tail. The
checkpoint itself remains frame-size bounded, and a rejected or over-capacity
read releases its session on a bounded best-effort basis.

The internal initial-state path captures one text file and its comments without
starting a v5 session. It stores the original text and metadata bytes, paths,
epoch and encrypted checkpoint in a host-signed record in the same atomic
credential write. Reload validates the signature, checkpoint, file path, text,
and comment state. A failed directory sync can leave the record present even
though the caller received an error; a later attempt must inspect the existing
record instead of generating a replacement. This only prepares an initial
baseline: attachment absence must be established by the caller, and observing
unchanged files is not an external-editor lock. It does not enable a public CLI,
verify an unseen relay tail, or authorize recovery, cut, or acknowledgement.

An internal read-evidence bundle records the exact initial checkpoint, observed
relay sequence numbers and ciphertext frames, replayed text and comments Yjs,
and replayed ledger under a host signature. Opening it verifies the signature,
replays the ciphertext and checks the resulting state and ledger again. It is
an observation, not proof that the relay delivered every unseen record: relay
sequence numbers and the fixed tail are not signed by a trusted independent
source. It cannot authorize file writes, a cut, or acknowledgement. Capture
accepts at most 1,024 frames and 10 MiB of checkpoint plus ciphertext; the
private candidate store imposes a further 16 MiB serialized limit. Over-limit
reads fail without cutting the relay log. Candidate storage remains supported
only on macOS in this prototype. The record contains private plaintext Yjs and
is protected by the host credential store's existing permissions and durability
limits; power-loss guarantees are unchanged.

The internal frozen-observation experiment accepts an already pending freeze
from an authenticated caller, reads and saves a signed evidence bundle, then
checks that the same pending token and cutoff were still reported. It stores a
second signed record binding the observed cut to the exact evidence bytes. This
is a historical observation, not proof that the relay is honest, that the tail
is complete, or that the freeze is still active when the record is reopened.
The experiment does not claim ownership of a pending freeze and does not abort,
commit, delete records, write local files, or provide a public route. If a later
step fails, the returned result distinguishes the paths of any published read
evidence and frozen observation. Tests use a test-only Worker route.
