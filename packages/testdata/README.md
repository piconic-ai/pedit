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
