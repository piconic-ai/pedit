# @pedit/serve

Run [`pedit serve`](https://github.com/piconic-ai/pedit) for a local app. pedit holds one file's Yjs
document and writes the file; this package starts it, checks every request, and bridges a browser's
WebSocket to a stream on pedit's standard input and output. Your page edits the file live, with several pages at once, and
there is no room, relay or account.

Experimental (0.x): the API may change. The package is published with every pedit release and
carries the same version number; the pedit it needs is listed below.

## Requirements

- pedit 0.5.0 or later on the PATH (or pass `bin`). Older ones are refused with a message on how to update. Or let your app [download it](#installing-pedit-for-the-user) once, if you opt in.
- Node 22 or later, on macOS, Linux or Windows. On Windows, pedit stops a child by closing its input and never kills it: a child that does not exit in time is reported as an error event.

## Install

```sh
npm install @pedit/serve yjs y-protocols y-websocket   # the browser client's peers
npm install hono @hono/node-server @hono/node-ws       # for the Hono routes
```

`@pedit/serve/client` needs `yjs`, `y-protocols` and `y-websocket`; `@pedit/serve/hono` needs `hono`.
They are peers, so your app keeps one copy of Yjs.

## Server

```js
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { peditRoutes } from '@pedit/serve/hono'
import { Hono } from 'hono'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
const server = serve({ fetch: app.fetch, port: 3000, hostname: '127.0.0.1' })
const routes = peditRoutes({
  upgradeWebSocket,
  root: '/home/me/notes', // only files under it are served
  origins: ['http://127.0.0.1:3000'],
  app: 'my-app',
  resolve: async (id) => (id === 'todo' ? { path: '/home/me/notes/todo.md', role: 'edit' } : null),
})
app.route('/edit', routes)
injectWebSocket(server)
process.on('SIGINT', () => routes.close().finally(() => process.exit(0)))
```

## Browser

```js
import { connect } from '@pedit/serve/client'
import { yCollab } from 'y-codemirror.next'

const conn = await connect('/edit', 'todo', { name: 'Ann' })
conn.status.subscribe((status, error) => {
  if (error?.code === 'gone') showReload() // your UI
})
const extensions = [yCollab(conn.text, conn.awareness)] // plus basicSetup, EditorState.readOnly for 'read'
```

## API

`@pedit/serve/hono`

| Export | |
| --- | --- |
| `peditRoutes(options)` | A Hono app: `POST /:id/session` and the WebSocket `GET /:id/doc`. Has `close()`. |
| `options.resolve(id, c)` | Maps an id to `{ path, role: 'edit' \| 'read' }`, or `null` for 404. |
| `options.root`, `origins`, `app` | The served directory, the exact page origins, and a label shown if another process holds the file. |
| `options.bin`, `idleMs`, `graceMs`, `allowRemote`, `onEvent` | Absolute path to pedit; idle stop (default 60 s); how long a child may take to exit after its input closed (default 5 s; on Windows it is then given up on, never killed); accept non-loopback peers (default false); `started`/`stopped`/`error` events, and `update_available` (`{ version, url, security }`, once per version) when pedit finds a newer release. `started` carries pedit's `version` and `serve` (surface version) when it reports them. |

`@pedit/serve/client`

| Export | |
| --- | --- |
| `connect(base, id, { name, color })` | Resolves after the first sync with `{ doc, text, awareness, role, status, synced, destroy }`. |
| `conn.status` | `get()` and `subscribe(cb)`; states `connecting`, `connected`, `reconnecting`, `closed`. |
| `PeditError.code` | `not-found`, `held`, `busy`, `forbidden`, `gone`, `unavailable`. |

`@pedit/serve`

| Export | |
| --- | --- |
| `ServedFiles` | The layer below the routes: `acquire(path)` starts or reuses a child, `close()` ends all. |
| `ServedFile.share(opts)`, `unshare()`, `close()` | Open a room for the file (needs pedit with `serve` 2; the child is not idle-stopped while shared). `share` resolves `{ type: 'shared', room, links, keptUntil, resumed }`, or `{ type: 'choice', room, choices }` when the file has a kept room of another history (share again with `choice`). A link is `<room>.<fragment>`: put your page URL and `#` before it. `onEvent` also gets `peers`, `room_ended` and `shared`. |
| `resolvePedit({ bin, install })`, `MIN_PEDIT_VERSION` | Finds pedit, checks the binary and its version. With `install: true`, downloads it when none is usable (see above) and returns `installed`. |
| `HeldError`, `LimitError`, `NoPeditError` | Another process serves the file; 32 files or 8 clients; pedit missing or too old. |

## Installing pedit for the user

Nothing is ever downloaded unless your app asks for it. Without the opt-in, a missing or old pedit
is a `NoPeditError`, as before. To let the app install pedit when needed:

```js
const { bin, version, installed } = await resolvePedit({ install: true })
if (installed) log(`installed pedit ${installed.tag}, verified: ${installed.verified}`)
const routes = peditRoutes({ /* ... */ bin })
```

`resolvePedit({ install: true })` looks, in order, at an explicit `bin` (used as it is, never replaced),
`pedit` on the PATH, and the per-user copy. Only if none is usable, or the per-user copy is older than
`MIN_PEDIT_VERSION`, it downloads the latest release. A pedit anywhere else (Homebrew, `install.sh`) is
never touched.

- The per-user copy is shared by every app: `$XDG_DATA_HOME/pedit/bin/pedit` (default
  `~/.local/share/pedit/bin/pedit`), or `%LOCALAPPDATA%\pedit\bin\pedit.exe` on Windows. The directories
  are `0700`; the binary is written to a temporary file next to it and renamed, so two apps installing at
  once leave a whole file.
- It downloads the archive, `checksums.txt` and the Sigstore bundle from GitHub Releases, over HTTPS, with
  size limits, and reads only the root `pedit` (`pedit.exe`) from the archive.
- The archive must match its line in `checksums.txt`. If `gh` (GitHub CLI) is on the PATH, it also runs
  `gh attestation verify` against the release workflow, pinned to the tag's commit when GitHub
  answers the lookup; no GitHub sign-in is needed. `installed.verified` is `'provenance'` then, and
  `'checksum'` without `gh`: that proves the file is the one listed beside it, not that this repository's
  workflow built it. If any check fails, nothing is written and `resolvePedit` throws `NoPeditError`.
- Updates are not automatic. Watch the `update_available` event; the per-user copy is an
  install-script-style copy, so `pedit self-update` (run as that user) updates it in place.

## Security model

- One hook, `resolve`, decides which ids exist and their role. Every other request is refused by default.
- Files must be under `root` (realpath checked); ids are `[A-Za-z0-9_-]` only.
- Host and Origin must match `origins`, and peers must be on loopback unless `allowRemote` is set.
- A session token is single use and expires in 60 s; it travels in the WebSocket URL, so log no `token`.
- A `read` role is enforced by pedit itself, not just by the page: updates from a reader close the socket.
- The browser never sees a path, a pid or a socket name.
- On Windows, `resolvePedit` cannot check the owner or write access of the pedit binary it finds on the PATH, so a writable PATH directory (such as `C:\tools`) could hold a planted `pedit.exe`. Pass an absolute `bin` that you trust.

## Known limits

- One id is one file; at most 32 files and 8 clients per file.
- Awareness (names, cursors) is unauthenticated: any connected page can claim any name.
- `gone`: pedit's saved state was discarded, so the page's copy cannot merge into the new document.
  The client stops; the app decides whether to offer the text or reload.
- Don't write the file yourself while a page is connected.

Design: [docs/design/serve.md](https://github.com/piconic-ai/pedit/blob/main/docs/design/serve.md).
Sample: [examples/serve-app](https://github.com/piconic-ai/pedit/tree/main/examples/serve-app).
MIT license.
