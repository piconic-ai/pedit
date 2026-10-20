# Room admission protocol

The room ID is routing metadata visible to the relay and to request logs. A
client must also present a capability derived from the room key before it
can occupy a WebSocket slot or read/write encrypted attachments. This keeps
someone who knows only the ID from exhausting a room's peer or blob quota.

## Derivation and transport

Both Go and TypeScript derive 32 bytes with HKDF-SHA256: input key material
is the decoded 32-byte room key, salt is empty, and info is the UTF-8 string
`pedit admission v1`. Encode the output as unpadded base64url (43 characters).
The dedicated info string separates this capability from the AES-GCM frame
key and both attachment keys. Never send the room key or reuse an encryption
key as the capability.

WebSocket clients offer two subprotocols:

```text
Sec-WebSocket-Protocol: pedit-v4, pedit-admission.<token>
```

The server selects only `pedit-v4`, never echoes the capability, and rejects
missing, malformed, or multiple admission tokens. Browsers use the standard
WebSocket protocols argument; the Go client uses its handshake options.
Blob GET and PUT requests send `X-Pedit-Admission: <token>`. The capability
never appears in a path, query string, response body, or application log.
Custom infrastructure must redact these request headers.

## Registration and lifetime

The Worker still validates the host's independent bearer token against the
room ID and strips caller-supplied `X-Pedit-Host`. Only a verified host can
register an admission verifier in the Durable Object. The verifier is
SHA-256 of the admission token's UTF-8 representation; it is persisted in
SQLite KV and checked with Workers' constant-time `timingSafeEqual`.
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
