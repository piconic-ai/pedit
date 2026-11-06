# @pedit/review

The `<pedit-review>` element: your own page for reviewing a file that your app shares through
[pedit](https://github.com/piconic-ai/pedit). It shows the file, who is there, and comments, inside a
shadow root. The relay sees only ciphertext, and the key stays in the link's `#fragment`.

Experimental (0.x), and not published to npm yet. The design is in
[docs/design/embedding.md](../../docs/design/embedding.md).

## Use

Copy `dist/pedit-review.js` into your static files at a version you pin, and load it from your own origin:

```html
<script type="module" src="/assets/pedit-review-0.1.0.js"></script>
<pedit-review relay="https://edit.piconic.ai" name="Ana"></pedit-review>
```

- `relay` (required): the relay the room lives on. A link cannot point the page at another one.
- `name`: the reviewer's name. Without it the element asks ("Your name", Join). The name is kept in
  the element only, never in `localStorage`.
- The link is the page's `#<room>.<fragment>`. The element reads it from its own window and never
  sends it anywhere. Changing the hash opens the new room.

Events (bubbling, composed):

- `pedit-status`: `detail.status` is `connecting`, `live`, `host-away` or `ended`.
- `pedit-error`: `detail.reason` is `bad-link`, `unsupported-browser` or `missing-relay`, with
  `detail.message`.

## Page globals

Yjs marks `globalThis` when it loads, and warns if the page loads a second copy of Yjs. Keep Yjs out
of the page's own scripts (the CSP above allows none besides the element's). v1 supports one
`<pedit-review>` per page.

## Content-Security-Policy

```js
import { reviewCSP } from '@pedit/review/csp'

response.headers.set('Content-Security-Policy', reviewCSP({ relay: 'https://edit.piconic.ai' }))
```

`frameAncestors` is optional and left out by default. Put no other script on the page: anything that
runs there can read the key in the link.

## Build

`pnpm --filter @pedit/review build` writes `dist/pedit-review.js` (one file: no chunks, workers, fonts
or requests but the relay), `dist/csp.js` with its types, and `THIRD_PARTY_LICENSES.txt` for the code
the bundle includes. The test suite builds it and checks those claims.

The element reuses the review core in `packages/web/src/core` by relative path rather than through a
package: `@pedit/web` is a private page, not a library, and the core must stay one code path for both.
The libraries the bundle includes (CodeMirror, Yjs, BarefootJS, `@pedit/protocol`) are therefore
development dependencies here: they are bundled, so nobody installing the package needs them.
