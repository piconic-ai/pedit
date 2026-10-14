# The public relay

`https://edit.piconic.ai` is the relay and browser editor that `pedit` uses
unless `.pedit/config.yaml` names another server. For the encryption and what
the relay can see, read [security design](security-design.md) first.

## Who runs it

The maintainers of [piconic-ai/pedit](https://github.com/piconic-ai/pedit)
run it on Cloudflare Workers, Durable Objects and R2.
<!-- TODO(operator): confirm operator name -->
It runs the latest release, deployed from this repository
([deployment](contributing/deployment.md)).

## What it keeps

- **Document text: none.** Frames are relayed and never stored.
- **Encrypted images**, in R2. They can be uploaded only while the room's host
  is connected, and the room deletes them when the host leaves. A deletion
  that fails is logged and not tried again.
- **Per room**: the SHA-256 of the admission token, and the number and total
  size of stored images. Deleted when the host leaves; the Durable Object's
  storage keeps 30 days of history for point-in-time recovery
  ([Cloudflare](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)).

Two things are not yet confirmed on this relay. Until they are, there is no
confirmed limit on how long images and per-room data can stay after the host
leaves:

- **A bucket rule for leftover images.** The relay relies on a lifecycle rule
  on its bucket to expire images a failed deletion leaves behind, one day after
  upload; R2 then removes them typically within a further day
  ([R2](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).
  The release deploy does not set this rule, and it is not yet confirmed on
  the public relay's bucket.
  <!-- TODO(operator): confirm the rule on edit-blobs (`wrangler r2 bucket lifecycle list edit-blobs`); deploy:production does not apply it. Once confirmed, drop this bullet, update the sentence introducing these bullets (see the next TODO), and add to the images bullet above: "A bucket rule expires leftovers one day after upload, and R2 removes them typically within a further day ([R2](https://developers.cloudflare.com/r2/buckets/object-lifecycles/))." -->
- **Cleanup after a relay update.** An update can drop every room's
  connections; a host whose `pedit` is still running reconnects. Whether a room
  whose host does not come back still deletes its images and per-room data is
  not yet confirmed. If it does not, the per-room data stays, and the images
  are left to the bucket rule above.
  <!-- TODO(operator): a deploy restarts every Durable Object and drops its WebSockets. Check whether a room whose host does not come back still deletes its images and per-room data (cleanup runs only in webSocketClose and webSocketError). If it does, drop this bullet and the "one case not yet confirmed" link in docs/security-design.md. If not, keep it as a known gap (its images stay until the bucket rule removes them, its per-room data stays), reword it and the security-design.md link as known rather than unconfirmed, or add a cleanup path to the Room. Whenever you drop or reword either bullet, rewrite the sentence introducing them to match what is left: with the bucket rule confirmed, images have a limit and only per-room data has none in this case; a bullet kept as a known gap is not "not yet confirmed". When neither bullet is left, drop that sentence. -->

## Logs

Workers Logs is on (`observability` in `packages/worker/wrangler.jsonc`). Each
request that reaches the Worker (`/api/*`: creating a room, WebSocket
connections, image uploads and downloads) gets an invocation log, and so does
each event in a room's Durable Object, including every WebSocket message it
relays, so the logs hold the time of every relayed frame. Cloudflare documents
that a request's log has details of the request and response and metadata it
adds, including the path, the status, and the request's `cf` properties, which
include country, city, postal code, coordinates and network (ASN)
([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs),
[`cf` properties](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties),
[query builder](https://developers.cloudflare.com/workers/observability/query-builder/)).
Which request headers this relay's logs keep is not yet confirmed, in
particular whether they keep the host token (`Authorization`) or the admission
token (`Sec-WebSocket-Protocol`, `X-Pedit-Admission`). Neither token can
decrypt anything.
<!-- TODO(operator): confirm in the dashboard that webSocketMessage events of the Room Durable Object appear as invocation logs, and whether they name the room. If per-frame logs are not wanted, set observability.logs.invocation_logs to false or lower head_sampling_rate, and update the comment in wrangler.jsonc. -->
The room ID is in the path; the key never reaches the relay. The Worker's own
log lines are `rate limited <route>`, without the address, and
`failed to delete blobs` with the error.

Workers Logs keeps logs for 3 days on the Workers Free plan and 7 days on
Workers Paid
([pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing));
from December 1, 2026, for seven days on both
([Cloudflare Observability pricing](https://developers.cloudflare.com/observability/pricing/)).
<!-- TODO(operator): confirm the Workers plan of the account that runs edit.piconic.ai, and so the retention that applies. -->
<!-- TODO(operator): open an invocation log of each route in the dashboard (POST /api/rooms, GET /api/rooms/:id/ws as host and as guest, GET and PUT /api/rooms/:id/blobs/:blobId) and list the fields actually kept. Check especially that no Authorization value (host token), Sec-WebSocket-Protocol value or X-Pedit-Admission value (admission token) is kept, and whether the client IP is. Tail Workers redact only headers whose names contain auth, key, secret, token or jwt, which Sec-WebSocket-Protocol and X-Pedit-Admission do not. Turn off invocation_logs, or correct this page, if they are kept. Then replace the sentence "Which request headers this relay's logs keep is not yet confirmed ..." in the first paragraph of this section with what the logs were found to keep. -->

## In your browser

The editor's own code sets no cookies and loads no analytics or tracking
scripts. Whether Cloudflare features on the piconic.ai zone add a cookie or
script of their own, such as the bot-protection cookie `__cf_bm` or a Web
Analytics beacon, is not yet confirmed.
<!-- TODO(operator): confirm that no Cloudflare zone feature adds a cookie or a script the repository does not contain: Web Analytics, Zaraz, or Bot Fight Mode / Bot Management (__cf_bm cookie). Then replace the sentence 'Whether Cloudflare features on the piconic.ai zone add ...' with what was found, or drop it if nothing is added. -->
The editor keeps in `localStorage` only the name you typed (`pedit:name`) and
display preferences: appearance, theme colours, the last Markdown and CSV view,
Vim mode and the split position (`pedit:appearance`, `pedit:palette`,
`pedit:view`, `pedit:table-view`, `pedit:vim`, `pedit:split`). No room ID, key
or document content. Decrypted images stay in memory. Your browser history
keeps the link, key included, and the HTTP cache keeps encrypted images until
the browser evicts them (they are sent with
`Cache-Control: private, max-age=3600`), so whoever later uses that browser
profile can decrypt them.

The Markdown preview loads images and videos from wherever the document links
them, and shows a YouTube (`youtube-nocookie.com`) or Vimeo player for a
YouTube or Vimeo link on a line of its own; those players run their own
scripts and can set their own cookies. Images and videos get no `Referer`;
the players get only the origin.

## What Cloudflare sees

The relay runs on Cloudflare, which handles every request and serves the
editor's code. It sees your IP address, which it passes to the Worker as
`CF-Connecting-IP`
([Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)),
and everything the relay sees. The Worker's code uses the address only to
count rate limits; Workers Logs may still record it with the request (see
[logs](#logs)).

## Terms

- Free, with no SLA. It may be limited or stopped at any time. For
  maintenance it can turn away new rooms, or close all rooms, open ones
  included.
- The relay keeps no document text, and deletes encrypted images when the
  host leaves; [what it keeps](#what-it-keeps) says what can be left behind,
  and [logs](#logs) what is logged. Everyone you give the link gets the
  content, and a CLI guest saves a copy.
- Use it to edit files with people you invite. Do not use it for content that
  is illegal or harms others, malware, harassment or spam, or to move data
  unrelated to editing. Do not try to get around its limits, enter rooms you
  were not invited to, or load test it ([testing guidelines](../SECURITY.md#testing-guidelines)).
- Rooms or networks that break these rules may be blocked.

## Reporting abuse

Send the room link, or just the room ID (the 22 characters after `/r/`), to
**[abuse contact: to be added]** <!-- TODO(operator): abuse contact -->.
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
| New rooms | 20 a minute from one network |
| WebSocket connections | 60 a minute from one network |
| One message | 1 MiB |
| Messages from one connection | Bursts of 1,000 messages and 32 MiB, then 200 messages and 1 MiB a second |
| Session length | No limit while the host is connected |

The values are `vars` and `ratelimits` in `packages/worker/wrangler.jsonc` and
the constants in `packages/worker/src/room.ts`. A network is one IP address,
or for IPv6 one /64. Rate limits are counted per Cloudflare location and are
approximate ([Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).
The new-room limit counts `POST /api/rooms` requests. The relay derives a
room's ID from its host token without remembering which tokens it issued, so a
client can make its own and skip that limit; every client is still held to the
connection limit. A guest over the rate limits is disconnected and
reconnects; a host over them ends the session.

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
