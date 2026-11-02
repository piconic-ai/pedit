# serve-app

A local app with pedit inside, as small as it gets: a Hono server runs
`pedit serve` for one file through [`@pedit/serve`](../../packages/serve), and a
page edits that file live in CodeMirror. pedit writes the file; the page edits
the document. Everything stays on this machine. There is no login: whoever can
reach the page edits the file, so the server listens on 127.0.0.1 only.

## Requirements

- pedit 0.4.0 or later on the PATH (`brew install piconic-ai/tap/pedit`, the
  install script, or a GitHub release), or `PEDIT=/path/to/pedit`.
- Node 22 or later, on macOS or Linux.

## Run

```sh
npm install                # needs ../../packages/serve built: pnpm --filter @pedit/serve build
npm run build              # bundles page.mjs into public/page.js
node server.mjs            # PEDIT=/path/to/pedit only if pedit is not on the PATH; PORT=... for another port
```

Open `http://127.0.0.1:3000/`; it edits `content/demo.md`. `PEDIT=... node --test` checks it.

- `server.mjs`: Hono, `peditRoutes` (the id `demo` is the only file served) and the static page.
- `page.mjs`: `connect` from `@pedit/serve/client`, CodeMirror 6 with `yCollab`, a status line.

## Notes

- pedit edits an existing file and never creates one: an app's "new document"
  creates the file first (empty is fine), then connects. This sample creates
  `content/demo.md` at start for that reason.
- `gone` is rare (pedit's saved state was discarded); the app decides what to show.
- The token is in the WebSocket URL: access logs must drop `token`.

Everything else (options, security model, limits) is in the
[package README](../../packages/serve/README.md).
