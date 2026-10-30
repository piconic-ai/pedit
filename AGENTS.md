# pedit

A CLI that lets you co-edit a local text file with other people, right now.
`pedit <file>` prints a URL; others join from their browser.
The service and its CLI are both named `pedit`; it is served at edit.piconic.ai.

## Principles
- The host's local file is the source of truth. The server never sees plaintext. It keeps room content only as ciphertext, and only while a room is open. The host may close the room; the relay may also close it at its configured limit or for maintenance. Anything on the server can be deleted without loss once the host has taken it in. No public URLs.
- Updates are end-to-end encrypted with a key held in the URL fragment; the server only relays ciphertext.
- Never send the key to the server (not in requests, logs, or error reports).
- No auth or AI features. Comments (#121) follow `docs/design/comments.md`: they never go into the shared file.

## Layout
- cmd/pedit, internal/: the `pedit` command (Go, single binary). internal/protocol mirrors packages/protocol on top of reearth/ygo; keep the wire format in sync
- packages/protocol: encryption, message format and room client for the web (pnpm workspace)
- packages/worker: Hono + Durable Objects (WebSocket Hibernation API) + R2 for encrypted attachments. Also serves the web assets, adding the Content-Security-Policy to HTML (`src/page.ts`).
- packages/web: editor built on CodeMirror 6 + y-codemirror.next. UI components are BarefootJS (`src/components/*.tsx`, client-side rendering only: the server never sees content). Write new UI as components with signals; do not use BarefootJS's ready-made UI components, keep pedit's own CSS. The exception is xyflow for the canvas board: `src/components/xyflow/` is the registry copy from `bf add xyflow`, kept as upstream has it apart from changes marked `pedit:`. State from outside (room status, Yjs) reaches components as a `Store` (`src/store.ts`): a signal made once outside the components (in main.ts or a class like `TableView`), which components just read with `store.get()` in their JSX. Components never subscribe per instance. Publish a new value only when it changed, so every cell or row reading it does not re-run. Where behaviour is heavy (the table, the context menu, the Split divider), a class keeps the state and publishes it as stores, and a component draws it and hands its events back (`TableView` + `TableGrid.tsx`).

## Stack
CLI: Go / ygo (pure-Go Yjs) / coder/websocket
Server and web: TypeScript / Yjs / y-protocols / Cloudflare Workers / BarefootJS / Vitest

## Workflow
- Present a plan before implementing.
- Add tests with every change and make them pass before committing.
