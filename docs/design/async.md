# Asynchronous rooms

Issue #234 lets guests read, edit and comment while the host is away. The
relay keeps encrypted state until the host has saved it or the room closes. The
host's files remain the source of truth after the host has saved the changes.

This document is a design in progress. The wire format, limits and recovery
protocol below need implementation and interoperability tests before release.

## Security boundary

The relay does not receive a document key or plaintext. It sees room IDs,
admission verifiers, ciphertext sizes, times, and the number of senders. It
can delete, delay, reorder or replay ciphertext. A read link can decrypt and
record editor-signed frames, so a valid signature alone cannot prove that a
frame is new. The current nonce handshake rejects frames from a signer that
has not answered a new peer's challenge. Replaying stored frames through that
path would either discard offline changes or weaken that protection.

Each kept room needs a host-only signing key. The verification key must be
bound to every link without sending a decryption key to the relay. The shared
editor signing key is not sufficient: every editor has it. A host-signed
checkpoint binds the room, a fresh random epoch, its generation, the complete
document state and per-sender counter floors. Durable frames bind the epoch,
sender, counter and message to their signature. A client verifies the
checkpoint and the access tier and permissions of every frame before applying
it. It rejects old epochs and duplicate counters. It must not discard a valid
frame merely because a later counter arrived first; ordering and gaps need an
explicit protocol. The live nonce handshake
remains in use for live messages; stored frames have a separate validation
path and do not advance the live handshake's floors.

Kept-room links use `v6.e.`, `v6.c.` or `v6.r.` followed by canonical
base64url data. Each contains the secret for its access tier and the host's
public key; lower-tier links also contain the higher tiers' verification keys.
The host's private key is generated independently and is never in a shared
link. The v6 frame key binds the room ID and all three verification keys.
Peers reject noncanonical, identity and non-prime-order public keys. The v6
keys and signers cannot be passed to the existing v5 client and signing APIs.
The editor and commenter links additionally derive the same comment admission
capability from the comment secret. Its v6 HKDF context binds the room ID,
editor and commenter verification keys, and host verification key. The read
link cannot derive it. This capability is not yet registered or enforced by
the relay; later transport must distinguish it from reader admission before it
allows an append. The Worker has an internal registration primitive that checks
the host token against the room ID, stores all three admission verifiers in one
transaction, and rejects v5 access to a registered v6 room. It is not exposed
as an API and does not enforce room lifetime or handle append operations. V6
room transport and signed durable records are not yet wired together.

Signatures cannot make an untrusted relay available or prove that it delivered
every frame. A first-time guest with no independent fresh reference cannot
detect the relay presenting an older valid checkpoint and its log. A returning
host must retain its last accepted generation and reject a rollback. The UI
must not promise that an unavailable relay has retained an edit.

## Checkpoints and log

A checkpoint includes the manifest, complete Yjs state for each content and
metadata document, canvas and attachment state, and the counter floors that
correspond to that state. Reconstructing a Yjs document from the plain file
on return would create new identifiers and cannot safely merge updates made
against the old document. Comments stay in their separate metadata documents.

The host publishes an encrypted, host-signed checkpoint and retains the host
credentials and recovery state under `.pedit/`. The relay stores the opaque
checkpoint and an ordered, bounded log of durable ciphertext frames. It must
retain frames after the checkpoint even while the host is connected, so that
a crash before the host saves cannot lose an accepted edit. Awareness is not
durable. The envelope identifies durable frames for storage; the receiver
checks the encrypted message type against that declaration. The relay enforces
per-room and per-client storage and rate limits without decrypting content.

A guest receives a consistent checkpoint and its subsequent log before it
can edit. The relay acknowledges a durable frame only after storing it. The
guest distinguishes a locally pending edit from one acknowledged by the
relay, and reports storage exhaustion or disconnection instead of claiming
that the edit is kept. A checkpoint names a log cutoff captured before its
construction and covers only frames the host validated, applied and durably
saved. Replacing the checkpoint and deleting only its covered log must be
atomic in the Durable Object. A reader interrupted by compaction
restarts from a consistent checkpoint and log. Epoch changes must not discard
unacknowledged edits; their safe retry protocol remains to be designed.

The storage prototype freezes appends before a host constructs the next
checkpoint. The freeze returns a token and cutoff; it survives eviction and
can be queried or aborted by the host. A commit checks that token and cutoff,
then replaces the checkpoint, switches epoch and removes covered frames in one
transaction. Used epochs cannot be reused. A repeated commit or abort is
recognized only while its receipt is the most recent one of that kind. After
that, the caller must inspect the current generation and pending cut instead
of treating a stale response as success. The host must authorize every freeze,
inspection, abort and commit before those operations are exposed.

The storage prototype captures a checkpoint and log tail together in a bounded,
expiring read session. Each page uses a server-issued cursor and the stored
tail; it rejects a changed epoch or generation. The last cursor can be retried
after a lost response, including after eviction. After receiving the last page,
the caller releases the session with its final cursor; release can be retried.
A later append cannot extend the captured tail. The session does not authorize
its caller; the public protocol must check admission and connect the fixed tail
to live delivery. Each page holds at most 16 frames and 1 MiB of ciphertext.
The public transport must also bound its encoded response and envelope.

## Transport prototype

The internal transport checks host credentials before initialization and cut
operations. Editors and commenters may append, while readers may only read.
It acknowledges an append only after storage sync. Callers must supply ciphertext;
the relay cannot check that an opaque payload is encrypted. It has no public
route. Its read sessions fix the checkpoint and log tail;
a subsequent poll starts a new session and returns a new checkpoint plus its
whole tail. Clients must authenticate checkpoint contents and each record,
apply their own durable operation ledger, and persist their progress together
with document state. A completed relay read does not prove those steps occurred.

The prototype has no live subscription, incremental catch-up, deadline or
maintenance checks, or public endpoint. Polling is a functional test of the
read boundary, not a delivery guarantee. Per-client limits, checkpoint
freshness, verified message permissions, durable outbox and feature gating
remain necessary before enabling kept rooms.

## Ledger snapshot encoding

The ledger snapshot uses `pedit/v6/ledger\0`, a big-endian 32-bit receipt
count, then fixed 74-byte receipts. Each receipt contains a tier byte (editor
0 or commenter 1), the 32-byte sender public key, a big-endian 64-bit sequence,
the 32-byte operation digest, and an outcome byte (applied 0 or rejected 1).
Receipts sort by tier, sender bytes and sequence. Each sender's sequence begins
at one and is contiguous. Unknown values, duplicate or out-of-order receipts,
trailing bytes, and sequences above JavaScript's safe integer limit are invalid.
The digest is SHA-256 over `pedit/v6/operation\0`, tier, sender, sequence,
a big-endian 32-bit message length, and the message bytes. It excludes epoch
and generation so an unchanged operation retains its identity across cutover.
The checkpoint signature authenticates the snapshot, not its format alone.

The ledger cannot exceed the existing checkpoint payload limit. The caller
must also reserve space for document state and other checkpoint data; an
oversized ledger or checkpoint is an error, not permission to drop receipts.
The caller must save the ledger and its corresponding document state together,
and serialize the ledger read, decision, commit and save or use persistent
compare-and-swap. This encoding does not yet define the complete checkpoint
payload, persist Yjs state, or connect checkpoint transport.

## Host recovery

The host restores the prior Yjs state, validates the checkpoint and log, and
merges changes made to the local files while it was away. Before writing any
output, it durably records a recovery journal containing the resulting state,
counter floors and the expected old and new content of each output. The
journal is written and synced before publication by an atomic rename. Each
file and metadata file is then saved with conflict detection.

On restart, an output matching its old content still needs writing; one
matching its new content is already written. Any other content is an external
edit and must be merged safely or reported as a conflict, never overwritten
silently. Unknown metadata fields remain intact. The host acknowledges and
truncates the covered relay log only after every output, referenced attachment
and the journal are durable. A failed save keeps the log and its attachments.
The journal makes a multi-file save
recoverable; it does not make all files visible atomically.

## Lifetime and cleanup

The host chooses a keep duration when opening a room. The relay clamps it to
its configured maximum and reports the effective deadline. The proposed public
cap is seven days; self-hosted relays have no cap unless configured. The
room's total lifetime limit must permit the effective deadline, even when the
host has been connected for some time before leaving. An explicit close ends
the room;
the relay can also end it at its limit or for maintenance. Expiration and
close remove the checkpoint, log and encrypted attachments. R2 lifecycle rules
and the periodic orphan check must cover the longest configured lifetime.
An unlimited self-hosted relay cannot use a finite age-based expiry for active
rooms; orphan cleanup must not delete their attachments.
The public relay remains a service without an SLA. Self-hosted limits are
configurable.

The lifetime model is a standalone Worker primitive; it is not yet connected
to room admission, alarms or client messages. It retains the requested duration
and applies the current relay cap whenever the host leaves. With a finite room
limit, a departure extends the total deadline to at least the resulting keep
deadline. A returning host keeps the extended total deadline. A later departure
starts a new keep period, subject to the then-current cap. An unlimited total
lifetime has no total deadline, but an absence still ends at its keep deadline.
The closed state cannot be reopened. Each time observation is checked against
the last observed time and returns the updated state, closing it at the
deadline. The caller must persist every observation and transition before
reporting or scheduling from it. It must also persist closed before deleting
room data, and coordinate the alarm with that state. A backward clock is rejected
until a valid time is available. Restored data must pass the lifetime parser.

## Verification before release

Tests must cover cross-language encoding, signature and access validation,
old epochs and duplicate frames, and reconnecting guests with no host. They
must interrupt recovery before and after each file and metadata write, before
and after journal publication, and before log acknowledgement. They must also
cover external edits, failed saves, compaction racing a join, storage limits,
expiration, and cleanup. An interoperability test must leave a room open for a
simulated week, edit and comment while the host is away, then verify that the
host saves the results and the covered log is removed.

## Work still to design

- The canvas JSON pane sends edits to the host for validation and waits for
  its answer. A kept room needs a way to validate and apply those edits while
  the host is away. Moving the current host algorithm to each browser is not
  sufficient: reordering deletes and reinserts a Y.Map, so concurrent moves
  can create duplicate IDs or strand edits on a deleted map. The Go and
  browser implementations need a shared model that preserves concurrent board
  and JSON edits without applying an operation twice. Test concurrent moves,
  text edits and deletions as well as the resulting saved canvas.
  One candidate stores each node and edge as a stable record, with a separate
  order key and deletion marker. Moving it changes its order rather than
  replacing its Y.Map. Internal IDs and order keys would not appear in the
  exported JSON Canvas file. Simultaneous public-ID collisions and edges to a
  deleted node need explicit conflict handling rather than silently dropping
  an item. Existing clients read arrays directly, so this change requires a
  new protocol version and coordinated Go and browser support.
- An acknowledged append whose response was lost must be distinguishable from
  a new operation when a client retries, including across an epoch change.
  One candidate is a durable per-sender sequence separate from the live frame
  counter. A browser would persist its pending operation and sequence together
  before sending, retry the same ciphertext within an epoch, and preserve the
  operation identity when re-signing for a new epoch. Receivers would verify
  signatures before advancing a checkpointed floor and wait on sequence gaps.
  This still needs a proof for concurrent tabs, sender impersonation and
  checkpoint replacement. In-memory pending edits alone are not enough when
  a browser closes before an acknowledgement.
- Signing keys are currently shared within an access tier. One participant at
  that tier can impersonate another sender and advance its counter. Define
  per-sender authentication or explicitly state this trust boundary.
- Define the checkpoint and frame encodings, link key binding, room resume and
  close commands, chunking, limits, and the exact transaction and recovery steps. Prove
  their ordering against disconnects, compaction and external file changes
  before implementing the protocol.
