# Wire protocol

For someone changing `internal/protocol` (Go) or `packages/protocol`
(TypeScript). The two implement the same wire format and must change
together; `packages/testdata/*.json` pins the encodings both are tested
against. This page is the format between peers through the relay. How a
client is admitted to a room is in [room admission](room-admission.md); how a
room is kept while its host is away in
[rooms that outlive their host](../design/rooms-away.md), whose kind byte
every binary message has carried since version 6.

## Versions

Clients offer the protocol versions they speak as WebSocket subprotocols,
`pedit-v<N>`, newest first (`ClientProtocolVersions` in
`internal/protocol/admission.go`, `CLIENT_PROTOCOL_VERSIONS` in
`packages/protocol/src/admission.ts`), and the relay picks the newest it
serves. Today clients offer 8 and 7, and the relay serves 7 to 8. A relay that
serves none of the offered versions closes with `4002` (the client is older)
or `4003` (the relay is older); clients stop reconnecting and ask to update
pedit or reload the page.

| Version | What it added | Design |
| --- | --- | --- |
| 6 | A kind byte in front of every binary message, for rooms kept while the host is away | [rooms-away.md](../design/rooms-away.md#wire-format-protocol-version-6) |
| 7 | Canvas board edits in kept rooms; the relay no longer serves older peers, which cannot replay them | [rooms-away.md](../design/rooms-away.md#canvas-scope-and-replay) |
| 8 | The relay admits comment links as commenters, who may write comment entries while the host is away | [kept-comments.md](../design/kept-comments.md) |

While pedit is 0.x, patch releases keep the wire format compatible. Additive
changes (a new message type or kind that older peers skip) do not change the
version. A change older peers cannot skip bumps the version, ships in a minor
release and is noted in the CHANGELOG.

## Links and keys

A room link's fragment holds the secrets of its access (#122): an edit link
the edit secret S, a comment-only link `c.` and the comment secret C with the
editors' verifying key, a read-only link `r.` and the read secret V with both
verifying keys. S derives the editors' Ed25519 key and C, C the commenters'
Ed25519 key and V, all with HKDF-SHA256; the frame key K is derived from V,
the room id and both verifying keys (`internal/protocol/access.go`,
`packages/protocol/src/access.ts`, `packages/testdata/access-vectors.json`).

## Frames and signatures

A frame is `iv || AES-GCM(K, sender || counter || message)`. `sender` is 16
random bytes each client picks when it starts, and `counter` a big-endian
uint64 it raises by one for every frame it sends, across reconnects.

Editors and commenters sign every message: `5 || tier || Ed25519 signature ||
type || payload`, tier `0` for the editors' key and `1` for the commenters',
the signature over a context string, the tier, `sender || counter` and
`type || payload` (`signed.go`, `signed.ts`). Readers send `type || payload`
unsigned. Receivers check the signature first, then drop a signed frame whose
counter is not above the last one from its sender and tier, and their own:
the relay could send any frame again.

What a frame may do follows from the tier that verified: commenters change
only the docs of a file's comments, readers nothing; both may ask for a doc's
state (SyncStep1) and for attachments (`want`).

Message types: `0` sync, `1` awareness, `2` attachment, `3` canvas, `4` files,
`6` fresh; `5` marks a signed message. Clients skip types they do not know, so
newer peers can add more.

## Fresh nonces

A peer that has just joined has no counter from anyone, so a reader could
have it take an editor's frame kept from before. A fresh message carries the
sender's 16-byte nonce of its connection, then, in an answer, the nonce it
answers. Each client sends one first on every connection, and answers every
nonce it has not answered yet. A receiver takes a signer's frames only from
the signer's answer to its own current nonce on, whose counter becomes the
signer's floor; until then the signer's frames count as a reader's requests
and its awareness is dropped. After answering, a client sends its awareness
again, and its state if it sent content of its own lately, or since
connecting when the asker was in the room first; attachments and canvas
messages it holds after connecting until the answers settle (`fresh.go`,
`fresh.ts`).

## Awareness

Awareness frames hold one entry, the sender's own state; nobody forwards
another client's state or its removal. Each peer remembers, per client ID,
the highest access it heard the ID's state with, drops states for it from
below that, and shows participants' access and the host's fields from that,
never from the state. Signed states are applied at the next clock after the
one held; unsigned ones may not claim a clock past 2^32 (`presence.go`,
`presence.ts`).

## Several files

A room that shares several files keeps each in a Y.Doc of its own. File `0`
is the room's own doc, synced with plain sync messages as in a room that
shares one file; the others are synced in files messages. These carry a lib0
varint kind: `0` manifest (a count, then for each file its id, path and
format), the host's list of the room's files, which replaces any sent before;
`1` doc (a file id other than `0`, then a sync, attachment or canvas message,
type byte and payload, as in a room that shares one file). The host routes
messages only by the ids it issued, never by a path. Paths pass the checks in
`internal/protocol/path.go` and `packages/protocol/src/path.ts`
(`packages/testdata/path-vectors.json`), and
`packages/testdata/files-vectors.json` pins the encoding. A room can start
with one file and add more, and an older peer, which skips type `4`, goes on
editing file `0`.

## Attachments

Attachments (images) are named by content: `hash` is the first 128 bits of
SHA-256 of the bytes, in hex. Their bytes are encrypted with a key derived
from the frame key (HKDF-SHA256, info `pedit blob enc v2`) and stored under
`blobId`, the first 128 bits of HMAC-SHA256 over `hash` with another derived
key (info `pedit blob id v2`), in base64url. The server sees neither the
content nor its hash.

Attachment messages carry a lib0 varint kind and fields: `0` announce (hash,
mime), `1` want (hashes), `2` stored (hash, path), `3` rejected (hash,
reason). `packages/testdata/blob-vectors.json` pins the derivations for both
implementations.

## Close codes and text frames

The relay closes a WebSocket with one of these codes
(`packages/protocol/src/close.ts`, `internal/protocol`):

| Code | Meaning | Clients |
| --- | --- | --- |
| `4001` | The host left; the session is over | Do not reconnect |
| `4002` | The client speaks an older version than the relay | Do not reconnect; update pedit or reload the page |
| `4003` | The client speaks a newer version than the relay | Do not reconnect; the relay has to be updated |
| `4004` | The room already has as many guests as the relay allows | Do not reconnect by themselves |
| `4005` | Too many connections from the client's network just now | Reconnect, after a longer wait than for a dropped connection (the CLI waits 10 seconds) |
| `4006` | The relay is closed for maintenance | Stop; reconnect only when the person asks (Reconnect in the editor, Enter in the host's pedit) |
| `4007` | The room reached the relay's time limit, from its host's first connection | Do not reconnect; the room ID is never reopened |
| `4008` | Sent by a host that ends the session on purpose (Ctrl+C); the relay then closes the room with `4001` for everyone else | |
| `4009` | The page's origin is not one the room admits ([per-room origins](../design/embedding.md)) | Do not reconnect; the host has to list the origin first |

The relay also sends a few text frames of its own, the only frames not from a
peer and not encrypted: `host away` and `host back` around a host's grace
period, `kept`, `kept comments`, `keep`, `checkpoint`, `checkpoint refused`
and `log full` for kept rooms ([rooms-away.md](../design/rooms-away.md)), and
`pedit pong` in answer to a client's `pedit ping`, which checks that the room,
not only Cloudflare's edge, still has the connection.
