# Security design

How pedit encrypts a room, what the relay can see and do, and what pedit does
not protect against. The short version is in
[privacy and security](../README.md#privacy-and-security).

## In a browser, you trust the relay

The relay also serves the browser editor's JavaScript. Whoever runs it can
serve a modified editor that reads the key from the address bar and sends the
document anywhere. End-to-end encryption protects you from a relay that only
relays; it does not protect you from whoever serves your editor: the relay's
operator, and Cloudflare, which hosts it. One browser guest in a room is enough
for this to matter to everyone in it.

To run no code from the relay:

- **Join with the CLI**: `pedit '<link>'`. It decrypts on your machine and runs
  nothing the relay sends. Install it from Homebrew, with `go install`, or from
  a release archive you check with `gh attestation verify`. `install.sh` is
  served from the relay's domain, so it is only as trustworthy as the relay.
  The CLI is still the maintainers' code, but everyone gets the same tagged
  release, which the relay cannot change for one user. Canvas rooms cannot be
  joined from the CLI yet.
- **Self-host** the relay and the editor ([self-hosting](self-hosting.md)). On
  Cloudflare, you then trust your own account and Cloudflare.

## Keys

- **Room key.** The host's `pedit` makes 32 random bytes for every room it
  starts (`GenerateKey` in `internal/protocol/key.go`, from `crypto/rand`,
  called in `internal/session/session.go` after the relay has made the room).
  The key travels only in the link's fragment: `/r/<room-id>#<key>`, base64url.
- **Frames.** Every message (document updates, cursors and names, attachment
  and canvas messages) is encrypted with AES-256-GCM under the room key itself:
  the raw link key, not passed through HKDF (`packages/protocol/src/key.ts`,
  `internal/protocol/cipher.go`). Each frame gets a random 96-bit IV and is
  sent as `iv || ciphertext`, the 128-bit tag at the end, with no additional
  authenticated data.
- **Attachment keys.** HKDF-SHA256 of the room key, empty salt. Info
  `pedit blob enc v1` gives the AES-256-GCM key for image bodies, and
  `pedit blob id v1` the HMAC-SHA256 key that names each stored image from its
  content hash. Receivers check decrypted images against that hash.
- **Admission token.** HKDF-SHA256 of the room key, info `pedit admission v1`.
  Clients send it to the relay to connect to the room and to read or write its
  images. The host's first connection registers it; the relay keeps only
  its SHA-256, and deletes that when the host leaves. The token cannot decrypt
  anything. See [room admission](contributing/room-admission.md).
- **Host token.** Not derived from the key. The relay makes it when a client
  creates a room (`POST /api/rooms`) and derives the room ID from it, so it can
  tell which connection is the host and end the room when the host leaves. It
  keeps no record of the tokens it made, so a client can also make its own.
  Peers never see it.

## What the relay sees and can do

It sees:

- IP addresses
- room IDs
- the admission and host tokens
- request headers such as `User-Agent` and `Origin`, which tell a browser from
  the CLI
- when connections open and close
- the size and time of every frame, and so when, and roughly how much, each
  person types
- which connection sent each frame, and which connection is the host
- the IDs, number and sizes of encrypted images (the same image shared twice in
  a room has the same ID)

It can drop, delay, replay or reorder frames, close connections and refuse
service. Document updates are Yjs updates, which can be applied in any order
and more than once
([Yjs](https://github.com/yjs/yjs/blob/main/README.md#document-updates)), so
replaying or reordering them does not change the document. Canvas edits typed
as JSON in the browser are not Yjs updates: the host applies each one once by
its ID but remembers only the last 256 IDs, so an edit frame that the relay
replays after 256 later edits is applied again.

It cannot read frames or images, and cannot make frames that peers accept:
AES-GCM rejects a frame made or altered without the key.

## What pedit does not provide

- **No authentication between participants.** Names, avatars and the host
  badge come from each peer's own presence state. Anyone with the link can
  claim any name, or to be the host, in what others see, and can send any
  edit. Frames carry no authenticated sender: the Yjs client ID in an update is
  one each peer picks for itself.
- **No forward secrecy.** A room has one key, never rotated. Whoever records
  the traffic and later gets the link can decrypt all of it. Every run of
  `pedit <file>` makes a new key.
- **The link is a bearer capability.** Anyone holding it can read and edit
  until the host ends the session. One person's access cannot be revoked.
- **No read-only link yet.** Every link can edit.
  [#122](https://github.com/piconic-ai/pedit/issues/122) plans comment-only
  links.

## Where a link can leak

Requests never carry the fragment, so the key is not sent to the relay or in
`Referer` ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer),
[MDN](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment)).
The editor also sets `<meta name="referrer" content="no-referrer">`. A link
preview or link scanner fetches the URL without the fragment, but the service
that runs it has the whole link. The editor asks for a name before it
connects, so a scanner that only loads the page does not join. The whole link,
key included, can still be in:

- the address bar, and browser history, which browser sync copies to your
  other devices;
- the chat or email you sent it through, and that service's storage;
- a shared screen or a screenshot;
- the host's terminal, which prints it, and its scrollback or session logs;
- the clipboard, where the host's `pedit` puts it, and any clipboard history
  or clipboard sync;
- shell history, and for a CLI guest, the process list (`ps`) while
  `pedit '<link>'` runs.

## More

- [What pedit does on your computer](local-files.md)
- [Room admission protocol](contributing/room-admission.md)
- [The public relay](public-relay.md): who runs it, what it logs, its limits
- Security records: the [October 5 review](security/2026-10-05-audit.md)
  (in Japanese, with an English summary) and the
  [October 12 local file access audit](security/2026-10-12-local-files.md)
- [Reporting a vulnerability](../SECURITY.md)
