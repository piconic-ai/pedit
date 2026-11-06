# Embedding: a review page on the app's own domain

The guest side of embedding pedit in another app (#235). The host side already
exists (`pedit serve`, `@pedit/serve`, docs/design/serve.md). The guide for the
integrator, the author of the app, is [review-page.md](../review-page.md). This
document is the design behind it.

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

`pedit serve` holds the document with no room and no relay (#372). Sharing adds
the host half of `pedit <file>` to the same process.

#### The room is one more client of serve's document

- `serve.Server` stays the only owner of the document and the only writer of
  the file. The room's session keeps a doc of its own, started from the
  server's whole state rather than from the file's text, so both docs have one
  history. The two exchange Yjs updates in the process, each update going to
  the other side once and never back. One doc under two locks (the room
  client's and the server's) would race, so they are not one doc.
- Awareness is bridged too, so app pages and reviewers see each other's
  cursors and presence. Each state crosses under its own client id. A state
  leaves the other side when its own side drops it, or when the bridge closes.
  - **Into the room**, presence rules hold (packages/protocol/src/presence.ts).
    Peers show a participant's access from how its frame is signed, never from
    its state, and a frame holds one entry. So the host sends each app page's
    state in a frame of its own, signed for that page's access:
    - an `edit` stream's state is edit-signed;
    - a `read` stream's state is sent unsigned, as a read link's is.

    The host holds every key, so this needs no change to the wire. It must
    never sign a page's state above that page's stream role, so a read-only
    page is never shown as an editor. The host renews these states, as it
    renews its own. When a page leaves, the host stops renewing its state, and
    peers time it out, since nobody sends another client's removal.
  - **Into serve**, the session forwards only the states it accepted under
    those rules, and the access each was heard with goes to the app in the
    `peers` event. Pages on the app's side are trusted as the app is; they get
    the states and nothing to sign with.
- The room's bridge is not a browser stream. It is not held to a stream's frame
  rates, awareness caps or queue, and it does not count toward the open-stream
  limit.
- v1 shares text files (Markdown or plain text). `share` on a `.canvas` file
  is an error.
- Reviewers can paste images. They are saved beside the file, as with
  `pedit <file>`.

#### The project

serve finds the project as `pedit <file>` does: it looks for the nearest
`.pedit/config.yaml` above the file's directory, up to the Git root, and reads
it under the same ownership checks. Unlike `pedit <file>`, it never creates
one. Without a config file, the project is the file's directory, or the Git
root when there is one. The project gives:

- where comments live (`<project>/.pedit/meta/`), so `pedit comments` and
  `pedit <file>` see the same comments;
- where kept records live, so `pedit rooms` lists the rooms serve keeps and
  `pedit close` can end them;
- the default relay (`server`). The `relay` of the share command overrides it,
  and without either it is `https://edit.piconic.ai`.

The project is read when sharing starts. Serving alone needs no project, as
today.

#### Commands (serve version 2)

The app sends commands as kind 5 frames: on stream 0, one JSON object of at
most 64 KiB. Each is answered by events on stream 0.

- `{"cmd":"share","origins":["https://cms.example.com"],"keep":"1d","relay":"…"}`
  - pedit creates the room, connects as its host and answers
    `{"event":"shared","room":"<id>","links":{"edit":…,"comment":…,"read":…},"keptUntil":<ms>,"resumed":false}`.
  - A link is `<room>.<fragment>` (see "Links"); the app puts its page URL in
    front, with `#`.
  - `origins` are checked as the relay checks `X-Pedit-Origins`: at most 4,
    each `https://host[:port]`, or `http://localhost:<port>` or
    `http://127.0.0.1:<port>`. They are sent as `X-Pedit-Origins` on the
    host's first connection.
  - `keep` works as `--keep` does: the default is 1 day, up to the relay's cap,
    and `0` makes a live room.
- `{"cmd":"unshare"}` leaves the room as `Ctrl+C` does: a kept room stays until
  its deadline, a live room ends. It is answered `{"event":"unshared"}`. Stdin
  closing is `unshare`.
- `{"cmd":"close"}` ends a kept room for good, as `pedit close` does: it takes
  the edits in, saves them and asks the relay to drop everything. It also works
  on a room that is kept but not shared now: pedit resumes it first. It is
  answered `{"event":"room_ended","reason":"closed"}`. On a live room it is
  `unshare` (answered `unshared`); with nothing shared or kept it is an error. A record of another
  history is refused: the app sends `share` with `choice`. If the relay cannot
  end the room (HTTP 409: it is busy), `close` is an error telling the app to
  send it again; the room and its record stay, and a share that was running has
  ended.
- Events while shared:
  - `{"event":"peers","peers":[{"name":…,"access":"edit"|"comment"|"read"}]}`
    whenever someone joins, leaves or renames. At most 64 people are listed, names
    cut to 64 bytes; `"more":N` counts those left out;
  - `{"event":"room_ended","reason":"closed"|"expired"|"maintenance"}` when
    the relay ends the room.
- Every command may carry `"id"`, a string of at most 64 bytes. The events that
  answer it carry the same `id`: `shared`, `resume_choice`, `unshared`,
  `room_ended` (for `close`, or `share` with `choice: "app"`) and `error`.
  Events nobody asked for (`peers`, a `room_ended` from the relay) carry none,
  so the app tells an answer from an unsolicited event by the id. If `close`
  leaves a running share and then fails, pedit sends an `unshared` without an
  id before the `error`: the share is over even though the close was not done.
- A command that is not valid JSON, or has an unknown `cmd` or bad fields, is
  answered `{"event":"error","cmd":…,"message":…}` and does not end the child.
  Only a frame that breaks the frame format ends the child, as today. One share
  at a time: `share` while shared is an error.
- Saving, external saves and the lock are unchanged: the room is one more
  client of the document pedit already owns.

#### Kept rooms keep one history

A kept room's record written by serve also stores serve's generation and the
room's origins. serve's state and the record then hold the same history, and
they must not drift apart for no reason. A matching generation is the only
proof of one history. Finding a record by the file's path proves nothing: a
record written by `pedit <file>` has no generation, and its document was
created on its own even when the text is the same.

- On start, serve resumes its state as today. If the state cannot be used
  (missing, too old, of another version, damaged), but a kept record for the
  file carries a generation and its document fits the file by the same
  last-written check, serve resumes from the record's document and generation
  instead.
- While a kept record for the file exists, serve's state does not expire by
  age.

**Resuming.** When the app sends `share` for a file that has a record whose
generation is serve's, pedit takes the room up again. The record is found by
the file's path among the project's records. pedit applies what reviewers wrote meanwhile to the
document as Yjs updates (it is the same history), then answers `shared` with
`"resumed": true` and the same links. It does not apply them as a text diff,
which would insert the app's edits a second time. A resumed room keeps the
origins it was opened with: a `share` with a different list is an error.

**When the histories differ.** The record found for the file may have no
generation (it was written by `pedit <file>`) or another one (serve's state and
the record's document were both unusable, or the file changed so that neither
fits it). Then `share` answers with a choice instead of `shared`:

    {"event":"resume_choice","room":"<id>","choices":[
      {"choice":"room","text":<chars>},
      {"choice":"app","text":<chars>},
      {"choice":"later"}]}

`text` is the number of characters each side holds. How much was written while
away would need a connection to the relay, so it is not sent.

The app (that is, the person using it) picks one and sends
`{"cmd":"share","choice":"room"}`, with the same other fields as before:

- `room` keeps the room. The app's text is merged into the room's document as a
  text merge, and serve adopts that document under the record's generation.
  App pages get `gone`; reviewers' links go on working.
- `app` takes the reviewers' edits and comments into the app's document as a
  text merge, then ends the room as `close` does. A new `share` gives new links.
- `later` does nothing, and the room stays until its deadline. `share` is
  answered with an error saying that sharing waits for a choice.

No choice loses an edit; they differ only in whose pages reload.

Like `pedit resume` and `pedit close` today, kept rooms from `pedit serve` need
Unix file permissions for the record. On Windows, `share` with a keep is refused
until the record is ported, and live rooms work.

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
- **v1 scope:** one text file (Markdown or plain text), editing by access
  level, comments, comment-only and read-only links, viewing and pasting images,
  presence, and the host-away state of kept rooms. While the host is away, an
  edit link keeps editing and commenting and the header says until when. A
  comment-only link can comment then too, but not edit: see
  [kept-comments.md](kept-comments.md) (protocol version 8).
- **Next, soon after v1:** several files (tabs), the CSV table, canvas, and the
  Markdown preview. The core is cut so that each is a view the component can
  mount, as packages/web mounts them today: a file's kind picks its view, and an
  unknown kind shows the text. Adding one is adding a view to the component's
  bundle, not a change to the core or the wire.
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

Not published in v1. It is published once it is stable, which means:

- the component has shipped and been used by an integrator for a release cycle
  without a breaking change to the room client;
- the public surface is cut down to what a client needs (link parsing and keys,
  the room client, attachments, comments), with test fakes and relay-only
  modules (CSP, kinds used by the Worker) moved out of the index;
- it builds to JavaScript with types, under the same versioning rule as the
  serve surface: additive within a major version, checked by the wire version
  (`pedit --version --json` reports it as `wire`).

### `pedit doctor <url>`

Fetches the page (no cookies, no redirects off the origin) and reports:
the CSP against `reviewCSP` for the page's relay, scripts other than the
component, inline scripts, the component's version against this pedit's version (the packages share one version), and
whether the page sets `Referrer-Policy: no-referrer`. It never opens a room.
`--json` prints the same checks for a program; the exit status is 0 when none
fails, 1 when one does, 2 when the page cannot be checked. Run `pedit doctor --help`.

### Order

1. Per-room origins on the relay, with tests (useful alone: a self-hosted page).
2. Share from `pedit serve` and in `@pedit/serve`.
3. Review core extracted from packages/web, the relay's editor rebuilt on it.
4. `@pedit/review` and a sample static page in `examples/`.
5. `pedit doctor`.
6. Docs: the integrator guide is [review-page.md](../review-page.md);
   docs/security-design.md and docs/public-relay.md say who is trusted on a
   third-party page.

### What stays out

- No TCP listener in pedit (#114 §6); the relay is the only network peer.
- No auth (AGENTS.md): the origin list scopes a room to pages, not users.
- No iframe of the relay's editor: its `frame-ancestors 'none'` stays.
- Serving the component from edit.piconic.ai: it would make every integrator's
  page trust pedit's deployment again, and break the integrator's own review of
  the code their users run.
