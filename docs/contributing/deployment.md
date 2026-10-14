# Releases and deployments

Maintainer operations for the piconic deployments. For your own server, use
the [self-hosting guide](../self-hosting.md).

Production (`edit.piconic.ai`) deploys when a tagpr release PR is merged
(see `.github/workflows/tagpr.yml`): the merge tags the release, the workflow
fast-forwards the `release` branch to the tag, and Cloudflare Workers Builds
deploys `release`. Every other branch gets its own
[Worker Preview](https://developers.cloudflare.com/workers/previews/) on push, at
`https://<branch-name>-edit.<subdomain>.workers.dev`, with its own Durable Object
namespace and its own logs under the Preview's Observability tab (Cloudflare
dashboard → `edit` Worker → Previews). Previews are configured by the `previews`
block in `packages/worker/wrangler.jsonc`.

Maintainer scripts explicitly pass `--config wrangler.jsonc` from `packages/worker`.
Without it, Wrangler's config discovery can select the `packages/wrangler.json`
for self-hosting, which has no Preview configuration.

The server workspace and lockfile live in `packages/`. Root commands forward
to it, so the Workers Builds root directory and commands below stay the same.
The Deploy to Cloudflare button copies only this workspace.

To try a Preview with the CLI:

```sh
# Set server: https://<branch-name>-edit.<subdomain>.workers.dev in .pedit/config.yaml
go run ./cmd/pedit notes.md
```

Workers Builds settings (Cloudflare dashboard → `edit` Worker → Settings → Build).
They live only in the dashboard, not in Git, and are lost when the repository
is disconnected, so keep this table in sync with them:

| Setting | Production | Previews Base |
| --- | --- | --- |
| Git repository | `piconic-ai/pedit` | *(shared)* |
| Branch control | `release` | Builds for Preview branches enabled |
| Build command | *(empty)* | *(empty)* |
| Deploy / Preview command | `pnpm run deploy:production` | `pnpm run preview` |
| Root directory | `/` | `/` |
| Build watch paths | include `*`, exclude *(empty)* | include `*`, exclude *(empty)* |
| Build token | `edit build token` (needs Workers R2 Storage edit, which Cloudflare's generated token has) | *(shared)* |
| Build variables | *(none)* | *(none)* |

> [!WARNING]
> The production deploy command must be `pnpm run deploy:production`, not
> `pnpm run deploy`. `pnpm run deploy` deploys `packages/wrangler.json`, the
> self-hosting configuration. Workers Builds then only warns that the Worker
> name `pedit` does not match and deploys it as `edit` anyway, so production
> keeps serving but loses its own settings: `edit.<subdomain>.workers.dev`
> serves production, branch Previews get no URL, Workers Logs stop, and
> attachments go to the `pedit-blobs` bucket. Workers Builds may also open a
> pull request renaming the Worker in `packages/wrangler.json`; close it, as
> self-hosted deployments rely on that name.

### Zone settings

Settings of the `piconic.ai` zone (Cloudflare dashboard → piconic.ai) also live
only in the dashboard. They apply to every hostname in the zone, not only
`edit.piconic.ai`:

| Setting | Value | Where |
| --- | --- | --- |
| Minimum TLS Version | TLS 1.2 | SSL/TLS → Edge Certificates |

Cloudflare's default lets a client negotiate TLS 1.0 or 1.1. The README's
`curl -fsSL https://edit.piconic.ai/install.sh | sh` relies on the connection
alone, so the floor is set on the server instead of asking everyone to pass
`--tlsv1.2`. GitHub, which serves the release archives, already refuses TLS 1.0
and 1.1. Set on 2026-10-10.

To check, pin curl to one version at a time:

```sh
for v in 1.0 1.1 1.2; do
  echo "tls$v:"
  curl -sS -o /dev/null --tlsv$v --tls-max $v -w '%{http_code}\n' https://edit.piconic.ai/
done
```

Only a `tlsv1 alert protocol version` error proves that Cloudflare refused the
version: that alert comes from the server. `no protocols available` (OpenSSL)
means the local curl refuses to speak it itself and says nothing about the
server, which is the case on current Linux distributions; probe from a client
that still allows the old versions, such as macOS's stock curl, or see
[Cloudflare's note on testing](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/#test-supported-tls-versions).
An accepted version prints `200`. macOS's stock curl (SecureTransport) cannot
speak TLS 1.3, so `--tlsv1.3` failing there says nothing about the server either.

### Maintenance mode

When the public relay has to stop (a traffic spike, abuse the rate limits do
not stop, a serious bug), set the `MAINTENANCE` variable, like a shop that
either turns away new customers or closes:

| `MAINTENANCE` | New rooms | Open rooms and reconnects | Images |
| --- | --- | --- | --- |
| *(unset)* | as usual | as usual | as usual |
| `no-new-rooms` | 503, saying the relay takes no new rooms and pointing to self-hosting | as usual | as usual |
| `closed` | 503, saying the relay is closed for maintenance | closed with `4006` (a reconnect to a room past its 24-hour limit gets `4006` here, and `4007` once maintenance ends; an open room past it is closed with `4007`) | 503 |

Use `no-new-rooms` to stop growth while sessions in progress finish, and
`closed` to stop everything.

To set it: Cloudflare dashboard → `edit` Worker → Settings → Variables and
Secrets → add `MAINTENANCE` as text and deploy. New requests see it within
about 20 seconds; until then some still get the old answer. A deploy that only
changes variables keeps running rooms running, so with `closed` an open room
closes at its next message instead, which every client sends at least every
15 seconds, and its reconnects are turned away. `keep_vars` in
`wrangler.jsonc` keeps the variable across release deploys, so it stays until
someone removes it.

To end it, delete the variable and deploy. Nothing reconnects on its own: a
host whose `pedit` is still running presses Enter to reconnect to the same
room, then guests press Reconnect in the editor. Guests who press it before
their host is back find the session ended.

To stop faster, without a deploy, add a WAF custom rule (Cloudflare dashboard
→ piconic.ai → Security → WAF → Custom rules) with the action Block:

- no new rooms: `http.host eq "edit.piconic.ai" and http.request.method eq "POST" and http.request.uri.path eq "/api/rooms"`
- everything: `http.host eq "edit.piconic.ai" and starts_with(http.request.uri.path, "/api/")`

Blocked requests never reach the Worker and are not billed, but clients only
see a 403: the CLI cannot say why, and browsers keep reconnecting. Disable
the rule to end it.

### Attachment buckets

Pasted images are stored in R2 as ciphertext while their room's host is
connected, and the room deletes them when the host leaves. Each deployment
needs its bucket, with a lifecycle rule that expires anything a failed
deletion leaves behind.

Production's deploy (`pnpm run deploy:production`,
`packages/scripts/deploy-production.mjs`) publishes the Worker, then adds the
`expire-rooms` rule to `edit-blobs` if it is missing, keeping the bucket's
other rules, such as Cloudflare's default multipart-abort rule. If it cannot
check or add the rule, for example because the build token lacks Workers R2
Storage (edit), the build log shows a warning and the deploy still succeeds;
add the rule by hand. Previews and the lab do not run that script. Add the rule
to a new bucket once (`lifecycle add` does not check for an existing rule of
the same name):

```sh
for bucket in edit-blobs edit-blobs-preview edit-lab-blobs; do
  pnpm --dir packages --filter @pedit/worker exec wrangler r2 bucket create "$bucket"
  pnpm --dir packages --filter @pedit/worker exec wrangler r2 bucket lifecycle add "$bucket" expire-rooms rooms/ --expire-days 1
done
```

To check a bucket's rules:
`pnpm --dir packages --filter @pedit/worker exec wrangler r2 bucket lifecycle list edit-blobs`.

`edit-blobs` is production's, `edit-blobs-preview` is shared by every Preview,
and `edit-lab-blobs` is the lab's.

### Lab

`edit-lab.piconic.ai` is a second Worker (`edit-lab`) for experiments that should
not touch production, such as putting the whole host behind Cloudflare Access.
It is defined as the `lab` environment in `packages/worker/wrangler.jsonc`, has
its own Durable Object namespace, and is deployed by hand:

```sh
pnpm run deploy:lab
# Set server: https://edit-lab.piconic.ai in .pedit/config.yaml
go run ./cmd/pedit notes.md
```

Deploying it is also a rehearsal of self-hosting pedit on another Cloudflare account.
