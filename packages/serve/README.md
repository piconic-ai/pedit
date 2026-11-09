# @pedit/serve

Run [`pedit serve`](https://github.com/piconic-ai/pedit) for a local app. pedit holds one file's Yjs
document and writes the file; this package starts it, checks every request, and bridges a browser's
WebSocket to a stream on pedit's standard input and output. Your page edits the file live, with several
pages at once, and there is no room, relay or account until the app shares the file.

Experimental (0.x): the API may change. The package is published with every pedit release and
carries the same version number. The pedit it needs depends on what you use:

| To | pedit |
| --- | --- |
| Edit a file from your pages | 0.5.0 or later (`MIN_PEDIT_VERSION`) |
| Share a file with people outside, through a room | 0.6.0 or later |
| Read or change a room's keep (`status`, `keep`) | 0.8.1 or later |
| Comment as the host, and get the threads | 0.8.2 or later |

A pedit older than 0.6.0 (serve surface 1) rejects every room command with `sharing needs pedit
serve 2; this pedit is older`; one that lacks a later command rejects it with `pedit is too old for
status; update it` (or `keep`, `comment`, `reply`, `resolve`). The child goes on.

## Requirements

- pedit on the PATH (or pass `bin`). Older ones are refused with a message on how to update. Or let
  your app [download it](#installing-pedit-for-the-user) once, if you opt in.
- Node 22 or later, on macOS, Linux or Windows. On Windows, pedit stops a child by closing its input
  and never kills it: a child that does not exit in time is reported as an error event.

## Install

```sh
npm install @pedit/serve yjs y-protocols y-websocket   # the browser client's peers
npm install hono @hono/node-server @hono/node-ws       # for the Hono routes
```

`@pedit/serve/client` needs `yjs`, `y-protocols` and `y-websocket`; `@pedit/serve/hono` needs `hono`.
They are peers, so your app keeps one copy of Yjs.

## Quick start

The server mounts the routes under a path and says which ids exist:

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

The page connects to an id and binds the text to its editor:

```js
import { connect } from '@pedit/serve/client'
import { yCollab } from 'y-codemirror.next'

const conn = await connect('/edit', 'todo', { name: 'Ann' })
conn.status.subscribe((status, error) => {
  if (error?.code === 'gone') showReload() // your UI
})
const extensions = [yCollab(conn.text, conn.awareness)] // plus basicSetup, EditorState.readOnly for 'read'
```

## `@pedit/serve/hono`

### `peditRoutes(options)`

Returns a Hono app with `POST /:id/session` and the WebSocket `GET /:id/doc`, plus the methods
below. Mount it with `app.route(path, routes)`.

| Option | |
| --- | --- |
| `upgradeWebSocket` | From the adapter, created on the parent app (`createNodeWebSocket({ app })`). |
| `root` | The directory whose files may be served; realpath'd at startup, must exist. |
| `origins` | The exact origins of your pages. Also used for the `Host` check. |
| `app` | A label another process sees if it asks pedit for a file this app holds. |
| `resolve(id, c)` | Maps an id to `{ path, role: 'edit' \| 'read' }` under `root`, or `null` for 404. Throw an `HTTPException` for anything else. |
| `bin` | Absolute path to pedit. Default: `pedit` on the PATH. |
| `idleMs` | Stop the child this long after its last page left. Default 60 s. A shared file is never stopped for idleness. |
| `graceMs` | How long a child may take to exit after its input closed, before SIGTERM. Default 5 s. On Windows it is then given up on, never killed. |
| `allowRemote` | Accept peers that are not on loopback. Default `false`. |
| `onEvent(event)` | See [events](#events). |

Types: `PeditOptions`, `PeditRoutes`, `PeditEvent`, `Role`. The helpers `isLoopback(address)` and
`inside(root, path)` are exported too.

### Methods on the routes

Every method takes an absolute `path` to a file under `root`, checked as the routes check it: a
path outside `root`, a link out of it or a missing file rejects with `file not found` and starts no
child.

| Method | |
| --- | --- |
| `share(path, opts?)` | Open a room for the file; see [sharing](#sharing). |
| `unshare(path)` | Leave the room: a kept room stays kept, a live one ends. |
| `close(path?)` | With a path, end that file's kept room for good (a live room is only left). Without, stop every child. |
| `status(path)` | The file's room, shared now or kept without pedit; `null` when it has none. |
| `keep(path, keep)` | Change how long the relay keeps the room after pedit leaves. |
| `comment(path, range)`, `reply(path, thread, body)`, `resolve(path, thread, resolved)` | Take part in the file's comments as the host; see [comments](#comments). |

### Events

`onEvent` is called with:

| Event | |
| --- | --- |
| `started` | `{ id, path, version?, serve? }`: a child a page opened through an id is up. `version` is pedit's version and `serve` its surface version (2 from pedit 0.6.0), when pedit reports them. A child that `share` or `status` started before any page connected is not reported here; the `ServedFiles` layer reports every child. |
| `stopped` | `{ id, path, reason: 'idle' \| 'exited' \| 'shutdown' }`, for the same children as `started`. |
| `error` | `{ id, message }`; `id` is `null` when no id is involved. |
| `update_available` | `{ version, url, security }`, once per version, when pedit finds a newer release. |
| `shared` | The result of a `share`, with `path` and `id`. |
| `peers` | `{ path, id, peers: [{ name, access }], more? }`: who is in the room; `more` counts people left out. |
| `comments` | `{ path, id, threads, more? }`: the file's threads; see [comments](#comments). |
| `room_ended` | `{ path, id, reason: 'closed' \| 'expired' \| 'maintenance' }`, also when the relay ended the room unasked. |
| `unshared` | `{ path, id }` |

For the room events, `id` is the one the routes last served that path under, or `null`.

## `@pedit/serve/client`

### `connect(base, id, options?)`

Opens `${base}/${id}`, where `base` is the same-origin path the routes are mounted at (`'/edit'`, not
a full URL): issues a session, connects, and resolves after the first sync with a `Connection`. It reconnects with a fresh token until the server says the
document is gone. `options` is `{ name?, color? }` for awareness.

### `Connection`

| Field | |
| --- | --- |
| `doc`, `text` | The `Y.Doc` and `doc.getText('content')`, the file's text. |
| `awareness` | Names and cursors. Unauthenticated: anyone who can connect can claim any name. |
| `role` | `'edit'` or `'read'`. For `read`, no update is ever sent; also make the editor read-only. |
| `status` | `get()` and `subscribe(cb)`; states `connecting`, `connected`, `reconnecting`, `closed`. The callback gets a `PeditError` when a state has a cause. |
| `synced` | Resolves after the first sync. |
| `destroy()` | Closes the connection. |

### `PeditError`

`error.code` (a `PeditErrorCode`) is one of:

| Code | |
| --- | --- |
| `not-found` | `resolve` returned `null` for the id. |
| `held` | Another process holds the file, and the page's role is `edit`. |
| `busy` | pedit could not serve the file just now: it is missing or not usable, the file or client limit is reached, the child failed to start, or another process holds a file the page would only read. The server reports the cause as an `error` event. |
| `forbidden` | The Host or Origin did not match, or the peer is not on loopback. |
| `gone` | pedit's saved state was discarded, so this page's copy cannot merge into the new document. The client stops. |
| `unavailable` | The session request failed, or its answer could not be read. |

Types: `Connection`, `Status`, `PeditErrorCode`, `Role`.

## `@pedit/serve`

The layer below the routes, for an app that is not on Hono or wants its own transport.

### `ServedFiles`

`new ServedFiles({ bin, app, idleMs?, graceMs?, onEvent? })` (`ServedFilesOptions`; `bin` must be an
absolute path). `acquire(path)` starts a child for the file or reuses the one running, and resolves a
`ServedFile`; `close()` ends every child. Its `onEvent` gets a `ServeEvent`, the same events as the
routes but by `path` only: this layer knows paths, not ids, and reports every child.

### `ServedFile`

| Member | |
| --- | --- |
| `path`, `generation` | `generation` names the document: the same after a restart that restored it, new when it started afresh. |
| `dial(role)` | One stream to the child, as a `Bridge` (`send(frame)`, `onframe`, `onclose(reason, code?)`, `close()`); at most 8 per file (`LimitError`). |
| `share(opts?)`, `unshare()`, `close()`, `status()`, `keep(keep)` | As the routes' methods, for this file; see [sharing](#sharing). `close()` ends a kept room for good; a live one is only left. |
| `comment(range)`, `reply(thread, body)`, `resolve(thread, resolved)` | See [comments](#comments). |

### `resolvePedit(options?)`, `MIN_PEDIT_VERSION`, `peditVersionOk(output)`

`resolvePedit({ bin?, install? })` finds pedit, checks the binary and its version, and resolves
`{ bin, version, installed? }`. With `install: true` it downloads pedit when none is usable; see
[installing pedit for the user](#installing-pedit-for-the-user). `peditVersionOk(output)` tells
whether a `pedit --version` output is at least `MIN_PEDIT_VERSION` (development builds pass and are
left to the feature checks).

Types: `ServedFilesOptions`, `ServedFile`, `ServeEvent`, `Bridge`, `Installed`, `Verified`, and the
share and comment types `ShareOptions`, `ShareResult` (`Shared`, `ShareChoice`, `ShareClosed`),
`ShareStatus`, `Peer`, `CommentRange`, `CommentThread`, `CommentMessage`, `StartedThread`, `Role`.

### Errors

| Class | |
| --- | --- |
| `HeldError` | Another process serves the file. |
| `LimitError` | 32 files, or 8 clients on one file. |
| `NoPeditError` | pedit is missing or not trustworthy (not an absolute path, not a regular file, owned by another user, writable by group or others, or `--version` failed), too old, or could not be installed. |

## Sharing

`share(path, opts)` opens a room for the file on the relay, so people outside the app can edit,
comment on or read it from a page of yours ([your own review page](https://github.com/piconic-ai/pedit/blob/main/docs/review-page.md)).
While the file is shared, its child is not stopped for idleness.

```ts
const result = await routes.share('/home/me/notes/a.md', {
  origins: ['https://cms.example.com'], // pages that may open the room (at most 4)
  keep: '1d', // how long the relay keeps it after you leave; '0' is a live room
})
if (result.type === 'shared') {
  const url = `https://cms.example.com/review#${result.links.comment ?? result.links.read}`
}
```

`opts` also takes `relay`, the relay's URL (default: the project's, or `https://edit.piconic.ai`),
and `choice`, the user's answer to a `choice` result. `share` resolves one of:

| Result | Meaning |
| --- | --- |
| `{ type: 'shared', room, links: { edit, comment?, read }, keptUntil, resumed }` | The room is open. A link is `<room>.<fragment>`: the page link is `<page URL>#<link>`. `keptUntil` is Unix ms, 0 when the relay keeps nothing. |
| `{ type: 'choice', room, choices }` | The file has a kept room of another history. Ask the user which to keep (`room`, `app` or `later`; `text` is the characters each side holds), then call `share` again with the same options and `choice`. |
| `{ type: 'closed' }` | `choice: 'app'` ended the kept room, so nothing is shared. Call `share` again to open a new one. |

`unshare` leaves the room: a kept room stays until its deadline, a live one ends. `close` ends a kept
room for good. A failure from pedit rejects with its message.

`status(path)` tells what room the file has, without changing anything, so an app that restarted can
show a share that is still open. It resolves `{ room, links: { edit, comment?, read }, keep, host, ends, lifeEnd }`,
or `null` when the file has no room (or the relay says it has ended). `host` is `'here'` while pedit
shares the room now and `'away'` while it is kept without pedit; `keep` is in seconds, `ends` is when
the room ends and `lifeEnd` the end of its life (both Unix ms). It starts the child if none runs, as
pedit reads the file's record there, and a record of another history is still reported: `share` then
gives the `choice`.

`keep(path, keep)` changes how long the relay keeps the room after pedit leaves (`'3d'`, as in
`share`; not `'0'`), while the file is shared with a keep. It resolves the new status. It rejects when
the file is not shared, the room is live, or the relay refuses; a room kept without pedit gets its new
keep from the next `share`.

## Comments

While the app shares a file, it can take part in the file's comments as the host, and gets the
threads live. Comments follow `docs/design/comments.md`: the same limits (a body of 1 to 4,000
characters, 500 threads, 200 comments a thread), written under the host's name as the room shows it.

```ts
const { thread } = await routes.comment('/home/me/notes/a.md', { from: 6, to: 10, body: 'Why wide?' })
await routes.reply('/home/me/notes/a.md', thread, 'Because it is.')
await routes.resolve('/home/me/notes/a.md', thread, true) // false opens it again
```

- `comment(path, { from, to, body })` starts a thread on `[from, to)` of the file's text, in UTF-16
  code units (what `String.prototype.slice` and Yjs count). It resolves `{ thread, message }`. Only
  text and Markdown files take it; an empty range, one outside the text or one over 1,000 characters
  rejects. A file with CRLF line endings counts a line break as one unit, as your page's `Y.Text` does.
- `reply(path, thread, body)` resolves `{ message }`. `resolve(path, thread, resolved)` resolves
  nothing; setting the state a thread has already is not an error.
- They work only while the file is shared and pedit is connected to the room. Not shared, a room kept
  with `host: 'away'`, or a connection that is down rejects with pedit's reason: a comment written
  while nobody can see it would look delivered. What is saved stays readable in `.pedit/meta/`.
- The `comments` event carries the file's threads as they are, once when sharing starts (and on a
  resume) and again whenever the comments, or the text they point into, change. A thread is
  `{ id, quote, resolved, from, to, cut?, messages: [{ id, author, time, body }] }`. `from` and `to`
  are where its anchor is in the text now, or `null` when it cannot be placed (its text was deleted,
  or it is on cells or a node). The event fits 64 KiB: open threads come first, `more` counts threads
  left out, and `cut` counts a thread's oldest comments left out. The event that shows a write comes
  before the call resolves.

## Installing pedit for the user

Nothing is ever downloaded unless your app asks for it. Without the opt-in, a missing or old pedit
is a `NoPeditError`. To let the app install pedit when needed:

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
- Files must be under `root` (realpath checked); ids are `[A-Za-z0-9_-]` only, up to 128 characters.
- Host and Origin must match `origins`, and peers must be on loopback unless `allowRemote` is set.
- A session token is single use and expires in 60 s; it travels in the WebSocket URL, so log no `token`.
- A `read` role is enforced by pedit itself, not just by the page: updates from a reader close the socket.
- The browser never sees a path, a pid or a socket name.
- On Windows, `resolvePedit` cannot check the owner or write access of the pedit binary it finds on the
  PATH, so a writable PATH directory (such as `C:\tools`) could hold a planted `pedit.exe`. Pass an
  absolute `bin` that you trust.

## Known limits

- One id is one file; at most 32 files and 8 clients per file.
- Awareness (names, cursors) is unauthenticated: any connected page can claim any name.
- `gone`: pedit's saved state was discarded, so the page's copy cannot merge into the new document.
  The client stops; the app decides whether to offer the text or reload.
- Don't write the file yourself while a page is connected.

Design: [docs/design/serve.md](https://github.com/piconic-ai/pedit/blob/main/docs/design/serve.md).
Guide: [embedding pedit](https://github.com/piconic-ai/pedit/blob/main/docs/embed.md).
Sample: [examples/serve-app](https://github.com/piconic-ai/pedit/tree/main/examples/serve-app).
MIT license.
