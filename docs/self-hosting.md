# Self-hosting the relay

This page is for someone who wants to run the relay and browser editor
themselves: for more people in a room or bigger images than the public relay
allows, for a relay that only people they choose can reach, or on a domain of
their own. The CLI stays the same; one line in `.pedit/config.yaml` points it
at your server. What the relay is and what it can see is in
[security design](security-design.md).

## Why self-host

The public relay at `edit.piconic.ai` is shared by everyone who tries pedit,
so it keeps rooms small and turns away networks that ask too much at once.
Your own relay starts with wider defaults, and you set the limits yourself:

| | Public relay | Self-hosted default |
| --- | --- | --- |
| Guests in a room, besides the host | 4 | 31 |
| One image | 5 MiB | 10 MiB |
| Images of a session | 50 MiB | 100 MiB, 500 images |
| One host session | 24 hours | none of its own; the room still ends 7 days after it opened |
| New rooms from one network | 20 a minute | 20 a minute |
| Connections from one network | 60 a minute | 60 a minute |

A network is one IP address, or for IPv6 one /64, so everyone behind the same
NAT or Wi-Fi counts together. A person never gets near 20 new rooms a minute,
but a class or workshop starting pedit at the same moment on one Wi-Fi can:
the CLI then says to try again in a minute. A guest who finds the room full
is told so in the editor. A client over the connection limit shows the relay
as busy and reconnects on its own after a few seconds. [Room limits](#room-limits) says
how to change each value; the public relay's full list is in
[the public relay](public-relay.md#limits).

A relay of your own can also sit behind Cloudflare Access, so that only
people you allow reach it ([protect it](#protect-it-with-access)), and its
request logs are yours to keep or to turn off.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fpiconic-ai%2Fpedit%2Ftree%2Fmain%2Fpackages)

The button needs a Cloudflare account with R2 enabled and a GitHub account.
It makes a repository of your own from this repository's `packages/`
directory (the Go CLI is not included), and a Worker, a Durable Object
namespace and an R2 bucket for it. The new repository has `wrangler.json` at
its root; the paths on this page are in that repository. The relay is public
until you set up Access.

The button also connects the repository to Workers Builds, which deploys on
each push. Check in its build settings that the deploy command is
`pnpm run deploy`: that publishes the Worker and applies the image cleanup
rules ([attachment cleanup](#attachment-cleanup)); a plain `wrangler deploy`
does not apply them. `pnpm run deploy` by hand in the repository does the
same.

## Point the CLI at it

In a project, name the server in `.pedit/config.yaml`
([configuration](configuration.md)):

```yaml
server: https://pedit.example.com
```

Guests need nothing: the link carries the server.

## Protect it with Access

Set up a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
for your custom hostname. Leave its path empty: pedit needs the browser editor,
`/api/*` and WebSockets protected together. Allow both the people running the
CLI and their collaborators in your Access policy.

pedit relies on Access at Cloudflare's edge; the Worker does not independently
validate Access JWTs. Configure Access before publishing the hostname, and
close alternative public routes. In `wrangler.json`, add:

```json
"routes": [{ "pattern": "pedit.example.com", "custom_domain": true }],
"workers_dev": false,
"preview_urls": false
```

Remove any other unprotected routes to the same Worker. After deployment,
check that a signed-out browser must sign in and a disallowed identity cannot
reach the editor or API. Access keeps its own logs, with their own retention,
which are not erased when a room closes.

### CLI sign-in

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
on the computer running pedit, then run pedit as usual. It detects Access and
uses cloudflared to open browser sign-in when needed. Collaborators only need
their browsers. No Cloudflare Tunnel is needed.

A browser behind Access goes by the name of the account it signed in with.
Someone who works with an agent on one account can pick another name in the
settings; the others then see the account beside it, such as
"tate-pm (signed in as Ada Lovelace)". The browser says this itself, so it is
a label and not proof of who is there (see
[the security design](security-design.md)).

The CLI reads its token once at startup and does not refresh it during a
session. If it expires, finish with Ctrl+C, restart pedit and share the new
session link.

## Room limits

A self-hosted relay lets each room take the host and up to 31 guests, images
of up to 10 MiB each and 100 MiB (500 images) per session. To change them, set
these Worker variables (as `vars` in `wrangler.json`, or in the Cloudflare
dashboard → your Worker → Settings → Variables and Secrets):

| Variable | Meaning | Default |
| --- | --- | --- |
| `ROOM_GUESTS` | Guests with an edit link at once, the host not counted (at most 31) | `31` |
| `ROOM_READERS` | Guests with a comment-only or read-only link at once, apart from the others (at most 31) | `ROOM_GUESTS` |
| `BLOB_MAX_BYTES` | One image, in bytes | `10485760` |
| `BLOB_QUOTA_BYTES` | All images of a session, in bytes | `104857600` |
| `BLOB_QUOTA_COUNT` | All images of a session, in number | `500` |
| `ROOM_MAX_SECONDS` | How long one host session lasts, in seconds from its host's first connection or its return to a kept room | *(unset: no limit)* |
| `ROOM_LIFE_SECONDS` | How long a room lasts in all, in seconds from its host's first connection, however often the host comes back; a keep never reaches past it | `604800` (seven days) |
| `KEEP_MAX_SECONDS` | The longest a host may ask to have a room kept after it leaves (`pedit --keep`); a longer request is cut to it. Counted from the host's departure, and never past `ROOM_LIFE_SECONDS` | `604800` (seven days) |
| `HOST_GRACE_SECONDS` | How long a room waits for a host whose connection dropped before it closes; meanwhile guests stay and can read but not edit | `120` |
| `MEDIA_SOURCES` | Where the Markdown preview may load images and videos from: space-separated Content-Security-Policy sources, such as `https:` for any HTTPS site or `https://images.example.com`. An invalid list is ignored. | *(unset: none; only images pasted in the session)* |

Whatever the limits, a connection that sends far more than editing needs is
closed: a guest's client reconnects, and so does a host's, within the
`HOST_GRACE_SECONDS` a room waits for it. A room takes at most four image
uploads at once. Files over about 1 MiB are not supported: the relay passes
messages of at most 1 MiB, and a newcomer gets the whole shared document in
one. See [the public relay](public-relay.md#limits) for how canvases and long
sessions count against it. The public relay sets its lower limits in
`packages/worker/wrangler.jsonc` of this repository.

New rooms and connections are limited per network by the Workers Rate Limiting
bindings `ROOM_CREATION_LIMIT` and `CONNECTION_LIMIT`, in `ratelimits` in
`wrangler.json`. Change their `limit` (per `period` of 10 or 60 seconds) to
raise them, for example for a class that starts pedit together, or remove a
binding to drop that limit. Their `namespace_id` must not be used by another
Worker in the same Cloudflare account. The limits are counted per Cloudflare
location and are approximate. The public relay also limits requests about
kept rooms (`KEEP_REQUEST_LIMIT`, 1,200 a minute from one network); the
template has no such binding, so those requests are unlimited unless you add
one with that name.

## Keeping the server and CLIs in step

Clients and the server check that they speak the same protocol version when
they connect. Patch releases never change it; a minor release may. When it
changes, a CLI older than the server is told to update pedit, and a CLI newer
than the server says the server is older. Update the server when your CLIs
move to a new minor release. The CLI offers versions 8 and 7
(`internal/protocol/admission.go` in this repository), so it still works with
a server one version behind; a server older than that refuses it.

## Attachment cleanup

`pnpm run deploy` applies the rules in `scripts/r2-lifecycle.json` to the bucket
bound as `BLOBS`. They expire encrypted attachments under `rooms/` after one
day, and those of kept rooms under `kept/` after eight days, as a backstop if
deletion when the room ends fails. Eight days is a day more than the default
`ROOM_LIFE_SECONDS`; if you raise that variable, raise the `kept/` rule's
`maxAge` with it, or a room still open could lose its images.

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

## Room admission

Besides the link, every WebSocket and image request carries an admission
token that clients derive from the link's secrets; the encryption key still
never reaches the relay. The relay checks the token before a connection takes
a place in the room, so knowing a room's ID is not enough to fill it
([room admission protocol](contributing/room-admission.md)). This check
supplements Access; it does not replace your identity policy.

If you put a proxy, tracing or logging in front of the relay, treat the
`X-Pedit-Admission`, `X-Pedit-Read-Admission` and `Sec-WebSocket-Protocol`
request headers as secrets, and never put the token in a URL or query
parameter. Image requests and CLI WebSocket handshakes refuse redirects, so
configure the CLI with the final URL. The relay refuses a browser WebSocket
whose `Origin` differs from the URL it is served at, unless the room's host
let that origin in (a page of an app's own, [review page](review-page.md)), so
a proxy must keep the `Host` header. Workers Logs, if you turn them on (`observability` in
`wrangler.json`), keep request headers, these included; what the public
relay's logs hold is in [relay logs](contributing/relay-logs.md).

## Embed providers

The relay is built with its embed providers: one file each in
`protocol/src/embeds/`, listed in `protocol/src/embeds/index.ts`. To drop, add
or change one, edit those files and deploy. See
[embeds](embeds.md#customizing-the-providers) for the providers that ship, how
to write one, and the rules the relay checks.
