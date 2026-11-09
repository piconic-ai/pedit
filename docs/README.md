# pedit documentation

The [README](../README.md) says what pedit is. These pages say how to use it,
run it and build on it. Pick the reader you are.

## Using pedit

- [Getting started](getting-started.md): install, share a file, join one,
  several files in a room, links that can only comment or read.
- [Comments](comments.md): comments in the browser, where they are saved,
  and how scripts and agents take part.
- [Sessions](sessions.md): what happens when a connection drops, when files
  are saved, and rooms that stay open after you leave.
- [Configuration and templates](configuration.md): `.pedit/config.yaml`,
  templates, notes from a blank page.
- [Embeds in the preview](embeds.md): players and source files that a
  Markdown preview can show, and what that means for privacy.

## Privacy and security

- [Security design](security-design.md): the keys, what the relay sees and
  can do, and what pedit does not protect against.
- [The public relay](public-relay.md): who runs `edit.piconic.ai`, what it
  keeps and logs, its limits, and how to report abuse.
- [What pedit does on your computer](local-files.md): every file it reads or
  writes, every program it runs, every host it talks to.
- [Verifying releases](verifying-releases.md): checking an archive, and what
  the install scripts and `pedit self-update` check.
- Security records: the [October 5 review](security/2026-10-05-audit.md) and
  the [October 12 local file access audit](security/2026-10-12-local-files.md).
- [Reporting a vulnerability](../SECURITY.md).

## Hosting a relay

- [Self-hosting](self-hosting.md): deploy to Cloudflare, protect it with
  Access, set limits, maintain it.
- [The relay and browser editor workspace](../packages/README.md): what the
  deploy button copies.

## Building pedit into an app

- [Embedding](embed.md): what an app gets, how the pieces fit, where to start.
- [`@pedit/serve`](../packages/serve/README.md): the package that runs
  `pedit serve` for a Node app and connects its pages.
- [Your own review page](review-page.md): sharing a file from the app with
  people outside, on a page of your own domain.
- [`@pedit/review`](../packages/review/README.md): the `<pedit-review>`
  element that page uses.
- Samples: [examples/serve-app](../examples/serve-app/README.md) and
  [examples/review-page](../examples/review-page/README.md).

## Design notes

Why each feature works the way it does. Written while building; they say
"this design" rather than "how to".

- [Comments](design/comments.md) and [comments from the command
  line](design/comments-cli.md)
- [Rooms that stay open while the host is away](design/rooms-away.md) and
  [comments in kept rooms](design/kept-comments.md)
- [Canvas while away](design/async-canvas.md), and the
  [removed polling mode](design/async.md) (history)
- [`pedit serve`](design/serve.md) and [embedding](design/embedding.md)

## Contributing

- [CONTRIBUTING.md](../CONTRIBUTING.md): development setup and checks.
- [Deployment](contributing/deployment.md): releases, previews and the lab
  Worker.
- [Homebrew releases](contributing/homebrew.md).
- [Wire protocol](contributing/protocol.md): frames, signatures, message
  types, versions and close codes, shared by the Go and TypeScript sides.
- [Room admission protocol](contributing/room-admission.md).
- [Relay logs](contributing/relay-logs.md): what the public relay's logs
  were seen to hold, and the checks still open.
