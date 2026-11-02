# serve-app

A text editor in the browser, bound to a local file that `pedit serve` holds,
built on [`@pedit/serve`](../../packages/serve). No room, no relay, no login.

## Run

```sh
npm install                # needs ../../packages/serve built: pnpm --filter @pedit/serve build
npm run build              # bundles page.mjs into public/page.js
node server.mjs            # PEDIT=/path/to/pedit only if pedit is not on the PATH
```

It prints `http://127.0.0.1:<port>/` and edits `content/demo.md`. `PEDIT=... node --test` checks it.

- `server.mjs`: Hono, `peditRoutes` (the id `demo` is the only file served) and the static page.
- `page.mjs`: `connect` from `@pedit/serve/client`, CodeMirror 6 with `yCollab`, a status line.

## Notes

- The file must exist before the first page connects; pedit does not create it.
- Do not write the file yourself while a page is connected.
- The child stops 60 s after the last page leaves and resumes the same document.
- `gone` is rare (pedit's saved state was discarded); the app decides what to show.
- The token is in the WebSocket URL: access logs must drop `token`.

Everything else (options, security model, limits) is in the
[package README](../../packages/serve/README.md).
