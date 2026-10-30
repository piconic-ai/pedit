# Rooms that outlive their host

A live room normally ends when its host leaves. A host that asks for it keeps
the room open instead: guests stay connected, edit, and the host takes their
edits in when it comes back. This replaces the polling mode of
[async.md](async.md) once the clients ship; until then both exist. The relay
stays an opaque ciphertext relay: it learns sizes, times and counts, never
text or keys, and the host's local files remain the source of truth.

## Why the relay needs help

A live-room frame is `encrypt(sender || counter || message)`. The message type
(sync, awareness, ...) and the signature are inside the encryption, so the
relay cannot tell an awareness renewal, sent every 15 seconds by every peer,
from an edit. While the host is away it cannot decide alone what to keep. So
the sender says it, in the clear: a kind byte.

## Wire format (protocol version 6)

Every binary WebSocket message of a version 6 peer starts with one plaintext
byte, the kind. The relay reads only this byte; payloads are as before.
Integers (ids, cutoffs, tails) are unsigned 64-bit, big-endian.

| Kind | Direction | Payload | The relay |
| --- | --- | --- | --- |
| 0 `live` | any to relay | a frame as in version 5 | relays it to every other peer |
| 1 `entry` | editor to relay | one kept-text entry: a signed, encrypted update of one document | host away: appends it to the log with the next id, then sends it to every peer as kind 4. Host present: relays it unchanged as kind 1 and stores nothing |
| 2 `snapshot` | host to relay | a kept bundle | stores it as the room's snapshot, in place of the last; relays nothing |
| 3 `checkpoint` | host to relay | `uint64 cutoff` and a kept bundle | if `cutoff` is not beyond the tail: stores the bundle, deletes the entries up to `cutoff`, and answers `checkpoint <cutoff> <tail>`; otherwise answers `checkpoint refused` |
| 4 `logged` | relay to peer | `uint64 id` and the entry | an entry of the log, replayed or just appended |
| 5 `snapshot` | relay to peer | the kept bundle | sent first to a peer that joins while the host is away, and to the returning host if it holds less than the cutoff |
| 6 `log end` | relay to peer | `uint64 tail` | sent after the replay: the peer is up to date |

Kind 4 goes to the writer too: an entry coming back with its id is its
acknowledgement. Only the host may send kinds 2 and 3, and only editors kind 1;
anyone else is closed with 1008. Kinds 4 to 6 are the relay's alone. A kind a
version does not know is ignored.

Text messages stay control messages. `host away` and `host back` are as before.
New:

- `kept <until-ms>`: to every peer when the room goes into the kept state, and
  to each peer that joins during it. Edits are kept until then.
- `keep <seconds> <until-ms>`: to the host after it connects, the keep the
  relay will honour after clamping. `until` is 0 while the host is present.
- `checkpoint <cutoff> <tail>` and `checkpoint refused`, as above.
- `log full`: an entry the log has no room for. It is not relayed.

### Version 5 peers

A version 5 client has no kind byte. The relay tags each socket `v5` or `v6`
when it accepts it and answers in the version the client offered (the newest
of those it serves). A kind 0 frame sent to a version 5 peer loses its byte; a
version 5 peer's frame gets kind 0 before it reaches version 6 peers. Kinds 1
to 6 are never sent to a version 5 peer. In a kept room such a peer is told
`host away`, as for a host that dropped, and stays read-only; it catches up by
Yjs sync when the host returns. A version 5 host cannot keep a room.

## Lifecycle

- **Keep.** The host declares it at connect with the request header
  `X-Pedit-Keep: <seconds>`, which the Worker passes on only with a host token
  that checked out. The room clamps it to `KEEP_MAX_SECONDS`, stores it, and
  answers `keep`. The keep is fixed at the room's first host connection, since
  it decides where images go (`kept/` from the first upload, never `rooms/`): a
  later connect, with another value or none, is answered with the stored keep,
  and a room first connected without one cannot gain one. Zero or none: the room ends when the host leaves, as always.
  A room with a keep lasts until `openedAt + max(ROOM_MAX_SECONDS, keep)`.
- **Snapshots.** The host sends a snapshot right after connecting, after every
  200 entries it took in or 5 minutes with changes, and just before leaving.
  The relay keeps the latest. A room without a snapshot cannot be kept: it ends
  as today.
- **Kept state.** It begins when the host leaves on purpose (close code
  `HOST_LEFT`), or when a host that dropped does not return within the grace
  period, and the room has a keep and a snapshot. The relay stores
  `keptAwayUntil = now + keep` (at most the room's deadline), tells every peer
  `kept <until>`, and arms its alarm for that time. Nobody is closed.
- **While kept.** Kind 1 entries are appended (4 MiB and 10,000 entries at most,
  as in kept text) and sent as kind 4. Kind 0 frames are relayed as always, for
  awareness and for read-only peers' requests. A reader that sends a kind 1 is
  closed. Images can be added by editors and fetched by anyone with a link,
  under `kept/`.
- **Join.** A peer is sent kind 5, kind 4 for every entry after its
  `X-Pedit-After` header or `after` query parameter (default: the cutoff), then kind 6. With an `after`
  that is at least the cutoff it holds the snapshot already and gets no kind 5.
- **The host returns.** It connects with its token and `X-Pedit-After`. It is
  sent kind 5 only if `after` is below the cutoff, then the entries after
  `after`, then kind 6. The room leaves the kept state and tells peers
  `host back`. The host sends a checkpoint, which truncates the log. Entries
  that arrive between its connecting and the checkpoint are relayed as kind 1
  and not stored.
- **Deadline.** When `keptAwayUntil` passes, by alarm or at the next message,
  the room ends with `ROOM_EXPIRED`: everyone is closed, and the snapshot, the
  log and the images are deleted. The time the host first connected stays, so
  the ID is not opened again.
- **Closing.** `POST /keep/close` with the host token and `X-Pedit-Tail` ends a
  kept room early, after the host took in every entry (a later entry gives 409).
  It does the same teardown, closing peers with `ROOM_CLOSED`.

## Clients

The browser (`RoomClient` in `packages/protocol`, `packages/web`) speaks version
6 and does this:

- **Kept.** On `kept <until-ms>` the client enters the `kept` status: the
  editor stays editable, and the header and banner say that the host is away,
  until when the room is kept, and that edits are kept. The two minutes of
  grace, and a relay of version 5, still mean `host away`: the status is
  `waiting` and the editor is read-only. `log full` is the status `log-full`:
  read-only again, as no further edit would be kept.
- **Edits.** While the room is kept, an edit of a text file or its comments is
  not a live update but a kind 1 entry: one document per entry, named by its
  file ID, signed and encrypted as in kept text mode (`sealKeptUpdate`, shared
  with `KeptTextClient`). It is pending, and the header says `sending`, until
  the same entry comes back as kind 4 with an ID, which acknowledges it. A
  connection that drops keeps its pending entries and sends the unacknowledged
  ones again after the next kind 6. Only edit links send entries; a read link
  never does, and a comment link cannot comment while the host is away. A canvas
  is not kept.
- **Joining.** Kind 5 is opened as a kept bundle: the files it lists become the
  room's manifest, and a file the page opens later is built from it and from
  the entries since. Kind 4 entries are verified (the editors' signature, the
  kept-text checks of `trial`) and applied; one that does not hold is skipped
  and counted, and the banner says how many. Kind 6 gives the cursor `after`.
- **Reconnecting.** A browser cannot set `X-Pedit-After` on a WebSocket, so it
  sends the cursor as the query parameter `after=<id>` on the `/ws` URL, which
  the relay reads when the header is absent.
- **Images.** The page uploads to the blob routes with the room's admission
  token, as in kept text mode, and links the image under `assets/`; the host
  saves it on its return.
- **Host back.** The client drops what it holds, shows `connected`, and greets
  the room as on connecting: a fresh handshake, and a sync step 1 and its state
  for every document, so the host reconciles what it missed. The page asks
  before it is closed with entries still pending.

## What the relay learns

The same as kept text mode: sizes, times, the count of entries. The log stores
no sender; the entry carries its own, signed and encrypted.

## Not in this design

Canvas while the host is away (it needs replay counters the host persists),
removing the HTTP kept endpoints and the `?keep=1` page, and changing the
default keep.
