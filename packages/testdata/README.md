`obsidian.canvas` is `sample.canvas` from https://github.com/obsidianmd/jsoncanvas
(MIT License, Copyright (c) 2024 Obsidian), as Obsidian writes canvases.

`close-codes.json` holds the WebSocket close codes and the reason of an expired
room (`ROOM_EXPIRED`). `packages/protocol/test/close.test.ts` and
`internal/protocol/close_test.go` both check their constants against it, so the
two sides cannot drift apart.
