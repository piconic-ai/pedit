# Your own review page

Your app keeps a file open with [`@pedit/serve`](../packages/serve/README.md). With a review page on
your own domain, it can also share that file: reviewers open
`https://cms.example.com/review#<room>.<key>` in a browser, with no account and no install. The page
shows the file, who is there, and comments, in your look. Their edits and comments reach your app's
document; the file on disk is still written only by pedit.

The relay (`edit.piconic.ai` or your own) sees only ciphertext. If a link to edit.piconic.ai is enough
for your reviewers, you need none of this.

The design is in [design/embedding.md](design/embedding.md).

## Steps

### 1. Serve the page with the component

Install [`@pedit/review`](../packages/review/README.md) at a version you pin, and copy its one file
into your static files:

```sh
npm install --save-exact @pedit/review
cp node_modules/@pedit/review/dist/pedit-review.js public/assets/pedit-review-0.7.0.js
```

```html
<!doctype html>
<meta charset="utf-8">
<title>Review</title>
<script type="module" src="/assets/pedit-review-0.7.0.js"></script>
<pedit-review relay="https://edit.piconic.ai"></pedit-review>
```

Serve the file from your own origin. Do not load it from edit.piconic.ai or a CDN. The component, `@pedit/serve` and the
`pedit` CLI share one version number: keep them on the same one, and update them together. The
version banner that `pedit doctor` reads (step 4) is in releases after 0.7.0.

### 2. Send the policy and the Referrer-Policy

Send these as response headers (a `<meta>` tag is not enough), and put no other script on the page.
In a handler that returns a Fetch API `Response` (Hono, Workers, Deno, Bun):

```js
import { reviewCSP } from '@pedit/review/csp'

response.headers.set('Content-Security-Policy', reviewCSP({ relay: 'https://edit.piconic.ai' }))
response.headers.set('Referrer-Policy', 'no-referrer')
```

`reviewCSP` leaves `frame-ancestors` out unless you pass `frameAncestors`; pass `"'none'"` unless
another page of yours must frame the review page.
No analytics, no tag manager, no chat widget: anything that runs on the page can read the key in the
link. [examples/review-page](../examples/review-page/README.md) is a complete small server.

### 3. Share with the page's origin

The relay admits a browser to a room only from the origins the host gave when it shared. Pass your
page's origin in `origins` (at most 4; each `https://host[:port]`, or `http://localhost:<port>` or
`http://127.0.0.1:<port>` for development):

```js
const result = await routes.share('/home/me/notes/a.md', {
  origins: ['https://cms.example.com'],
  keep: '1d',
})
if (result.type === 'shared') {
  const url = `https://cms.example.com/review#${result.links.comment ?? result.links.read}`
}
```

`routes` comes from `peditRoutes(...)`. See [@pedit/serve](../packages/serve/README.md#sharing)
for the other results (`choice`, `closed`), `unshare` and `close`. A link is `<room>.<fragment>`; put your page URL and `#`
in front. A resumed room keeps the origins it was opened with.

### 4. Run `pedit doctor`

```sh
pedit doctor https://cms.example.com/review
```

`doctor` is in pedit releases after 0.7.0.

It fetches the page (no cookies, no Referer; it contacts only the page's origin; the `#fragment` is dropped)
and never opens a room. It checks:

- `https`: the page is served over HTTPS;
- `redirect`: the page does not redirect to another origin;
- `element`: one `<pedit-review>` with a valid `relay`;
- `csp`: the policy is a response header and not looser than `reviewCSP`'s for that relay;
- `scripts`: the component is the only script, with no inline scripts or handlers;
- `version`: the component's version against this pedit's;
- `referrer`: `Referrer-Policy` is `no-referrer`.

The exit status is 0 when no check fails (warnings do not fail), 1 when one does, and 2 when the page
cannot be checked. `--json` prints the same checks for a program. Run `pedit doctor --help` for the
details. Run it in CI against your deployed page.

## What you style

The component draws inside a shadow root. You can set `--pedit-*` custom properties (colours, fonts,
radius), fill the `logo` and `title` slots of the header, and set labels with `lang` or `labels`. The
editor and comment panel keep pedit's layout. See the
[component README](../packages/review/README.md#theming).

## What changes in trust

On edit.piconic.ai, reviewers trust pedit's deployment to serve honest JavaScript. On your page, they
trust yours. The relay still never sees the text or the key, but whoever can change your page or its
scripts can read every room opened from it, key included. Keep the page on a host you control, review
changes to it like your code, and tell your users. See
[security design](security-design.md#on-a-third-party-review-page-you-trust-its-operator).
