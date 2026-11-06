# serve-app

A local app with pedit inside, as small as it gets: a Hono server runs
`pedit serve` for one file through [`@pedit/serve`](../../packages/serve), and a
page edits that file live in CodeMirror. pedit writes the file; the page edits
the document. Everything stays on this machine. There is no login: whoever can
reach the page edits the file, so the server listens on 127.0.0.1 only.

## Requirements

- pedit 0.5.0 or later on the PATH (`brew install piconic-ai/tap/pedit`, the
  install script, or a GitHub release), or `PEDIT=/path/to/pedit`.
- Node 22 or later, on macOS, Linux or Windows.

## Run

```sh
npm install
npm run build              # bundles page.mjs into public/page.js
node server.mjs            # PEDIT=/path/to/pedit only if pedit is not on the PATH; PORT=... for another port
```

Open `http://127.0.0.1:3000/`; it edits `content/demo.md`. `PEDIT=... node --test` checks it.

- `server.mjs`: Hono, `peditRoutes` (the id `demo` is the only file served) and the static page.
- `page.mjs`: `connect` from `@pedit/serve/client`, CodeMirror 6 with `yCollab`, a status line.

## Sharing

The page has a share panel above the editor. The server owns the share and the page
asks it: **Share** opens a room on the relay (keep `live`, `1h` or `1d`), and the panel
shows the edit, comment and read links, who is in the room, and when a kept room expires.
**Stop sharing** leaves the room; **End room** ends a kept one for good. If the file already
has a kept room of another history, the panel asks which side to keep.

- `PEDIT_RELAY=http://127.0.0.1:8787` uses another relay (default https://edit.piconic.ai).
  With it set, `node --test` also shares for real.
- Reviewers open the relay's own editor (`<relay>/r/<room>#<key>`), or the review page
  when `REVIEW_PAGE` is set.
- `REVIEW_PAGE=http://127.0.0.1:3001/` shares to a page that holds `<pedit-review>` (see
  [review-page](../review-page/README.md)): the share passes that page's origin as
  `origins`, and the links become `<REVIEW_PAGE>#<room>.<key>`.
- Sharing needs pedit 0.6.0 or later (`serve` version 2); an older pedit still
  edits, and the Share button reports why it cannot share.
- The `/share` routes need `127.0.0.1` as the Host, this origin (a same-origin `EventSource` may send none) and JSON bodies.

## Notes

- pedit edits an existing file and never creates one: an app's "new document"
  creates the file first (empty is fine), then connects. This sample creates
  `content/demo.md` at start for that reason.
- A page that says `busy` means pedit could not be started: the reason (not
  found, too old, no permission) is on the server's stderr. `held` means
  another program holds the file.
- `gone` is rare (pedit's saved state was discarded); the app decides what to show.
- The token is in the WebSocket URL: access logs must drop `token`.

Everything else (options, security model, limits) is in the
[package README](../../packages/serve/README.md).
