# Room admission protocol

The room ID is routing metadata visible to the relay and to request logs. A
client must also present a capability derived from the room key before it
can occupy a WebSocket slot or read/write encrypted attachments. This keeps
someone who knows only the ID from exhausting a room's peer or blob quota.

## Derivation and transport

A room has two capabilities (#122). Both Go and TypeScript derive each as 32
bytes with HKDF-SHA256 and an empty salt (see `internal/protocol/access.go`):

- the **editor token**, from the edit secret in an edit link, info
  `pedit v5 edit admission`;
- the **reader token**, from the room's frame key, which every link derives,
  info `pedit v5 read admission`.

Encode each as unpadded base64url (43 characters). The dedicated info strings
separate these capabilities from the AES-GCM frame key and both attachment
keys. A comment-only or read-only link yields only the reader token. Never
send a link's secrets or reuse an encryption key as a capability.

Editors offer the editor token, and comment-only and read-only links the
reader token. The relay uses the difference only to keep places and uploads
for editors: what anyone may change in the room, every peer checks by
signatures the relay cannot see.

WebSocket clients offer two subprotocols:

```text
Sec-WebSocket-Protocol: pedit-v5, pedit-admission.<token>
```

The server selects only `pedit-v5`, never echoes the capability, and rejects
missing, malformed, or multiple admission tokens. Browsers use the standard
WebSocket protocols argument; the Go client uses its handshake options.
Blob GET and PUT requests send `X-Pedit-Admission: <token>`. A blob PUT
needs the editor token; a GET takes either. The capability
never appears in a path, query string or response body, and the relay's own
code never logs it. Request logs are another matter: the host also sends the
reader token in `X-Pedit-Read-Admission`, and logs that keep request headers
keep these three headers. The public relay's Workers Logs do, in plain text,
for the 7 days the logs are kept ([public relay](../public-relay.md#logs)).
The public relay accepts this: a token cannot decrypt anything, admits only
to its room, and stops working when the room ends, within 24 hours, since the
room's verifiers go with it and its ID cannot be used again. A relay that
should not keep them turns off its request logs or redacts these headers.

## Registration and lifetime

The Worker still validates the host's independent bearer token against the
room ID and strips caller-supplied `X-Pedit-Host`. Only a verified host can
register the admission verifiers in the Durable Object: the editor token it
offers as its subprotocol, and the reader token it sends in
`X-Pedit-Read-Admission`, which the room ignores on any other request. Each
verifier is SHA-256 of the token's UTF-8 representation; they are persisted
in SQLite KV and checked with Workers' constant-time `timingSafeEqual`. A
reconnecting host must offer the registered editor token.

Readers (the reader token) take places of their own, `ROOM_READERS` (as
many as `ROOM_GUESTS` unless set), so they cannot take editors' places: the
cap of 32 connections a room takes counts editors and hosts only.
Only the editor token may start the grace period of a host cut off by a
deploy.
Concurrent handshakes read the verifier after hashing, and cannot change it
while the session exists. No token/key verifier can be installed by a guest
or a blob request.

Admission precedes peer-slot allocation and R2/quota operations. A guest
connecting to a closed room with a syntactically valid admission protocol
still receives close code 4001, without obtaining a hibernating peer slot.
A room past its time limit refuses every connection with 4007 (the code
sent to sockets open at the deadline) before admission, so it never
registers a verifier again. Clients released before 4007 existed treat it as
an ordinary drop and reconnect with backoff; every current client stops.
The verifier survives hibernation and is removed with the quota when the
last host leaves. A host that leaves on purpose closes with 4008 and the room
ends at once; a host whose connection drops otherwise gets a grace period
(`HOST_GRACE_SECONDS`, two minutes by default): the relay keeps the session,
admits guests, sends them the text frame `host away` (and `host back` when the
host returns), and ends the room with 4001 only if the host does not come back
in time. Guests do not edit meanwhile. Document updates retain their existing encryption and
wire format. A capability does not confer the host role and does not enable
decryption; possession does allow use of the relay's room resources.

## Compatibility and verification

Update the CLI, relay, and browser bundle together and restart sessions.
Old clients without admission are rejected. Already-open sockets from an
older deployment must be closed as part of the rollout. There is no fallback
to room-ID-only admission.

The Go and TypeScript unit tests use an independently computed HKDF vector.
Worker tests cover invalid/missing tokens, host-header spoofing, unauthorized
blob quota consumption, guest registration attempts, and hibernation. The
Go/JavaScript interoperability server enforces admission and negotiates the
public subprotocol on real WebSockets, including Node's custom-header path.
