# Contributing to pedit

Bug reports, documentation improvements and pull requests are welcome.
[Open an issue](https://github.com/piconic-ai/pedit/issues) with steps to reproduce,
your OS, pedit version and expected behavior. Remove room links, keys, Access
tokens and private document content from reports.
Report security vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.

For a substantial change, open an issue to discuss the approach first. Keep pull
requests focused, describe the resulting behavior and include how you verified it.
Add regression tests for behavior changes and run the checks below before submitting.

## Development

Requires Go 1.25+, Node.js 22+ and pnpm 10.7.1 (see `go.mod` and `package.json`).

The CLI is written in Go; the server and the browser editor in TypeScript.
`packages/` is a standalone pnpm workspace for the relay and browser editor.
Root scripts forward to it; `pnpm install` installs its locked dependencies.
For filtered commands, use `pnpm --dir packages --filter <package> ...`.

```sh
pnpm install --frozen-lockfile
pnpm test        # TypeScript packages
pnpm typecheck
pnpm lint
pnpm test:deploy # self-host deployment orchestration
PEDIT_INTEROP=1 go test -race ./...    # the CLI; its interop test drives the web client's RoomClient with Node.js
go vet ./...
cccc .           # cognitive complexity per function; cccc.toml sets the limit CI enforces
```

[cccc](https://github.com/moznion/cccc) comes with `mise install` (`mise.toml`)
or from its releases. When a function goes over the limit, split it into
steps with names rather than raising the limit.

Run everything locally:

```sh
pnpm --dir packages --filter @pedit/worker dev                  # builds the web editor, serves on http://localhost:8787
printf '# Notes\n' > /tmp/pedit-dev-notes.md
# Set server: http://localhost:8787 in .pedit/config.yaml
go run ./cmd/pedit /tmp/pedit-dev-notes.md
```

| Path | What it is |
| --- | --- |
| `cmd/pedit`, `internal/` | The `pedit` command (Go). `internal/protocol` mirrors `packages/protocol` on top of [ygo](https://github.com/reearth/ygo) |
| `packages/` | Standalone server workspace, self-host config and deployment scripts |
| `packages/protocol` | Encryption, message framing and the Yjs room client used by the web editor |
| `packages/worker` | Hono Worker + `Room` Durable Object (WebSocket Hibernation API); also serves the web editor |
| `packages/web` | CodeMirror 6 editor for collaborators; UI components in BarefootJS |

The wire format (AES-GCM frames, message types, y-protocols sync and awareness)
is shared by both implementations: change them together.

- A frame is `iv || AES-GCM(room key, sender || counter || type || payload)`.
  `sender` is 16 random bytes each client picks when it starts, and `counter`
  a big-endian uint64 it raises by one for every frame it sends, across
  reconnects. Receivers drop a frame whose counter is not above the last one
  from its sender, and their own: the relay could send any frame again.
  Types: `0` sync, `1` awareness, `2` attachment, `3` canvas, `4` files.
  Clients skip types they do not know, so newer peers can add more.
- A room that shares several files keeps each in a Y.Doc of its own. File `0`
  is the room's own doc, synced with plain sync messages as in a room that
  shares one file; the others are synced in files messages. These carry a
  lib0 varint kind: `0` manifest (a count, then for each file its id, path
  and format), the host's list of the room's files, which replaces any sent
  before; `1` doc (a file id other than `0`, then a sync, attachment or canvas
  message, type byte and payload, as in a room that shares one file).
  The host routes messages only by the ids it issued, never by a path. Paths
  pass the checks in `internal/protocol/path.go` and
  `packages/protocol/src/path.ts` (`packages/testdata/path-vectors.json`), and
  `packages/testdata/files-vectors.json` pins the encoding. A room can start
  with one file and add more, and an older peer, which skips type `4`, goes on
  editing file `0`.
- Clients offer the protocol version as the WebSocket subprotocol `pedit-v<N>`
  (`PROTOCOL_VERSION` in `packages/protocol`, `ProtocolVersion` in
  `internal/protocol`). The Room turns another version away with close code
  `4002` (the client is older) or `4003` (the server is older), and clients
  stop reconnecting and ask to update pedit or reload the page.
- Other close codes the Room sends and clients do not reconnect on: `4001`
  (the host left and the session is over) and `4004` (the room already has as
  many guests as the relay allows). On `4005` (too many connections from the
  client's network) clients reconnect, but wait at least 5 to 10 seconds. On
  `4006` (the relay is closed for maintenance) they stop, and reconnect only
  when the person asks: Reconnect in the editor, Enter in the host's pedit.
- While pedit is 0.x, patch releases keep the wire format compatible. Additive
  changes (a new message type or kind that older peers skip) do not change the
  version. A change older peers cannot skip bumps the version, ships in a minor
  release and is noted in the CHANGELOG.
- Attachments (images) are named by content: `hash` is the first 128 bits of
  SHA-256 of the bytes, in hex. Their bytes are encrypted with a key derived
  from the room key (HKDF-SHA256, info `pedit blob enc v1`) and stored under
  `blobId`, the first 128 bits of HMAC-SHA256 over `hash` with another derived
  key (info `pedit blob id v1`), in base64url. The server sees neither the
  content nor its hash.
- Attachment messages carry a lib0 varint kind and fields: `0` announce
  (hash, mime), `1` want (hashes), `2` stored (hash, path), `3` rejected
  (hash, reason). `packages/testdata/blob-vectors.json` pins the
  derivations for both implementations.

Before opening a pull request, also run `pnpm build` and check Go formatting with
`gofmt -l cmd internal` (it should print nothing). The interop tests require the
installed TypeScript dependencies; `PEDIT_INTEROP=1` prevents silently skipping them.

Keep encryption keys in the URL fragment and keep document content on clients.
See [privacy and security](README.md#privacy-and-security) for the trust model and
[deployment](docs/contributing/deployment.md) for releases, previews and the lab Worker.

See [Homebrew releases](docs/contributing/homebrew.md) for tap updates and token setup.
