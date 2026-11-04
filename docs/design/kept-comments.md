# Comments from comment links while the host is away

A kept room ([rooms-away.md](rooms-away.md)) lets edit links go on editing and
commenting while the host is away. A comment link becomes read-only then. For a
review page ([embedding.md](embedding.md)), comment links are the usual way to
invite reviewers, so this changes that: while the host is away, a comment link
can add, answer, resolve and delete comments, as it can in a live room, and
still cannot touch the shared files.

## Why it is read-only today

Two things stop it, one at the relay and one in the entries:

- **The relay cannot tell a comment link from a read link.** A comment link
  connects with the reader admission token, which every link can derive from
  the frame key. The relay has two roles, editor and reader, and only an editor
  may send kind 1 entries (`room.ts`). In a live room this does not matter:
  comments travel as kind 0 frames, and the peers check their signatures.
- **Kept entries are edit-signed only.** `sealKeptUpdate` requires the edit
  signer, and `openKeptFrame` verifies every entry with the editors' key. A
  comment-signed entry would be skipped and counted by every peer and by the
  host on resume.

## Design (protocol version 8)

### A commenter role at the relay

- **A comment admission token.** `HKDF(C, "pedit v8 comment admission")`, where C
  is the comment secret. An edit link derives it from S (S gives C), and a comment
  link has C. A read link has only V and cannot derive it. Like the other tokens,
  it is a relay capability and decrypts nothing.
- **Registered by the host.** On its first connection the host sends
  `X-Pedit-Comment-Admission: <the comment admission token>`, beside the read
  admission header, which also carries the token itself. The Durable Object hashes
  it and stores the hash with the other admission hashes, and deletes it when the
  session ends. Only the host's header counts.
- **Offered by comment links next to the reader token.** A comment link offers
  `pedit-admission.<reader token>` as today and also
  `pedit-comment-admission.<comment token>`.
  - A relay that knows the comment hash makes the socket a **commenter**.
  - An older relay ignores the extra protocol and makes it a reader, as today.
  - Edit and read links are unchanged.
- **What a commenter may do:** everything a reader may (kind 0 frames, blob
  `GET`), plus send kind 1 entries. It may not send kinds 2 and 3, and it may not
  `PUT` blobs. Commenters count toward the readers' cap.
- **Announcing it.** When the room goes kept, a relay that holds a comment hash
  sends `kept comments` after `kept <until-ms>` to every peer. The browser unlocks
  comments for a comment link only after that message. Without it (an older
  relay, or a room opened by an older host), the comment link stays read-only as
  today. Older clients ignore the text message they do not know.
  The relay sends it only to sockets accepted in version 8, so older clients
  never receive it.

### Comment-signed entries

- **A domain of their own.** A comment link seals an entry over
  `pedit kept comment update v1\0 || uint32 file id || update`, signed with the
  commenters' key. The distinct domain means a comment signature can never pass
  as an edit-signed entry, snapshot or bundle, and an edit signature never passes
  as a comment one.
- **What a comment entry may target:** only a paired comments doc. The target
  must be the ID of a comments doc that the manifest pairs with a file
  (`metaFiles`, by path), and the update must pass the live room's comment checks
  (`checkMetaUpdate`, `meta.CheckUpdate`). An entry for a text or canvas file, an
  unknown ID, or an update that fails the checks is skipped and counted, by
  browsers and by the host on resume, as other bad entries are.
- **Verified by everyone who applies entries:** `openKeptFrame` and its Go mirror
  check the domain first, then verify with the editors' key (edit domains) or the
  commenters' key (comment domain). The result carries the tier, and the
  file-update decoder refuses a comment-tier entry whose target is not a comments
  doc. Edit-signed entries are unchanged.
- **What a comment link may change in the comments doc** is what it may change
  in a live room: any comment, as docs/security-design.md already says ("a
  comment-only link … adding, changing or deleting any comment").

### Limits

A commenter could fill the log and stop editors from being kept. So the relay
caps the entries it appends from commenter sockets at a quarter of the log's
entry and byte budget. Past that, a commenter's entry gets `log full`, and
editors keep their share. The relay knows the sender's role at append time; the
log itself still stores no sender.

### Clients

- **Browser (`RoomClient`, packages/web):** on `kept` plus `kept comments`, a
  comment link's comments doc edits become kind 1 entries sealed with the
  comment domain. Pending entries, acknowledgements and resending after a
  reconnect work as they do for editors. The text stays read-only.
- **Host (Go, internal/protocol and the kept intake in internal/session):** it
  registers the comment admission hash, verifies both domains, and applies
  comment-tier entries only to comments docs. On resume they are rendered into
  `.pedit/meta/` with the rest, through the journal.
- **CLI guest:** unchanged; it does not edit or comment while the host is away.
- **`pedit serve` sharing ([embedding.md](embedding.md)):** the same host code,
  so review pages get it with no extra work.

### Compatibility

| Host | Relay | Comment link while the host is away |
| --- | --- | --- |
| v8 | v8 | can comment |
| v8 | older | read-only (the relay ignores the header and never sends `kept comments`) |
| older | v8 | read-only (no comment hash is registered) |
| any | any | edit links unchanged |

- **Version negotiation.** Today a client offers only its own version
  (`admissionProtocols` puts one `pedit-v<N>` in the list), so a v8-only offer
  would make a v7 relay answer `server-outdated`. Version 8 clients, browser and
  Go, therefore offer `pedit-v8` and `pedit-v7`. The relay already accepts in the
  newest version it serves among those offered (`checkProtocolVersion`), and the
  client reads the accepted one from the socket's protocol. On `pedit-v7` it
  behaves as a version 7 client: it sends no comment admission hash and no
  comment entries, and expects no `kept comments`. Everything version 8 adds is
  optional on the wire, so this fallback needs no other change.
- The comment token's protocol name does not start with `pedit-admission.`, so a
  v7 relay's `readAdmissionProtocol`, which takes exactly one such entry, does
  not see it.
- A version 7 browser in a v8 room skips comment-signed entries while the host
  is away, and counts them. Once the host is back, it sees those comments
  through live sync, since the host has taken them in.
- `MIN_PROTOCOL_VERSION` stays 7.
- A room kept by a v8 host must not be resumed by an older pedit: that pedit
  would skip the comment entries and lose those comments. The resume record
  (`keptTextState` in internal/session/kept_text.go) gains a field,
  `CommentEntries: true`. Older pedit decodes records with
  `DisallowUnknownFields`, so it fails to read such a record and leaves it
  alone instead of resuming the room.
- `packages/testdata/access-vectors.json` gains the comment admission token, so
  the TypeScript and Go derivations stay pinned to each other.

## What the relay learns

It learns one more bit per socket: whether the socket is a commenter. It also
learns, at append time, which entries came from commenters. It still sees no
text, no key and no comment.

## Out of scope

- Per-sender authentication within a tier. One commenter can still change
  another's comment, as in a live room (rooms-away.md, "Open questions").
- Editing from a comment link. The text stays the editors' alone.
