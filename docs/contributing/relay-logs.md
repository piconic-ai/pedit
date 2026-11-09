# Relay logs: what was checked, and what remains

For whoever runs the public relay. [The public relay](../public-relay.md#logs)
tells users what the logs hold; this page records how that was found out,
entry by entry, and lists the checks still open. When an open item is
settled, update that page and `packages/web/public/privacy.html` in the same
pull request.

## What was checked

Workers Logs is on (`observability` in `packages/worker/wrangler.jsonc`). Each
request that reaches the Worker gets an invocation log, and so does each
event in a room's Durable Object, including every WebSocket message it
relays. Cloudflare documents that a request's log has details of the request
and response and metadata it adds, including the path, the status, and the
request's `cf` properties
([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs),
[`cf` properties](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties),
[query builder](https://developers.cloudflare.com/workers/observability/query-builder/)).

Entries looked at in the dashboard, and what each keeps:

- `POST /api/rooms`: the client's IP address (`cf-connecting-ip`,
  `x-real-ip`), the `user-agent`, `accept`, `accept-encoding` and `host`
  headers, and the `cf` properties: country, city, postal code, coordinates,
  time zone, ASN and organization, and TLS version, cipher and client
  fingerprints.
- A guest's `GET /api/rooms/:id/ws` and a `PUT /api/rooms/:id/blobs/:blobId`,
  both from a browser: request headers whole, so `sec-websocket-protocol`
  and `x-pedit-admission` hold the admission token in plain text, and
  `origin`, `accept-language` and the `sec-ch-ua*` client hints are kept.
- The CLI host's `GET /api/rooms/:id/ws`, on the Room Durable Object side:
  `sec-websocket-protocol` (the editor token) and `x-pedit-read-admission`
  (the reader token) in plain text, the `user-agent` (`Go-http-client/1.1`),
  and `authorization` (the host token) shown as `********`, so Cloudflare
  masks it.

The relay keeps these logs to see which routes fail, and accepts that they
hold the admission tokens: a token cannot decrypt anything, and stops
working when its room ends, within 24 hours
([room admission](room-admission.md)).

## Room IDs in paths

The room ID is in the path; the key never reaches the relay. In the entries
looked at, the room ID and the blob ID in the path showed as `REDACTED`.
Nobody redacted them by hand: workerd replaces ID-like parts of a URL in logs
(`redactUrl` in `src/workerd/api/util.c++`: 32 or more hex digits, or 21 or
more characters with at least two digits, two upper case and two lower case
letters). A room ID with fewer than two digits does not match, so some room
IDs, about one in eight by that rule, are kept as they are.

## The Worker's own log lines

`rate limited <route>`, without the address; `failed to delete blobs` with
the error; and one JSON line per event that ends a session or turns someone
away, so a room that closed unexpectedly can be explained: `room: host
connected`, `room: host closed` (with its close code), `room: host errored`,
`room: host away` (the room waits for a host that dropped), `room: host
returned`, `room: host did not come back`, `room: alarm found no host`,
`room: closed a peer` (rate limited, a frame too big, or text), `room: closed
for maintenance`, `room: session ended` (with the close code and reason) and
`room: turned a guest away`. Each names the room's Durable Object ID rather
than the room ID, and gives how many hosts and guests were connected and how
long ago the host first came.

## Retention

The relay runs on Workers Paid, where Workers Logs keeps logs for 7 days
([pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing),
[Cloudflare Observability pricing](https://developers.cloudflare.com/observability/pricing/)).

## Open items

- [ ] Confirm in the dashboard that `webSocketMessage` events of the Room
      Durable Object appear as invocation logs, and whether they name the
      room. If per-frame logs are not wanted, set
      `observability.logs.invocation_logs` to false or lower
      `head_sampling_rate`, and update the comment in `wrangler.jsonc` and
      [the public relay](../public-relay.md#logs).
- [ ] Look at the Worker-side (stateless) entry of a host's
      `GET /api/rooms/:id/ws` to see whether `authorization` is masked there
      too. Only the Durable Object side has been looked at. Update
      [the public relay](../public-relay.md#logs) and `privacy.html` if it is
      not.
- [ ] Decide whether to switch off the automatic Web Analytics insertion for
      piconic.ai in the dashboard, and check in a browser that the beacon is
      blocked by the Content-Security-Policy and that no cookie (such as
      `__cf_bm`) is set on the WebSocket and asset requests. Then update
      [in your browser](../public-relay.md#in-your-browser) and
      `privacy.html`, which so far say this is inferred from the policy.
