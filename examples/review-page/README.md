# review-page

A sample review page: the page an integrator serves so reviewers can open a file shared from their
app. It is one static HTML page that holds [`<pedit-review>`](../../packages/review/README.md), with
your branding in the header slots and a few `--pedit-*` properties. See "For integrators" in
[docs/design/embedding.md](../../docs/design/embedding.md).

- `public/index.html`: the whole page. Its only script is the element, from this origin.
- `server.mjs`: plain `node:http` on `127.0.0.1`. Every response carries `reviewCSP({ relay })`,
  `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

## Run

`@pedit/review` is not on npm yet, so the sample takes the bundle from the workspace build:

```sh
pnpm --dir ../../packages --filter @pedit/review build   # once
npm run build   # copies pedit-review.js into public/assets/ (gitignored)
node server.mjs
# Review page: http://127.0.0.1:3001/
```

`PORT` changes the port, `PEDIT_RELAY` the relay (default https://edit.piconic.ai).

After the release this becomes `npm i @pedit/review` at a pinned version, a copy of
`node_modules/@pedit/review/dist/pedit-review.js` into your static files, and
`import { reviewCSP } from '@pedit/review/csp'`. Serve the file from your own origin, never from a
CDN: the policy allows scripts from `'self'` only, and a script you do not control on this page
could read every room.

## With serve-app and a local relay

```sh
# 1. a relay (from packages/worker)
pnpm --dir ../../packages/worker dev            # http://127.0.0.1:8787
# 2. this page, against that relay
PEDIT_RELAY=http://127.0.0.1:8787 node server.mjs
# 3. serve-app, sharing to this page (in ../serve-app)
PEDIT_RELAY=http://127.0.0.1:8787 REVIEW_PAGE=http://127.0.0.1:3001/ node server.mjs
```

Press Share in serve-app: the links open this page at `http://127.0.0.1:3001/#<room>.<key>`.

## Trust

Whoever controls this page reads every room opened from it: the key arrives in the link's fragment
and the script on the page holds it. Serve it only from an origin you control, send the policy, and
add no other script. The page's origin is the one your app passes to `share` as `origins`.
