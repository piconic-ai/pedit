# Embedding: a review page on the app's own domain

DRAFT for #235. This is the guest side of embedding pedit in another app. The host
side already exists (`pedit serve`, `@pedit/serve`, docs/design/serve.md). The first
half of this document is written for the integrator, the author of the app, and
asks them what they would wire up. The second half is the design behind it.
Questions still open are marked **Open**.

## For integrators

### What you get

Your app already keeps a file open through `@pedit/serve`, and your editor edits it
live. With this, the app can also share the file: pedit opens an encrypted room on
a relay and gives you a link to **your own review page**, for example
`https://cms.example.com/review#…`. Reviewers open that page in a browser. It shows
the file, who is there, and comments, in your look. Their edits and comments reach
your app's document; the file on disk is still written only by pedit.

Reviewers need no account and no install. The relay (the public one at
`edit.piconic.ai`, or your own) sees only ciphertext.

### What you do

1. **Serve one static page** with the review component. Copy the component's one
   file from the npm package `@pedit/review` into your static files, at a version
   you pin; do not load it from edit.piconic.ai or another CDN:

   ```html
   <!doctype html>
   <meta charset="utf-8">
   <title>Review</title>
   <script type="module" src="/assets/pedit-review-1.0.0.js"></script>
   <pedit-review relay="https://edit.piconic.ai"></pedit-review>
   ```

2. **Send the Content-Security-Policy** that `@pedit/review` gives you for that
   relay (`reviewCSP({ relay })`), and put no other script on the page: no
   analytics, no tag manager, no chat widget. Anything that runs on the page can
   read the key in the link.
3. **Tell pedit the page's origin** when you share: `https://cms.example.com`.
   The relay admits browsers from that origin to this room only.
4. Optional: run `pedit doctor https://cms.example.com/review` to check the CSP,
   the scripts on the page and the component version.

You do not handle keys, encryption, permissions or attachments: the component
and pedit do.

### What you style

The component draws inside a shadow root. You can change:

- colours, fonts, spacing and radii through CSS custom properties
  (`--pedit-bg`, `--pedit-fg`, `--pedit-accent`, `--pedit-font`, …);
- the header through slots: `<img slot="logo">`, `<span slot="title">`;
- labels through attributes (`lang`, or `labels` as JSON).

The editor area, the comment panel and the presence list keep pedit's layout.

### What changes in trust

On edit.piconic.ai, reviewers trust pedit's deployment to serve honest
JavaScript. On your page, **they trust yours**. The relay still never sees the
text or the key, but whoever can change your page can read every room opened
from it. Keep the page on a host you control, behind the same review as your
code, and say so to your users.

### Questions for you

- Do your reviewers need your own page, or is an edit.piconic.ai link enough?
  If it is enough, none of the work below is needed.
- Which of these do reviewers use: editing, comments, comment-only links,
  read-only links, pasting images, several files in one room?
- How far must the look follow your app: colours and logo, or more?
- Can you serve a static page with your own response headers (the CSP)?
- Does your app share one file at a time, or several?

## Design

### Pieces

| Piece | Where | What |
| --- | --- | --- |
| Share from serve | `pedit serve` (Go), `@pedit/serve` | The app asks the running `pedit serve` to open a room; it returns the links. |
| Per-room origins | relay (packages/worker) | The host declares page origins; the relay admits them to that room only, for the WebSocket and attachments. |
| Review core | packages/web → shared module | The room connection, the editor binding, comments and attachments, without page globals. Both the relay's editor and the component use it. |
| `<pedit-review>` | new package `@pedit/review` | A web component on the core, bundled to one file, with `reviewCSP()`. |
| `pedit doctor <url>` | Go CLI | Fetches a review page and checks its CSP, scripts and component version. |

### Share from `pedit serve`

`pedit serve` holds the document with no room and no relay (#372). Sharing adds the
host half of `pedit <file>` to the same process:

- A new command on the control stream: `{"cmd":"share","origins":["https://cms.example.com"],"keep":"1d"}`.
  pedit creates the room, connects as host with the document it already holds,
  and answers with an event: `{"event":"shared","room":"<id>","links":{"edit":…,"comment":…,"read":…}}`.
  The links are fragments only (see "Links"); the app puts its page URL in front.
- `{"cmd":"unshare"}` ends the room; stdin closing ends it as today.
- Saving, external saves and the lock are unchanged: the room is one more client
  of the document pedit already owns.
- This needs a control channel from the app to pedit. Today the serve framing
  carries pedit → app events only (kind 4 on stream 0); a command kind from the
  app is added. That is a `serve` version bump (2).
- The relay comes from the app (`relay` in the share command, default
  `https://edit.piconic.ai`), not from `.pedit/config.yaml`: serve does not read
  project configuration.

**Open:** keep (the room stays after the app closes) needs the app to resume a room
later; v1 may share live rooms only (`keep: 0`).

### Links

The relay's editor derives the relay from its own location and uses
`/r/<room>#<fragment>`. A page on another domain cannot, so:

- The page fixes its relay in the `relay` attribute; the CSP pins it in
  `connect-src`. A link cannot point the page at another relay.
- The link is `<page URL>#<room>.<fragment>`: the room id (22 characters) and the
  existing fragment (`<secret>`, `c.<…>` or `r.<…>`). Nothing new reaches a
  server: everything after `#` stays in the browser, as today.
- Links to edit.piconic.ai keep working for the same room: the relay's editor
  still admits its own origin.

### Per-room origins on the relay

Today the Worker admits a WebSocket only from its own origin or with no Origin
header (the CLI), before the Durable Object is reached; attachments have no
origin check and no CORS, and are protected only because their custom header
forces a preflight that fails.

- **Declared by the host on its first connection**, like keep: a host-only
  upgrade header `X-Pedit-Origins` (comma-separated). The Worker passes it on
  only after the host-token check, as it does `X-Pedit-Keep`. The Durable Object
  stores it with the admission hashes, and deletes it when the session ends.
- **Checked in the Durable Object.** Only the room knows its list, so the Worker
  forwards an upgrade whose Origin is not its own to the room, marked as foreign.
  The room admits it if the origin is on its list; otherwise it accepts and
  closes with a close code the page can show ("this page is not allowed for this
  room"), instead of today's bare 403. A room with no list refuses every foreign
  origin, as today.
- **Attachments:** `OPTIONS` and the responses of `GET`/`PUT
  /api/rooms/:id/blobs/:blob` carry `Access-Control-Allow-Origin: <origin>`,
  `Access-Control-Allow-Headers: X-Pedit-Admission`,
  `Access-Control-Allow-Methods: GET, PUT` and `Vary: Origin`, only for an origin
  on the room's list. The admission token is still required.
- **Limits:** at most 4 origins; each `https://host[:port]`, or
  `http://localhost:<port>` / `http://127.0.0.1:<port>` for development; no
  wildcards, no paths.
- Rooms with no declared origins behave exactly as today.

### Review core

packages/web is one page: a 950-line `joinRoom()` closure, a 2,300-line global
stylesheet, components rendered by global name into `#app`, document-level
listeners, and the relay taken from `location`. The component cannot reuse it as
is, and a second copy of the room logic would drift.

- Extract what a review needs into modules that take their inputs instead of
  reading the page: the relay URL, the link, a root element, a style root.
  Room connection and keys, the text editor with `yCollab`, comments (manifest,
  meta docs, panel), attachments (blob fetch and decrypt, type sniffing, SVG
  refusal, paste and upload), presence, access states, and the host-away state
  of kept rooms.
- The relay's editor is rebuilt on the same modules, so both stay one code path.
  Table view, canvas, Markdown preview with embeds, vim, settings and themes
  stay in packages/web.
- No new UI framework: the core keeps BarefootJS components and the `Store`
  pattern (AGENTS.md); the component mounts them into its shadow root.

### `<pedit-review>`

- Attributes: `relay` (required), `lang`, `labels`. It reads the link from
  `location.hash` and never sends it anywhere.
- One ES module file with no external requests but the relay. Styles live in the
  shadow root; theming only through the custom properties and slots above.
- **v1 scope (Open, see the questions):** one text file (Markdown or plain
  text), editing by access level, comments, comment-only and read-only links,
  viewing and pasting images, presence, host away. Not in v1: canvas, CSV table,
  several files, Markdown preview, embeds.
- Events for the page: `pedit-status` (connecting, live, host away, ended),
  `pedit-error`.
- `reviewCSP({ relay })` returns the policy: `default-src 'none'`,
  `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' blob:`
  plus the avatar hosts, `connect-src <relay https> <relay wss>`, `base-uri
  'none'`, `form-action 'none'`, `object-src 'none'`; `frame-ancestors` is the
  integrator's choice.

### `@pedit/protocol`

The package is private, exports TypeScript source with no build, and its index
re-exports nearly everything, test fakes included. The component bundles what it
needs, so integrators do not depend on it directly.

**Open:** publishing it as a supported, versioned API is only worth doing if an
integrator wants to build their own UI instead of using the component.
Proposed: not in v1.

### `pedit doctor <url>`

Fetches the page (no cookies, no redirects off the origin) and reports:
the CSP against `reviewCSP` for the page's relay, scripts other than the
component, inline scripts, the component's version against the newest, and
whether the page sets `Referrer-Policy: no-referrer`. It never opens a room.

### Order

1. Per-room origins on the relay, with tests (useful alone: a self-hosted page).
2. Share from `pedit serve` and in `@pedit/serve`.
3. Review core extracted from packages/web, the relay's editor rebuilt on it.
4. `@pedit/review` and a sample static page in `examples/`.
5. `pedit doctor`.
6. Docs: this guide moves to the integrator docs; docs/security-design.md and
   docs/public-relay.md say who is trusted on a third-party page.

### What stays out

- No TCP listener in pedit (#114 §6); the relay is the only network peer.
- No auth (AGENTS.md): the origin list scopes a room to pages, not users.
- No iframe of the relay's editor: its `frame-ancestors 'none'` stays.
- Serving the component from edit.piconic.ai: it would make every integrator's
  page trust pedit's deployment again, and break the integrator's own review of
  the code their users run.
