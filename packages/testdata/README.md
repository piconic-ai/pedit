`obsidian.canvas` is `sample.canvas` from https://github.com/obsidianmd/jsoncanvas
(MIT License, Copyright (c) 2024 Obsidian), as Obsidian writes canvases.

`close-codes.json` holds the WebSocket close codes and the reason of an expired
room (`ROOM_EXPIRED`). `packages/protocol/test/close.test.ts` and
`internal/protocol/close_test.go` both check their constants against it, so the
two sides cannot drift apart.

`path-vectors.json` holds the paths a room may share and the ones it refuses,
with the reason, so `CheckPath` in `internal/protocol/path.go` and `checkPath`
in `packages/protocol/src/path.ts` refuse the same paths for the same reason
(#113). `sameFile` and `differentFiles` are for `PathKey`, which only Go has:
only the command line writes shared files to disk. Unlike `blob-vectors.json`,
this file is written by hand; characters that do not show are escaped.

`files-vectors.json` pins how a room that shares several files encodes its
manifest and the messages about one file, and which `meta` entry of the
manifest holds the metadata of which file (#121). `internal/protocol/files_test.go`
writes it (`PEDIT_UPDATE_VECTORS=1 go test ./internal/protocol/`), and
`packages/protocol/test/files.test.ts` checks the TypeScript side reads and
writes the same bytes.

`meta-limits.json` holds the limits every peer applies to an update of a
file's comments (#121) before applying it. `internal/meta/check_test.go` and
`packages/protocol/test/meta.test.ts` both check their constants against it.

`meta-measure.json` is the state of a comments doc Yjs made (with an
UndoManager's run of values and a deleted thread) and its measure, which
`internal/meta`'s `DocSize` and `packages/protocol`'s `metaDocSize` must both
work out.

`access-vectors.json` pins the key chain of room links (#122): the edit,
comment-only and read-only fragments derived from one edit secret, both
verifying keys, the frame key and both admission tokens, and today's admission
token of the same 32 bytes, which no value of the chain may repeat.
`internal/protocol/access_test.go` writes it (`PEDIT_UPDATE_VECTORS=1 go test
./internal/protocol/`), and `packages/protocol/test/access.test.ts` checks the
TypeScript side derives the same.

`kept-comment-vectors.json` pins a comment-signed kept entry (docs/design/kept-comments.md):
the message under the comment domain and the commenters' Ed25519 signature over it
(deterministic), beside the same payload under the edit file-update domain.
`internal/protocol/kept_comment_test.go` writes it (`PEDIT_UPDATE_VECTORS=1 go test
./internal/protocol/`), and `packages/protocol/test/kept-comments.test.ts` checks the
TypeScript side seals and opens the same bytes.

`origin-vectors.json` lists origin lists and whether `parseOrigins`
(`packages/worker/src/origins.ts`) and `protocol.ParseOrigins`
(`internal/protocol/origins.go`) accept them, with the result when duplicates
are dropped. `packages/worker/test/origins-vectors.test.ts` and
`internal/protocol/origins_test.go` both read it.

`review-csp-vectors.json` lists relays (and optional `frameAncestors`) with the exact
`reviewCSP` output (`packages/review/src/csp.ts`), and inputs it rejects. The TypeScript test in
`packages/review/test/csp.test.ts` checks every one; the Go `pedit doctor` checks pages against the
same vectors.
