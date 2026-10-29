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

## Browser outbox prototype

The browser outbox wraps each sender seed and binds it to its logical sender ID
and certificate with a key derived from its access link secret and the
room-bound frame secret. Sender rows from earlier prototypes without this
binding fail closed. It encrypts each local operation
under that tier key and binds its sender and sequence. The next sequence and
the operation are saved in one IndexedDB transaction after a compare-and-swap
on the authenticated counter. Ciphertext is saved before sending and reused
for a retry in the same epoch. An authenticated local marker records an ACK
only when the caller supplies the matching epoch and ciphertext.
The prepared or unprepared state, epoch, generation and exact ciphertext are
authenticated with the tier wrapping key. Rows from earlier outbox prototypes
without this binding fail closed; they cannot be migrated safely without a
trusted copy of their prepared state. A rollback to an earlier authentic state
remains undetectable without an external trusted anchor. This includes restoring
one previously unprepared operation row after it was prepared: the restored row
can be prepared again in another epoch even if the other rows are unchanged.
Rollback can also remove a previously recorded ACK.

This primitive is not connected to the editor or transport. The caller must
wait for persistence before reporting local durability, replay operations into
Yjs when restoring, and authenticate the relay response before recording an
ACK. It cannot change epochs until a verified checkpoint establishes which
operations were applied. Until safe retirement is implemented, the outbox
accepts at most 64 senders per browser database and 1,024 operations of at most
64 KiB per sender. It fails instead of deleting accepted history at the limit. The strict IndexedDB durability option is a browser
hint, not a guarantee against device failure, site-data deletion, eviction,
or rollback of browser storage. Storage loss must not be reported as saved.
Outbox connections close on version changes. An upgrade blocked by an older
connection fails the open call; if that connection later closes, the abandoned
upgrade is aborted. IndexedDB does not cancel the pending open request, so
other open requests can still wait behind it until the blocker closes.

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

The internal session start path can build a text document and its comments
from caller-verified Yjs checkpoint states instead of reconstructing them from
the local files. In this mode the filewriter is held from creation, comments
saving is held, and stopping reports the hold. It exposes the current local
and recovered text for comparison without treating a match as permission to
write. Extra files, canvas recovery, file watching and attachments are not
enabled in this mode.

The internal tail path verifies each encrypted record, checks its ledger
sequence and access tier, and applies it to isolated candidate documents.
An exact duplicate is skipped according to its recorded applied or rejected
outcome; a conflicting digest or a sequence gap fails the batch. A
failure discards the candidates and leaves the caller's checkpoint and ledger
unchanged. Only after all records pass does it construct the held session. The
session does not create a relay room or connect to one. Text updates use the
existing Sync message, and comments updates use Files with the metadata ID
from the authenticated single-file manifest.

An internal read path starts from the exact signed checkpoint saved in the
initial host baseline and verifies the fixed tail before constructing this held
session. It cannot establish that the relay supplied every unseen update. It
persists a separate private candidate on supported filesystems before opening
the local file or project. Its file comparison is unavailable. If publication
or later local session construction fails, the caller receives the candidate
and any published path with the error. It does not compare local comments, safely release the hold, or commit
the relay cut. The candidate is for inspection and does not prove relay tail
completeness. The relay data must remain available until a separately durable
recovery is complete. A missing local text file or malformed local metadata
does not prevent candidate retention; recovery leaves both untouched.
The text check rejects known attachment references, but a string scan cannot
prove that the attachment inventory is empty. Saving and cut acknowledgement
remain unavailable until the caller verifies the complete inventory.
The checkpoint text validator accepts only a complete Yjs V1 plain-text
snapshot under the `content` root; other roots, embeds, formatting and garbage
collection structs are rejected. Incremental tail updates are validated against
the supported text and comment subsets before and after applying them. This
does not enable live host synchronization or establish tail completeness.

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

The internal transport persists its lifetime model and an alarm in a storage
transaction. Its host-authenticated transitions cover leave, return and close;
its log operations check the stored lifetime when writing and after syncing.
The real Room does not yet invoke these transitions or its alarm, and the
transport has no public route. The model retains the requested duration and
applies the current relay cap whenever the host leaves. With a finite room
limit, a departure extends the total deadline to at least the resulting keep
deadline. A returning host keeps the extended total deadline. A later departure
starts a new keep period, subject to the then-current cap. An unlimited total
lifetime has no total deadline, but an absence still ends at its keep deadline.
The closed state cannot be reopened. Each time observation is checked against
the last observed time and returns the updated state, closing it at the
deadline. The caller must persist every observation and transition before
reporting or scheduling from it. It must also persist closed before deleting
room data, and coordinate the alarm with that state. A backward clock is rejected
until a valid time is available, including for an explicit host close. Restored
data must pass the lifetime parser. A failed log transaction preserves its
clock observation in an outer transaction and synchronizes it before returning
the error. If expiry is observed before cleanup, a closed state can remain with
the log still present; a subsequent alarm retries cleanup. The runtime's output
gate must hold network responses until pending storage writes are durable. On
restart the saved observation is the lower bound for accepting the clock. A
crash before synchronization can lose an unacknowledged observation, so it
cannot be recovered or used to detect a rollback. Clients must not treat a
missing response as confirmation.
The internal prototype closes its durable log and admission on expiry, close or
maintenance, but it does not remove R2 attachments. It must not be exposed
until real socket lifecycle and attachment cleanup are integrated and tested.
The Room alarm dispatches kept admission to the internal lifetime observer,
including after eviction, so a hostless kept room does not enter v5 cleanup.
The internal initialization path stores admission, the initial away lifetime,
checkpoint, policy and alarm in one transaction. It tracks authenticated host
sockets using a separate tag and reconciles their presence on alarms and close.
These internal paths are not routed by the public Worker. Attachment cleanup,
independent retry discovery, guest sockets and public routes remain unconnected.

The separate kept attachment cleanup primitive uses `kept/<object-id>/`, so
the existing `rooms/` age rule does not apply to it. Every PUT reserves a
bounded count and byte quota in Durable Object storage and syncs it before
calling R2. A failed or interrupted PUT remains uncertain. After close, each
sweep schedules another alarm before reading or deleting R2 objects. It removes
a confirmed reservation only if the PUT completed before the sweep took its
reservation snapshot.
An uncertain reservation remains indefinitely and prevents a completed result;
later sweeps delete any object it produces. This depends on R2's strong
read-after-write and list consistency.

This primitive is not connected to the room or its lifecycle. The room must
atomically mark attachments closed with room expiry, route alarms to the sweep,
authorize every PUT, and enforce its own policy before using it. Its deployment
must check that no lifecycle rule covers `kept/`. An interrupted PUT can leave
a reservation and periodic cleanup forever; the service needs an operational
policy for those retained markers and for alarm failures. The prototype cannot
prove a PUT with an ambiguous outcome has stopped.

An internal Room fetch path exposes a fixed checkpoint and tail to an
authenticated host or tier capability. It is not routed by the public Worker.
The response contains base64 ciphertext, with no key or plaintext; clients
must request a new fixed read after the tail to catch up. The read path does
not provide durable client cursors or live delivery. The older internal
transport initialize method still commits admission separately from lifetime
and checkpoint; it must not be used for public initialization.

An internal Room append endpoint accepts editor or commenter capabilities and
stores bounded opaque ciphertext at the current epoch. Exact retransmissions
return the same sequence. Each capability tier has a shared in-memory rate
allowance and at most eight simultaneous bodies; the allowance resets on
Durable Object eviction. Body reads have a 30-second timeout and reject more
than 16,384 stream chunks, including empty chunks. This may reject a valid body
delivered in unusually small fragments. Recipients must still verify signatures
and operation permissions. The public Worker does not expose this endpoint.

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

Read sessions reserve eight of the 64 slots for each higher tier: commenter,
editor and host. A higher tier can preempt the oldest session of the lowest
lower tier when its capacity is full; preempted participants must restart.
Existing host sessions retain host priority during migration. Older non-host
sessions are treated as reader sessions. A tier can still exhaust its own
capacity with unfinished sessions; they expire after five minutes.
The internal initialization path reads `KEEP_MAX_SECONDS`. Production and
preview configuration set it to 604800 seconds; an unset value is unlimited
for self-hosting. A configured value must be a positive safe integer; invalid
configuration refuses initialization. The requested duration is clamped to
the configured limit and `X-Pedit-Keep-Seconds` in the successful response
reports the applied value. Durations that cannot produce a safe timestamp are
rejected. The selected policy is persisted with the room; a later configuration
change does not silently change it. An authenticated retry uses the saved
policy and reports its applied duration even when the current limit changes;
a different checkpoint, capability set, or effective duration is rejected.
This internal path is not public yet.

The internal Room blob prototype accepts encrypted uploads only from an
editor or host capability and permits encrypted reads to all authorized tiers.
It checks the kept lifetime before and after R2 operations and enforces a
bounded request body, concurrent uploads, and persisted count and byte quota.
A kept lifecycle close marks the blob state closed and arms cleanup in the
same Durable Object transaction that closes the log. The Room alarm then sweeps
the kept prefix, including after eviction. The internal route is not exposed by
the Worker and does not enable kept rooms for users.

An ambiguous or late R2 PUT remains reserved and must be swept again. This
prototype has no independent registry or cron: alarms have finite automatic
retry and may cease to run after repeated failures. Consequently it does not
ensure eventual deletion or bound orphan retention. Cleanup stops its retry alarm
only after an empty listing and removal of all completed reservations; any
unresolved reservation keeps the alarm armed. The configured lifecycle
must not expire active kept data, especially for unlimited self-hosted rooms;
no deployment or R2 lifecycle change is made here. R2 operation deadlines, rate
limits, independent scheduling, and full cross-operation recovery must be
resolved before enabling this path.

Kept upload request bodies have a 30-second deadline and a bounded chunk count.
At most three editor uploads can be in progress, leaving one of four slots for
the authenticated host. A request already sent to R2 may still remain in
flight after that body deadline; a pending reservation is retained, and an
in-flight upload of the same ID can still block another upload of that ID.

A completed ID may be retried only with byte-identical ciphertext, after
comparing the R2 object and syncing its reservation. Different bytes or an
ambiguous reservation return 409 without replacing the object. Existing web uploads use random AES-GCM IVs,
so the same plaintext can produce different ciphertext under the same hash ID.
A future v6 uploader must retain its ciphertext for retry, or fetch the existing
object, decrypt it, and check the expected plaintext hash before reusing it.
The relay cannot establish plaintext equality from ciphertext alone.

### Restricted text checkpoint payload

The Go and browser checkpoint codecs accept one plain-text document and its
separate comments document, with a matching two-entry manifest and a ledger.
They reject additional files, canvas content, and payloads marked with present
or unverified attachments. Encoders require the caller to attest that the
attachment inventory is complete and empty. A text scan rejects known local
asset references, but it cannot prove that all attachment formats or sources
are absent; callers must establish that independently before recovery or ACK.

Both codecs structurally validate complete Yjs V1 snapshots before applying
them. Text accepts only the supported plain-text root and rejects standalone
GC structures whose root cannot be established. Comments accept the supported
map-only form and bounded values. Comment snapshots conservatively cap total
Yjs clocks at 1024 and apply an encoded-size budget that includes per-clock
and per-client overhead. They reject undefined, bigint, non-finite floats,
negative zero, and `__proto__` keys in Any objects, whose meaning or JSON
representation can differ between Go and JavaScript. Both codecs reject unknown
roots, incomplete updates, trailing bytes, noncanonical integers, unsafe
JavaScript integers, and malformed UTF-8. This is structural validation, not semantic validation
of every comment or proof that the ledger and documents were captured
atomically. Callers must authenticate the enclosing checkpoint and enforce
comment semantics and resource limits before accepting it. The codec is not
connected to a public route or an active recovery flow.

The Go and browser tests share `kept-schema-mutations.json` and
`kept-schema-generated-mutations.json`. Regenerate the latter from the repository
root with `go run ./packages/testdata/cmd/kept-schema-mutations`; both test
suites check the same results, alongside the Go and browser payload fixtures.

### Experimental independent attachment sweep

An experimental test-only sweep registry registers a room before its R2 PUT.
The Room first persists an unsent reservation, then registers its Durable
Object ID, then persists the transition to a possibly in-flight PUT before
calling R2. A closed room may discard an unsent reservation, including one
whose pending registry RPC later returns: that PUT checks the reservation again
and never starts. A PUT that may have reached R2 remains unresolved until its
completion is known; an empty listing does not prove such a PUT has stopped.

Each registry shard keeps at most 100,000 room IDs. Registration fails closed
when full; it does not start a new PUT. The scheduled worker visits at most 16
rooms per shard per invocation, and advances its persistent cursor even if a
room fails. A closed room is retired only after its R2 prefix is empty and all
possibly in-flight reservations have resolved. Retirement is conditional on a
monotonic registration generation, so an old sweep cannot erase a concurrent
new registration. Uncertain PUTs can remain registered forever and eventually
exhaust capacity; this implementation does not claim a bounded deletion time.
Retry delay depends on the number of registered rooms and scheduled invocations.
A delivery timeout does not cancel a Durable Object RPC. The Room coalesces
concurrent sweep calls so a stalled operation is not repeatedly started by the
same Room instance. A stalled registration also leaves its RPC in flight;
after its timeout, the Room fails subsequent registration attempts closed until
that RPC settles or the Room instance is evicted. No further PUT is started.
Each scheduled invocation stops a shard after a failed or timed-out registry
read or retirement. A shard accepts at most one storage operation across
registration, reads, and retirement; other operations fail closed while it is
unresolved. Different room registrations and retirement results are never
shared. A transport that stalls before the
RPC reaches the shard is limited to one attempt per invocation, but cannot be
coalesced across different scheduled invocations by this design.

The registry binding and cron are configured only by tests; the internal upload
path fails closed without the binding. Enabling kept rooms requires a production
binding, migration, schedule, capacity monitoring, and an operational policy for
uncertain PUTs. No age-based R2 lifecycle is applied to live kept attachments.
Registration failures return 503 after authorization; the v6 attachment client
retries that status with the same ciphertext within its existing deadline. A
403 remains a refusal and is not retried as a transient registry failure.

The separate v6 `KeptAttachmentClient` derives the blob ID from plaintext,
keeps one encrypted body for a network retry, and uses the editor capability to
upload. On a 409 it reads with the reader capability, decrypts the existing
ciphertext, checks the expected content hash, and compares the complete bytes
before reporting reuse. A missing, oversized, corrupt, or different object is an
error. The client does not announce the image, edit a document, or make the
internal Worker route public. Each upload has a 30-second overall deadline, which callers may shorten or
cancel. Callers must retain the local attachment until their document state is
durable. A timeout cannot guarantee an already submitted PUT stopped. Cleanup
and independent orphan scheduling remain separate prerequisites.


When an upload conflicts but the existing blob is not yet visible, the v6
client retries the same ciphertext with a delay until the overall deadline. It only
reports reuse after reading, decrypting, and checking the existing plaintext.
Timeout leaves the result unresolved and never implies a
successful upload.

The internal v6 guest socket is an invalidation channel: after a durable
append it sends only a constant `changed` message, never plaintext, tokens or
ciphertext. The client subscribes before beginning its fixed read and repeats
that read if a notification arrives during it. A periodic fixed read also
covers a commit whose notification is lost, and a reconnect starts a new read.
A disconnect invalidates the live reader; its caller must create a new one.
Browser timer throttling and offline periods can delay catch-up, and a relay can
still omit an unseen tail. Inspections remain non-applicable and do not ACK,
cut, or write files. Neither this socket nor the client is publicly routed or
connected to the editor.

For internal guest sockets, `ROOM_READERS` limits reader sockets and
`ROOM_GUESTS` limits editor plus commenter sockets. Within the 32 socket
ceiling the Room reserves a slot for the host. An arriving commenter can
disconnect a reader when the socket limit is full, and an arriving editor can
disconnect a reader or commenter. When the configured writer limit is full,
an editor can disconnect a commenter to make room. Read and socket requests
use the highest admission tier available in the link.

The Go retained-checkpoint validator limits each text or comment document to
1,024 work units before applying Yjs. Multi-file checkpoints share that budget
across their documents. Recovery separately limits text and comments to 1,024
units each across the checkpoint and all newly applied tail records. Each
encoded struct costs one unit; each delete range costs two for possible
boundary splits. This conservative limit bounds conflict lists before applying
an update. A fragmented but valid document can exceed the limit and is then
left unapplied; the relay history and local file remain unchanged. This is a Go
resource limit, not a change to the shared wire format.

Reopening or exporting a held recovery candidate also checks the text and
comments work limits before applying either Yjs state. Candidate files are
private local inspections, not authenticated checkpoints; exceeding either
limit rejects the candidate without modifying the original file.
