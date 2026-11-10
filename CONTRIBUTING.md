# Contributing to pedit

Bug reports, documentation improvements and pull requests are welcome.
[Open an issue](https://github.com/piconic-ai/pedit/issues) with steps to reproduce,
your OS, pedit version and expected behavior. Remove room links, keys, Access
tokens and private document content from reports.
Report security vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.

For a substantial change, open an issue to discuss the approach first. Keep pull
requests focused, describe the resulting behavior and include how you verified it.
Add regression tests for behavior changes and run the checks below before submitting.

## Development

Requires Go 1.26+, Node.js 22+ and pnpm 10.7.1 (see `go.mod` and `package.json`).

The CLI is written in Go; the server and the browser editor in TypeScript.
`packages/` is a standalone pnpm workspace for the relay and browser editor.
Root scripts forward to it; `pnpm install` installs its locked dependencies.
For filtered commands, use `pnpm --dir packages --filter <package> ...`.

```sh
pnpm install --frozen-lockfile
pnpm test        # TypeScript packages
pnpm typecheck
pnpm lint
pnpm test:deploy # self-host deployment orchestration
PEDIT_INTEROP=1 go test -race ./...    # the CLI; its interop test drives the web client's RoomClient with Node.js
go vet ./...
cccc .           # cognitive complexity per function; cccc.toml sets the limit CI enforces
scripts/check-links.sh  # links between the Markdown files and their #fragments (needs lychee)
```

After changing how the Markdown preview renders (`packages/web/src/preview.ts`,
`blockrender.ts`, `blockparse.ts` or `pane.ts`), run its benchmark too. Plain
`pnpm test` skips it; the `Bench` workflow runs it weekly and on pull requests
that touch those files, and fails when a keystroke does more work than it should:

```sh
cd packages/web && PERF=1 npx vitest run test/perf/preview.bench.test.ts
```

[cccc](https://github.com/moznion/cccc) comes with `mise install` (`mise.toml`)
or from its releases. When a function goes over the limit, split it into
steps with names rather than raising the limit.

Run everything locally:

```sh
pnpm --dir packages --filter @pedit/worker dev                  # builds the web editor, serves on http://localhost:8787
printf '# Notes\n' > /tmp/pedit-dev-notes.md
# Set server: http://localhost:8787 in .pedit/config.yaml
go run ./cmd/pedit /tmp/pedit-dev-notes.md
```

| Path | What it is |
| --- | --- |
| `cmd/pedit`, `internal/` | The `pedit` command (Go). `internal/protocol` mirrors `packages/protocol` on top of [ygo](https://github.com/reearth/ygo) |
| `packages/` | Standalone server workspace, self-host config and deployment scripts |
| `packages/protocol` | Encryption, message framing and the Yjs room client used by the web editor |
| `packages/worker` | Hono Worker + `Room` Durable Object (WebSocket Hibernation API); also serves the web editor |
| `packages/web` | CodeMirror 6 editor for collaborators; UI components in BarefootJS |

The wire format (frames, signatures, message types, close codes) is shared by
both implementations: change them together, and keep the test vectors in
`packages/testdata/` passing on both sides. It is written down in
[the wire protocol](docs/contributing/protocol.md); how clients are admitted
to a room in [room admission](docs/contributing/room-admission.md).

Before opening a pull request, also run `pnpm build` and check Go formatting with
`gofmt -l cmd internal` (it should print nothing). The interop tests require the
installed TypeScript dependencies; `PEDIT_INTEROP=1` prevents silently skipping them.

Keep encryption keys in the URL fragment and keep document content on clients.
See [privacy and security](README.md#how-it-stays-private) for the trust model and
[deployment](docs/contributing/deployment.md) for releases, previews and the lab Worker.

See [Homebrew releases](docs/contributing/homebrew.md) for tap updates and token setup.
