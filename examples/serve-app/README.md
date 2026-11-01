# serve-app

A sample local app built on `@pedit/serve` (experimental, issue #235): an editor
bound to a file that `pedit serve` holds. There is no room and no relay. The
library starts `pedit serve` for the file, checks every request, and bridges the
page's WebSocket to pedit's Unix socket; pedit alone writes the file.

## Run

```sh
npm install                   # links ../../packages/serve; Node 22.18 or later
PEDIT=/path/to/pedit node server.mjs   # PEDIT only if pedit is not on the PATH
```

It prints `http://127.0.0.1:<port>/` (set `PORT` to pin it) and edits
`content/demo.md`, which it creates if missing. `PEDIT=... node --test` runs the
test. Ctrl+C ends pedit's children, which save the file.

The previous version of this sample put a per-run secret in the URL. That is
gone: access is now the library's Host and Origin checks plus a single-use token
per connection. There is still no login (see below).

## Files

- `server.mjs`: Hono, `@hono/node-server`, `@hono/node-ws` and `peditRoutes`.
  `resolve` maps the fixed id `demo` to `content/demo.md`. No authentication, and
  `allowRemote` stays false, so only loopback peers are served.
- `page.mjs`: CodeMirror 6, `connect` from `@pedit/serve/client` and `yCollab`.
  For role `read` it adds `EditorState.readOnly.of(true)`.

## First-hour gotchas

- The file must exist before the first session; pedit does not create it.
- Do not write the file yourself while a page is connected (pedit takes outside
  saves in as edits, but a program that rewrites the file in place can race it).
  Open the file in an editor only if it saves whole-file and without a dialog.
- When the last page leaves, the child stops after 60 s (`idleMs`) and saves; the
  next session starts it again.
- Hot reload (`node --watch`, Vite) re-runs the server module: keep the
  `peditRoutes` result on `globalThis` and close the old one, or the new process
  is refused as `held` by the old child.
- Files with CRLF line endings are not handled well yet (#382).
- The token is a query parameter of the WebSocket URL, so access logs and proxies
  must drop `token` from logged URLs.
- Awareness (names and cursors) is unauthenticated: any connected page can claim
  any name.
