# Asynchronous rooms

## Implemented text review

`pedit --keep 7d notes.md todo.md` publishes a fixed set of encrypted Yjs text
documents, one per file. A signed encrypted snapshot carries their stable IDs,
relative display paths and states; signed updates identify their target file.
The host writes only the original local paths in its private record. The relay
caps retention, keeps an encrypted snapshot and update log, and serves browser
guests after the host leaves. `pedit --resume <link>` restores the original
Yjs identifiers from a mode-0600 record outside the project, merges signed updates, saves the
files and recovery state, then checkpoints and truncates the observed log prefix.
All source writes and the recovery journal are durable before the shared log
cutoff advances. Restart finishes any partially completed journal writes.

Local edits made while away are diffed against the text the host last wrote
(the journal's expected text) and applied to the restored checkpoint document
as host edits, using the live room's external-edit merge, before the relay log
is applied. The journal is rewritten with the merged state and the on-disk text
as the file's last written text, so the later write and log truncation follow
the usual order. A file that cannot be read, is not UTF-8 or exceeds the frame
limit is not merged and is refused as an external change, preserving it.
Repeated Yjs text updates are idempotent. This path is separate from the live
nonce handshake and never accepts canvas operations. Images are not operations
on the room: see "Images in kept rooms".

### Comments in kept rooms

Each text file inside the project also gets a paired comments doc (root map
`comments`), with its own stable file ID (1024 plus the file's ID, kept in the
record) and the path `.pedit/meta/<path>.json` as its pairing name in the
snapshot, as in a live room's manifest (`metaPath`). Signed log entries target
it by that ID exactly like a text file's; a root other than `comments`, an
update that fails the live room's comment checks (`meta.CheckUpdate`,
`checkMetaUpdate`), and unknown IDs are skipped and counted. A file outside the
project, or whose pairing path cannot be listed, has no comments doc. The Worker
stays an opaque relay.

On `--keep`, an existing `.pedit/meta/<path>.json` is loaded into the doc,
anchors re-found by their saved text; a file pedit cannot read is left
alone and that file offers no comments, as in a live room. On `--resume`, after the text writes of the same file, the
doc is rendered with the live room's code (`meta.Read`, `meta.Render`, anchors
placed on the merged text, keys of a newer pedit kept) and written through the
same journal as the text: a pending text is recorded before any write, the file
is created only once there is a thread, never removed, never written over a file
changed outside pedit, and replaying the log writes nothing twice. Browsers show
the live room's comment panel on the doc; a thread or reply made while the host
is away is a log entry like an edit, and a read link only reads. Older browsers
list the paired doc as an extra, empty text tab (it has no text, and
they skip updates to it).

Limits: the 1 MiB encrypted snapshot includes the comments docs; the 64-file cap
counts text files only (the bundle holds at most 128 entries).
Signatures authenticate editor access, not freshness. A relay can withhold
unseen updates or serve an older snapshot to a new guest. Expiry deletes the
room's active ciphertext. The interop test exercises publication, departure,
new guests, replay, resumed intake, truncation and expiry against a local relay.

`pedit --close [room|link]` ends a kept room from the host. It runs one resume
(fetch, merge, durable writes of every file, comments and image, checkpoint), then
sends `POST /keep/close` with the host token, then removes the record. The relay
deletes the snapshot, log and `kept/` blobs and leaves the closed marker, as expiry
does, so the ID is dead; a close of a closed or expired room succeeds. If any save
fails the host neither closes nor removes the record. Later requests answer 410;
the Worker adds `X-Pedit-Closed: host` when the host closed the room, so a guest's
next refresh shows "Closed by host" instead of the expiry text. Unsent guest edits
are lost, as on expiry.

## Work still to design

The following proposals concern broader asynchronous rooms and are not part
of the text-only implementation above.

### Security boundary

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

Signatures cannot make an untrusted relay available or prove that it delivered
every frame. A first-time guest with no independent fresh reference cannot
detect the relay presenting an older valid checkpoint and its log. A returning
host must retain its last accepted generation and reject a rollback. The UI
must not promise that an unavailable relay has retained an edit.

### Checkpoints and log

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

### Host recovery

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

### Images in kept rooms

A browser with an edit link prepares a pasted image as in a live room (strip
metadata, shrink to the limit), encrypts it with the blob keys, uploads it with
`PUT /api/rooms/:id/blobs/:blobId` and then inserts `![](assets/<hash>.<ext>)`
into the text, so the reference travels in the signed log entry. There is no
announcement and no host to answer: the relay accepts the blob while the host is
away, for the editor or reader token of the room (readers may only `GET`), under
the same per-room quota. The blobs live under `kept/<room>/`, apart from live
rooms' `rooms/`, and are deleted when the room expires, never when the host
leaves or by a live room's orphan check.

The host finds the references in the merged text (after the relay log is
applied and local edits merged) and, for each image not yet beside the file,
fetches the blob with the editor token, checks it against its hash and saves it
under `assets/` with the live room's writer. This happens after the journal
records the new text and before the file is written and the log truncated. An
image that is missing or does not match its hash is reported and does not block
the text; the blob stays on the relay until the deadline, so a later sync can
still fetch it.

### Lifetime and cleanup

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

### Verification before release

Tests must cover cross-language encoding, signature and access validation,
old epochs and duplicate frames, and reconnecting guests with no host. They
must interrupt recovery before and after each file and metadata write, before
and after journal publication, and before log acknowledgement. They must also
cover external edits, failed saves, compaction racing a join, storage limits,
expiration, and cleanup. An interoperability test must leave a room open for a
simulated week, edit and comment while the host is away, then verify that the
host saves the results and the covered log is removed.

### Work still to design

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
