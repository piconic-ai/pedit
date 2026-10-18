# Self-hosting notes

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fpiconic-ai%2Fpedit%2Ftree%2Fmain%2Fpackages)

The deployment button requires a Cloudflare
account with R2 enabled and a GitHub account. It creates your own repository,
Worker, Durable Object namespace and R2 bucket. Only the `packages/` directory
is copied; the Go CLI is not included. The new repository uses `wrangler.json`
at its root.
The relay is public by default; configure Access to require sign-in.

## Public relay limits

The public relay at `edit.piconic.ai` is shared by everyone who tries pedit,
so it keeps rooms small and turns away networks that ask too much at once:

| | Public relay | Self-hosted default |
| --- | --- | --- |
| Guests in a room, besides the host | 4 | 31 |
| One image | 5 MiB | 10 MiB |
| Images of a session | 50 MiB | 100 MiB, 500 images |
| New rooms from one network | 20 a minute | 20 a minute |
| Connections from one network | 60 a minute | 60 a minute |

A network is one IP address, or for IPv6 one /64, so everyone behind the same
NAT or Wi-Fi counts together. A person never gets near 20 new rooms a minute,
but a class or workshop starting pedit at the same moment on one Wi-Fi can:
the CLI then says to try again in a minute. A guest who finds the room full is
told so in the editor. A client over the connection limit shows the relay as
busy and reconnects on its own after a few seconds.

To go past these limits, self-host the relay and set your own (see
[Room limits](#room-limits)).

## Protect the entire deployment

Set up a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
for your custom hostname. Leave its path empty: pedit needs the browser editor,
`/api/*` and WebSockets protected together. Allow both the people running the
CLI and their collaborators in your Access policy.

pedit relies on Access at Cloudflare's edge; the Worker does not independently
validate Access JWTs. Configure Access before publishing the hostname, and
close alternative public routes. In your repository's `wrangler.json`, add:

```json
"routes": [{ "pattern": "pedit.example.com", "custom_domain": true }],
"workers_dev": false,
"preview_urls": false
```

Remove any other unprotected routes to the same Worker. After deployment,
check that a signed-out browser must sign in and a disallowed identity cannot
reach the editor or API.

## CLI sign-in

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
on the computer running pedit, then:

```sh
# Set server: https://pedit.example.com in .pedit/config.yaml
pedit notes.md
```

pedit detects Access and uses cloudflared to open browser sign-in when needed.
Collaborators only need their browsers. No Cloudflare Tunnel is needed.

The CLI reads its token once at startup and does not refresh it during a
session. If it expires, finish with Ctrl+C, restart pedit and share the new
session link.

## Keeping the server and CLIs in step

Clients and the server check that they speak the same protocol version when
they connect. Patch releases never change it; a minor release may. When it
changes, a CLI older than the server is told to update pedit, and a CLI newer
than the server says the server is older. Update the server when your CLIs
move to a new minor release.

## Updating to room admission

The relay now requires a room admission token on WebSocket and attachment
requests. Update the relay, bundled browser editor, and CLI together. End
existing sessions before deploying, upgrade the CLI on hosts and CLI guests,
and reload browser tabs before starting new sessions. Older clients without
the token are rejected; there is no unauthenticated compatibility fallback.

The share link remains `/r/<room>#<key>`. Clients derive an independent token
with HKDF; the encryption key still never reaches the server. The host
registers the token's hash through its authenticated WebSocket handshake.
The hash survives Durable Object hibernation and is deleted when the last
host leaves. This admission check supplements Cloudflare Access; it does not
replace your identity policy.

Treat `X-Pedit-Admission` and the credential-bearing `Sec-WebSocket-Protocol`
request header as secrets in custom proxy, tracing, and logging configuration.
Do not put the token in URLs or query parameters. HTTP attachment requests
and CLI WebSocket handshakes reject redirects to avoid forwarding credentials.
Configure the CLI with the final service URL. The relay also refuses
browser WebSockets whose `Origin` differs from the URL it is served at, so a
proxy in front of it must keep the `Host` header.

See [room admission protocol](contributing/room-admission.md) for the wire
format and compatibility requirements.

## Attachment cleanup

`pnpm run deploy` applies the rules in `scripts/r2-lifecycle.json` to the bucket
bound as `BLOBS`. They expire encrypted attachments under `rooms/` after one
day as a backstop if deletion on host disconnect fails.

Use a dedicated bucket: deployment replaces its lifecycle configuration.
Keep any additional rules in `scripts/r2-lifecycle.json`; dashboard-only
changes are overwritten on the next deployment.

If applying the cleanup rules fails, deployment reports an error even if the
Worker was already published. Fix the bucket or permission issue and rerun
`pnpm run deploy` to apply the rules.

## Maintenance

To stop your relay for a while, set the Worker variable `MAINTENANCE` (in the
Cloudflare dashboard → your Worker → Settings → Variables and Secrets):
`no-new-rooms` turns away new rooms and keeps open ones going, `closed` turns
away every connection, open rooms included within about 15 seconds. Nothing
reconnects on its own. Delete the variable to end it.
`keep_vars` in `wrangler.json` keeps it across deploys.

## Room limits

A self-hosted relay lets each room take the host and up to 31 guests, images
of up to 10 MiB each and 100 MiB (500 images) per session. To change them, set
these Worker variables (as `vars` in `packages/wrangler.json`, or in the
Cloudflare dashboard → your Worker → Settings → Variables and Secrets):

| Variable | Meaning | Default |
| --- | --- | --- |
| `ROOM_GUESTS` | Guests at once, the host not counted (at most 31) | `31` |
| `BLOB_MAX_BYTES` | One image, in bytes | `10485760` |
| `BLOB_QUOTA_BYTES` | All images of a session, in bytes | `104857600` |
| `BLOB_QUOTA_COUNT` | All images of a session, in number | `500` |
| `ROOM_MAX_SECONDS` | How long a room lasts, in seconds from its host's first connection | *(unset: no limit)* |
| `MEDIA_SOURCES` | Where the Markdown preview may load images and videos from: space-separated Content-Security-Policy sources, such as `https:` for any HTTPS site or `https://images.example.com`. An invalid list is ignored. | *(unset: none; only images pasted in the session)* |
| `FRAME_SOURCES` | Sites, besides the YouTube and Vimeo players, that the Markdown preview may frame: space-separated Content-Security-Policy host sources, such as `https://embed.example.com/player/`. A URL on a line of its own that matches one is shown as a placeholder that, when clicked, loads a sandboxed frame that may run its scripts and open popups (nothing is fetched from the site before the click); plain HTTP only for a source written with `http://`. Every source must name a host (not `https:` or `*`), and none may cover the relay's own origin, which would let the frame read the page. An invalid list is ignored. | *(unset: only YouTube and Vimeo)* |

Whatever the limits, a connection that sends far more than editing needs is
closed: a guest's client reconnects, and a host's disconnect ends the session,
as any host leaving does. A room takes at most four image uploads at once.
Files over about 1 MiB are not supported: the relay passes messages of at most
1 MiB, and a newcomer gets the whole shared document in one. See
[the public relay](public-relay.md#limits) for how canvases and long sessions
count against it.
The public relay at `edit.piconic.ai` sets lower limits in
`packages/worker/wrangler.jsonc`.

New rooms and connections are limited per network by the Workers Rate Limiting
bindings `ROOM_CREATION_LIMIT` and `CONNECTION_LIMIT`, in `ratelimits` in
`packages/wrangler.json`. Change their `limit` (per `period` of 10 or 60
seconds) to raise them, for example for a class that starts pedit together, or
remove a binding to drop that limit. Their `namespace_id` must not be used by
another Worker in the same Cloudflare account. The limits are counted per
Cloudflare location and are approximate.
