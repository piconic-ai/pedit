# The public relay

`https://edit.piconic.ai` is the relay and browser editor that `pedit` uses
unless `.pedit/config.yaml` names another server. For the encryption and what
the relay can see, read [security design](security-design.md) first.

## Who runs it

kobaken (an individual, [kobaken.co](https://kobaken.co); contact
[kobaken@piconic.ai](mailto:kobaken@piconic.ai)) runs it for
[piconic-ai/pedit](https://github.com/piconic-ai/pedit) on Cloudflare Workers,
Durable Objects and R2. It runs the latest release, deployed from this repository
([deployment](contributing/deployment.md)).

## What it keeps

The relay is not permanent storage. Its design permits keeping room content
only as ciphertext while the room is open. Once the host has taken in changes,
the relay's copies can be deleted without losing them. Live rooms relay frames
without storing them. Kept rooms store ciphertext as described below.

- **Plaintext document text: none.** Live-room frames are relayed and never stored.
- **Encrypted images**, in R2. They can be uploaded only while the room's host
  is connected, and the room deletes them when the host leaves. A deletion
  that fails is logged and not tried again; a bucket rule expires leftovers
  one day after upload, and R2 removes them typically within a further day
  ([R2](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).
  The release deploy adds the rule to the bucket if it is missing.
- **Per room**: the SHA-256 of the admission token, and the number and total
  size of stored images, deleted when the host leaves; and the time the host
  first connected, kept after the room ends so that its ID cannot be used
  again. The Durable Object's storage keeps 30 days of history for
  point-in-time recovery
  ([Cloudflare](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)).

With `--keep`, the relay stores an encrypted text snapshot and a bounded log
of encrypted, editor-signed Yjs updates in the room's SQLite storage. A host
truncates the log only after saving the edits locally. Guests can read and
edit while the host is away. The relay deletes the snapshot and log at the
keep deadline or total room limit. A marker prevents reuse of the closed room.
The relay learns ciphertext sizes, request times, and opaque sender identifiers
and counts. It receives no plaintext or URL-fragment key. A relay can still
withhold or replay data; a signature does not prove freshness or availability.

The following disconnect behavior describes live rooms without `--keep`.

A host whose connection drops, rather than one ending the session with
Ctrl+C, gets two minutes to come back: meanwhile the room keeps its guests,
lets new ones in and keeps its images and per-room data, and nobody edits. If
the host does not come back, the room ends as if it had left.

A relay update can drop every room's connections without the room seeing
anyone leave. Keep the host's `pedit` running. It reconnects with the same link
and merges the state kept on participant devices. Text, canvas changes, and
comments save to the host during the session. Pending saves and edits still
in transit can be lost if a device crashes. A guest that reconnects before the
host starts the same two-minute wait. If nobody reconnects, the hourly check
deletes orphaned images and per-room data within about an hour. Starting
`pedit` again creates a new room and link.

The two-minute grace period preserves guests, images, and per-room data after
a host disconnect. It does not extend the public relay's 24-hour room limit,
measured from the host's first connection. After the grace period expires,
guests are disconnected and their link stops working until the host returns.
Ctrl+C closes the guests' sessions immediately and their link stops working.
The 24-hour limit closes the room even if the host returns. Self-hosted relays
have no room time limit unless configured.

## Logs

Workers Logs is on (`observability` in `packages/worker/wrangler.jsonc`). Each
request that reaches the Worker (every page and file of the editor, which it
serves to add security headers, and `/api/*`: creating a room, WebSocket
connections, image uploads and downloads) gets an invocation log, and so does
each event in a room's Durable Object, including every WebSocket message it
relays, so the logs hold the time of every relayed frame. Cloudflare documents
that a request's log has details of the request and response and metadata it
adds, including the path, the status, and the request's `cf` properties, which
include country, city, postal code, coordinates and network (ASN)
([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs),
[`cf` properties](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties),
[query builder](https://developers.cloudflare.com/workers/observability/query-builder/)).
A logged request (checked on `POST /api/rooms`) keeps the client's IP address
(`cf-connecting-ip`, `x-real-ip`), the `user-agent`, `accept`, `accept-encoding` and
`host` headers, and the `cf` properties: country, city, postal code,
coordinates, time zone, ASN and organization, and TLS version, cipher and
client fingerprints. A guest's `GET /api/rooms/:id/ws` entry and a `PUT /api/rooms/:id/blobs/:blobId`
entry (both checked from a browser) keep request headers whole: the
`sec-websocket-protocol` header and the `x-pedit-admission` header, so the
admission token is stored in plain text for the 7 days the logs are kept, and
also `origin`, `accept-language` and the `sec-ch-ua*` client hints. The CLI
host's `GET /api/rooms/:id/ws` entry (checked on the Room Durable Object side)
keeps `sec-websocket-protocol` (the editor token) and `x-pedit-read-admission`
(the reader token) in plain text and the `user-agent` (`Go-http-client/1.1`),
but shows `authorization` (the host token) as `********`, so Cloudflare masks
it. The relay keeps these logs to see which routes fail, and accepts that
they hold the admission tokens: a token cannot decrypt anything, and stops
working when its room ends, within 24 hours
([room admission](contributing/room-admission.md)). The Worker-side entry of
the host's request has not been looked at.
<!-- TODO(operator): confirm in the dashboard that webSocketMessage events of the Room Durable Object appear as invocation logs, and whether they name the room. If per-frame logs are not wanted, set observability.logs.invocation_logs to false or lower head_sampling_rate, and update the comment in wrangler.jsonc. -->
The room ID is in the path; the key never reaches the relay. In the entries
looked at, the room ID and the blob ID in the path showed as `REDACTED`.
Nobody redacted them by hand: workerd replaces ID-like parts of a URL in logs
(`redactUrl` in `src/workerd/api/util.c++`: 32 or more hex digits, or 21 or
more characters with at least two digits, two upper case and two lower case
letters). A room ID with fewer than two digits does not match, so some room
IDs, about one in eight by that rule, are kept as they are. The Worker's own
log lines are `rate limited <route>`, without the address,
`failed to delete blobs` with the error, and one JSON line per event that
ends a session or turns someone away, so a room that closed unexpectedly can
be explained: `room: host connected`, `room: host closed` (with its close
code), `room: host errored`, `room: host away` (the room waits for a host
that dropped), `room: host returned`, `room: host did not come back`,
`room: alarm found no host`,
`room: closed a peer` (rate limited, a frame too big, or text),
`room: closed for maintenance`, `room: session ended` (with the close code
and reason) and `room: turned a guest away`. Each names the room's Durable
Object ID rather than the room ID, and gives how many hosts and guests were
connected and how long ago the host first came.

This relay runs on Workers Paid, where Workers Logs keeps logs for 7 days
([pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing),
[Cloudflare Observability pricing](https://developers.cloudflare.com/observability/pricing/)).
<!-- TODO(operator): look at the Worker-side (stateless) entry of a host's GET /api/rooms/:id/ws to see whether Authorization is masked there too, and update this section and web/public/privacy.html if it is not. -->

## In your browser

The editor's own code sets no cookies and loads no analytics or tracking
scripts. The home page and `POST /api/rooms` were checked and set no cookie.
Cloudflare inserts its Web Analytics script tag
(`static.cloudflareinsights.com/beacon.min.js`) into the page; the page's
Content-Security-Policy allows scripts only from the relay itself, so a browser
should not load it (inferred from the policy, not yet seen in a browser
console). Responses also carry Network Error Logging headers (`nel`,
`report-to`, `success_fraction` 0): if a browser cannot reach the relay, it may
report the failure to Cloudflare.
<!-- TODO(operator): decide whether to switch off the automatic Web Analytics insertion for piconic.ai in the dashboard, and check in a browser that the beacon is blocked and that no cookie (such as __cf_bm) is set on the WebSocket and asset requests. Then update this paragraph and web/public/privacy.html. -->
The editor keeps in `localStorage` only the name you typed (`pedit:name`) and
display preferences: appearance, theme colours, the last Markdown and CSV view,
Vim mode and the split position (`pedit:appearance`, `pedit:palette`,
`pedit:view`, `pedit:table-view`, `pedit:vim`, `pedit:split`). No room ID, key
or document content. Decrypted images stay in memory. Your browser history
keeps the link, key included, and the HTTP cache keeps encrypted images until
the browser evicts them (they are sent with
`Cache-Control: private, max-age=3600`), so whoever later uses that browser
profile can decrypt them.

The Markdown preview does not load images or videos from other sites: an
external image shows as a placeholder saying this relay does not load external
images, so a document cannot make your browser contact a host its author
picked. Images pasted in the session are decrypted in your browser and shown
from memory. A link on a line of its own to YouTube (`youtube-nocookie.com`),
Vimeo, Loom, Figma, CodePen, StackBlitz, Observable, Spotify, SoundCloud or
Miro shows a placeholder naming the host it would load from; the player loads
only when you click it, so a URL in the file alone does not make anyone's
browser contact that site. If you tick "Always load" for a provider, your
browser loads that provider's players without asking; the choice is stored in
your browser only (just the provider's id, such as `youtube`, no URL), is never sent to the
relay, and can be undone in Settings. This is for privacy, not a sandbox: once loaded, the
players run their own scripts, can set their own cookies, and get only the
origin as `Referer`. The page's
Content-Security-Policy enforces this, by path where the provider allows
(`https://www.loom.com/embed/`, for example). CodePen is the exception: its
players live at `/{user}/embed/{pen}`, which no Content-Security-Policy source
can name, so the policy allows all of `https://codepen.io/` and the editor
frames only player URLs of that shape: the browser refuses any other image,
video, frame or connection. A self-hosted relay can allow external images and
videos with `MEDIA_SOURCES` ([self-hosting](self-hosting.md#room-limits)), and
be built with other sites' players
([embeds](embeds.md#customizing-the-providers)); the public relay does neither.

A link on a line of its own to a file on GitHub
(`https://github.com/{owner}/{repo}/blob/{ref}/{path}`, with `#L10` or
`#L10-L20` for some of its lines) shows the same kind of placeholder, naming
`raw.githubusercontent.com`. Only once you click it, or if you ticked "Always
load GitHub", your browser fetches
`https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` itself, without
cookies or a `Referer`, so GitHub sees your IP address and which file, but not
the room or its key; the relay sees nothing of it. Only public files can be
shown. The text is shown as text, never as markup or script, and only up to
1 MB and 5000 lines; anything else shows a short message and the link. The
Content-Security-Policy allows connections to `https://raw.githubusercontent.com/`
for this, and to no other host but the relay.

## What Cloudflare sees

The relay runs on Cloudflare, which handles every request and serves the
editor's code. It sees your IP address, which it passes to the Worker as
`CF-Connecting-IP`
([Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)),
and everything the relay sees. The Worker's code uses the address only to
count rate limits; Workers Logs may still record it with the request (see
[logs](#logs)).

## Terms and privacy policy

The terms of use and the privacy policy are served by the relay itself, at
[`/terms`](https://edit.piconic.ai/terms) and
[`/privacy`](https://edit.piconic.ai/privacy)
(sources: `packages/web/public/terms.html` and `privacy.html`). In short:

- Free, with no SLA. It may be limited or stopped at any time. For
  maintenance it can turn away new rooms, or close all rooms, open ones
  included.
- Use it to edit files with people you invite. Do not use it for content that
  is illegal or harms others, malware, harassment or spam, or to move data
  unrelated to editing. Do not try to get around its limits, enter rooms you
  were not invited to, or load test it ([testing guidelines](../SECURITY.md#testing-guidelines)).
- Rooms or networks that break these rules may be blocked.

Keep the pages and this document in step: when what the relay keeps or logs
changes, change `privacy.html` and its "Last updated" date in the same pull
request.

## Reporting abuse

Send the room link, or just the room ID (the 22 characters after `/r/`), to
[abuse@piconic.ai](mailto:abuse@piconic.ai).
Leave out the `#` and what follows unless you want the operator to see the
content: the full link also lets them edit. The operator can block a room by
its ID without seeing its content, which is encrypted.
To report a vulnerability instead, see [SECURITY.md](../SECURITY.md).

## Limits

| | Public relay |
| --- | --- |
| People in a room | The host and 4 guests |
| One image | 5 MiB before encryption |
| Images of a session | 50 MiB encrypted, 500 images |
| Image uploads at once, per room | 4 |
| Room creation requests | 20 a minute from one network |
| WebSocket connections | 60 a minute from one network |
| One message | 1 MiB |
| Messages from one connection | Bursts of 1,000 messages and 32 MiB, then 200 messages and 1 MiB a second |
| Session length | 24 hours from the host's first connection |
| Kept room after departure | Up to 7 days; the CLI reports any clamp |
| Kept room total life | At least the effective keep duration; measured from publication |
| Kept text snapshot | 1 MiB of ciphertext for all files together; at most 64 text files, fixed when the room opens |
| Kept text log | 4 MiB of encrypted editing history before the host checkpoints; a 10,000-entry abuse guard also applies |
| Kept room requests | 1,200 a minute from one network |

Kept guests batch pending edits once per second. The 4 MiB budget measures
encrypted update history, including signatures and encryption overhead, rather
than keystrokes or final document size. Repeated replacements and deletions
also use this budget; after it fills, the host must resume and checkpoint
before more edits can be retained. Each encrypted entry is at most 1 MiB.

The values are `vars` and `ratelimits` in `packages/worker/wrangler.jsonc` and
the constants in `packages/worker/src/room.ts` and `kept-text.ts`. A network is one IP address,
or for IPv6 one /64. Rate limits are counted per Cloudflare location and are
approximate ([Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).
The new-room limit counts `POST /api/rooms` and kept-room initialization requests. The relay derives a
room's ID from its host token without remembering which tokens it issued, so a
live client can make its own and skip that creation request; WebSocket clients
are still held to the connection limit. Kept-room initialization cannot skip
its creation limit. A guest over the rate limits is disconnected and
reconnects; a host over them ends the session. A live room ends 24 hours after its
host first connected, even if the host is still connected or has reconnected
since: everyone is disconnected and its link stops working. Running pedit
again starts a new room with a new link. A pedit released before this limit
existed is not told the room ended: it keeps trying to reconnect, with backoff,
and is refused each time until it is stopped.

**Files over about 1 MiB are not supported.** A newcomer receives the whole
shared document in one message, and the relay closes a connection that sends a
message over 1 MiB. pedit refuses to share a larger file. A client whose edit
would need a larger message does not send it: it leaves the room for good, and
if it is the host, the session ends. The limit is on the shared document, not
the file. A canvas takes up to about 1.7 times its JSON size, and the host's
copy grows as people edit, so a long session on a file under 1 MiB can still
reach the limit. A document that grows past the limit during a session keeps
syncing until someone joins or the host reconnects, and that ends the session.
This holds on self-hosted relays too.

## The CLI's other network request

Besides the relay, the CLI itself connects only to `api.github.com`, to check
for a newer release (`cmd/pedit/update.go`). It keeps an answer for a day in
`pedit/update.json` in your user cache directory, and does not ask again until
then. Development builds, output that is not a terminal and runs with `CI` set
skip it. The request is a plain `GET` of the latest release: it carries no file
name, room or key, and GitHub sees your IP address. When a newer release is
out, pedit prints the command to upgrade. It never downloads or runs anything.
