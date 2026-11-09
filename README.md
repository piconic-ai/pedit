# pedit — Pair edit your local files.

[![CI](https://github.com/piconic-ai/pedit/actions/workflows/ci.yml/badge.svg)](https://github.com/piconic-ai/pedit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/piconic-ai/pedit)](https://github.com/piconic-ai/pedit/releases/latest)
[![License: MIT](https://img.shields.io/github/license/piconic-ai/pedit)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/piconic-ai/pedit/badge)](https://scorecard.dev/viewer/?uri=github.com/piconic-ai/pedit)

https://github.com/user-attachments/assets/14bec9ab-8c14-495c-8faf-9cdd98d8fd5b

Run `pedit` on a file and send the link. Others edit it in their browsers,
and every edit is saved back to your file as it comes in.

```text
❯ pedit notes.md

  notes.md is ready to write together.

  Send this link to the people you want to invite:
    https://edit.piconic.ai/r/<room-id>#<key>

  Press Ctrl+C when you are done. Everything is saved to notes.md.

  ● Alice and Bob are here
```

- **Your file, right now.** No account for anyone, nothing for the others to
  install. The edits land in the local file you named, ready for your editor,
  your agent or your next commit.
- **Nobody in the middle can read it.** Updates are encrypted end to end with
  a key that lives in the link and never reaches the server. The relay passes
  ciphertext along; what it holds for a room that stays open is encrypted, and
  none of it is needed once you have taken the edits in.
- **Comments, not just edits.** People comment on text, cells and canvas
  nodes; comments stay out of the file. Hand out links that can only comment
  or only read, and let scripts and agents answer from the command line.
- **Markdown, CSV and Canvas.** A live preview, a table, or a board of nodes
  and edges in the browser; from the command line, the same files as text in
  an editor of your own.
- **Build it into your own app.** A local app that works on files can get
  live editing and several people in one document by running pedit beside
  it, and comments once it shares the file, instead of writing a sync engine
  of its own. The app keeps owning the file; pedit keeps it saved.

<table>
  <tr>
    <td><a href="docs/assets/screenshots/markdown.png"><picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/markdown-dark.png">
      <img src="docs/assets/screenshots/markdown.png" width="320" alt="The Markdown editor: the source on the left with Bob's cursor and selection, the rendered preview on the right">
    </picture></a></td>
    <td><a href="docs/assets/screenshots/csv.png"><picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/csv-dark.png">
      <img src="docs/assets/screenshots/csv.png" width="320" alt="A CSV file as a table, with Alice's selected cell and Bob's selected cell outlined in their colors">
    </picture></a></td>
  </tr>
  <tr>
    <td>Markdown, with a live preview and Bob's cursor</td>
    <td>CSV as a table, with Bob's selected cell</td>
  </tr>
  <tr>
    <td><a href="docs/assets/screenshots/canvas.png"><picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/canvas-dark.png">
      <img src="docs/assets/screenshots/canvas.png" width="320" alt="A canvas file as a board of nodes, edges and a group, with the node Bob has selected outlined">
    </picture></a></td>
    <td><a href="docs/assets/screenshots/comments.png"><picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/comments-dark.png">
      <img src="docs/assets/screenshots/comments.png" width="320" alt="Bob's view from a comment-only link: the header says Comment only, and the comments panel shows Alice's comment on a highlighted line with Bob's reply">
    </picture></a></td>
  </tr>
  <tr>
    <td>Canvas as a board, with Bob's selected node</td>
    <td>Comments, seen from a comment-only link</td>
  </tr>
</table>

## Why pedit?

Local files work naturally with coding agents and your own editor. Keeping
documents in Git makes changes reviewable and preserves their history, but
asking someone to clone a repository and open a pull request adds friction
to a quick editing session.

pedit lets you invite people into the file with a link and edit together in
their browsers. They do not need to set up your development environment.
The edits land in the same local file, ready for your next agent task,
review or commit.

## Install

```sh
curl -fsSL https://edit.piconic.ai/install.sh | sh
pedit notes.md    # or any text file you have; `pedit` alone starts a new note
```

Send the printed link and watch the file change. Press Ctrl+C when you are
done. Other ways to install, and what to do next, are in
[Getting started](docs/getting-started.md).

## How it stays private

![The browser encrypts Text. Cloudflare relays Encrypted Text to pedit CLI, which decrypts it and saves Text to local notes.md. The URL path identifies the room; its fragment contains the shared key, which is never sent to the server.](docs/assets/encryption-sequence.svg)

The relay sees the room ID and encrypted bytes, never the key or the text.
Anyone with the link can do what the link allows, so send it as you would
send the file. In a browser you run the editor the relay serves, so you trust
its operator. To run no code from the relay, join from the command line with
a pedit from Homebrew, `go install` or a verified release archive (the
install scripts come from the relay too), or self-host.
[Security design](docs/security-design.md) has the details and
what pedit does not protect against; [the public relay](docs/public-relay.md)
says what `edit.piconic.ai` logs and keeps; [what pedit does on your
computer](docs/local-files.md) lists every file it touches. To report a
vulnerability, see [SECURITY.md](SECURITY.md).

## Build it into your own app

An app that edits local files, a CMS, a notes tool, an agent's workbench, can
hand the editing to pedit. Its pages get a live document that several people
edit at once, with cursors, and the file on disk stays saved by pedit, so the
app never writes a sync engine or a save loop of its own.

`pedit serve` runs beside the app and holds the document; the `@pedit/serve`
package connects it to the app's pages. When the app wants people from
outside, it shares the same document through a link, or through a review
page on the app's own domain, and gets comments with it. `@pedit/serve` and
`@pedit/review` are experimental (0.x) and released with each pedit version.
Start with [Embedding](docs/embed.md).

## Self-host

The public relay is shared, so rooms are small: the host and 4 guests, files
under about 1 MiB. Deploy your own to raise the limits, or to put it behind
Cloudflare Access so only people you allow can join.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fpiconic-ai%2Fpedit%2Ftree%2Fmain%2Fpackages)

Then set `server` in [`.pedit/config.yaml`](docs/configuration.md) to your
Worker's URL. [Self-hosting](docs/self-hosting.md) covers Access, limits and
maintenance.

## Documentation

[docs/](docs/README.md) is the index: guides for using pedit, hosting a relay
and embedding it in an app, the design notes behind each feature, and the
security records.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and pull
requests. MIT license.
