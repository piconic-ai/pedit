# Embedding pedit in your app

An app that edits local files can hand the editing to pedit. This page says
what the app gets, how the pieces fit, and where to go next. It is for the
author of the app; the packages' READMEs have the API.

## What the app gets

- **A live document for its pages.** Several pages, or several people, edit
  one file at once, with cursors and names, and every page sees the others'
  edits as they happen.
- **The file stays saved.** pedit writes the file as edits come in, merges a
  save made by another editor, and recovers the document across restarts of
  the app or of itself. The app never writes a sync engine or a save loop.
- **Comments.** People comment on the text; the app can read the threads and
  write comments as the host. Comments never go into the file.
- **People from outside, when wanted.** The app can share the file beyond its
  own pages: through a link on `edit.piconic.ai` or a relay of your own, or
  through a review page on the app's own domain, in its look.

The app keeps owning the file: which files exist, who may open which, and in
what role, are the app's decisions. pedit holds the document and does the
writing.

## How the pieces fit

```text
  browser pages ──WebSocket──▶ your Node app ──@pedit/serve──▶ pedit serve ──▶ the file
                               (Hono routes)                   (one per file)
```

- `pedit serve <file>` is a subcommand of the `pedit` CLI. It holds one file's
  document, writes the file, and listens on a local socket for the app. No
  room, relay or network is involved.
- [`@pedit/serve`](../packages/serve/README.md) is the npm package for the
  app. It starts `pedit serve` for each file an app's page asks for, checks
  every request (which ids exist, which role, which origins), bridges the
  page's WebSocket to pedit, and stops the child a minute after the last page leaves.
  `@pedit/serve/client` gives the page a `Y.Doc` to bind to an editor such as
  CodeMirror.
- To let people from outside in, the app calls `share` on a served file. The
  same `pedit serve` process then also hosts a room on the relay, as
  `pedit <file>` would, and returns the links. Reviewers open them on
  `edit.piconic.ai`, or on [your own review page](review-page.md) built on
  [`@pedit/review`](../packages/review/README.md).

## Requirements

- `pedit` 0.5.0 or later on the PATH, or a path the app passes. The app can
  also [install it for the user](../packages/serve/README.md#installing-pedit-for-the-user)
  when none is found, if it opts in.
- Node 22 or later, on macOS, Linux or Windows.
- `@pedit/serve`, `@pedit/review` and the `pedit` CLI are released together
  and carry the same version number. Keep them on one version and update them
  together. Both packages are experimental (0.x): the API may change in a
  minor release.

## What changes for your users

Inside the app nothing leaves the machine: pages talk to the app, the app to
pedit, pedit to the file. Once the app shares a file, the relay sees
ciphertext, as it does for any pedit room, and whoever holds the link can do
what the link allows. On a review page of your own, the reviewers trust your
page's JavaScript rather than the relay's; see
[security design](security-design.md#on-a-third-party-review-page-you-trust-its-operator).
[What pedit does on your computer](local-files.md#serving-a-file-to-a-local-app-pedit-serve-file-experimental)
lists the files, lock and state `pedit serve` writes.

## Where to go next

1. Run [examples/serve-app](../examples/serve-app/README.md): a Hono server,
   one file, one page, and a share panel.
2. Read the [`@pedit/serve` README](../packages/serve/README.md) for the
   routes, the client, sharing and comments.
3. If reviewers should see your look rather than `edit.piconic.ai`, follow
   [Your own review page](review-page.md), and run `pedit doctor <url>`
   against the deployed page.
4. The design notes: [`pedit serve`](design/serve.md) and
   [embedding](design/embedding.md).
