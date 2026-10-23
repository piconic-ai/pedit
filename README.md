# pedit — Pair edit your local files.

[![CI](https://github.com/piconic-ai/pedit/actions/workflows/ci.yml/badge.svg)](https://github.com/piconic-ai/pedit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/piconic-ai/pedit)](https://github.com/piconic-ai/pedit/releases/latest)
[![License: MIT](https://img.shields.io/github/license/piconic-ai/pedit)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/piconic-ai/pedit/badge)](https://scorecard.dev/viewer/?uri=github.com/piconic-ai/pedit)

https://github.com/user-attachments/assets/14bec9ab-8c14-495c-8faf-9cdd98d8fd5b

**What it looks like.** Carol shares a file with `pedit`; Alice and Bob edit
it in their browsers. This is Alice's view:

<table>
  <tr>
    <td><a href="docs/assets/screenshots/markdown.png"><picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/markdown-dark.png">
      <img src="docs/assets/screenshots/markdown.png" width="240" alt="The Markdown editor: the source on the left with Bob's cursor and selection, the rendered preview on the right">
    </picture></a></td>
    <td><a href="docs/assets/screenshots/csv.png"><picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/csv-dark.png">
      <img src="docs/assets/screenshots/csv.png" width="240" alt="A CSV file as a table, with Alice's selected cell and Bob's selected cell outlined in their colors">
    </picture></a></td>
    <td><a href="docs/assets/screenshots/canvas.png"><picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/canvas-dark.png">
      <img src="docs/assets/screenshots/canvas.png" width="240" alt="A canvas file as a board of nodes, edges and a group, with the node Bob has selected outlined">
    </picture></a></td>
  </tr>
  <tr>
    <td>Markdown, with a live preview and Bob's cursor</td>
    <td>CSV as a table, with Bob's selected cell</td>
    <td>Canvas as a board, with Bob's selected node</td>
  </tr>
</table>

`pedit` is a CLI that lets people edit your local files together in their
browsers. Edits are saved back to your file:

```text
❯ pedit notes.md

  notes.md is ready to write together.

  Send this link to the people you want to invite:
    https://edit.piconic.ai/r/<room-id>#<key>

  Press Ctrl+C when you are done. Everything is saved to notes.md.

  ● Alice and Bob are here
```

No install or account needed for collaborators on the public server.

Collaborators who would rather stay in their own editor join from the command
line instead. Given the link, `pedit` mirrors the shared file to a temporary
copy and keeps it in sync both ways until they leave or the host closes the
room; the copy is removed then, like closing a browser tab. `pedit` names the
copy itself, from a number and the letters and digits of the host's name for
it, never as the room names it:

```text
❯ pedit 'https://edit.piconic.ai/r/<room-id>#<key>'

  Joined. Your copy of the shared file:
    /tmp/pedit-<room-id>-2271/00-notes.md
    Copied to your clipboard.

  Edit it with any editor; changes sync both ways while you are in the room.
  Press Ctrl+C to leave. The copies are temporary and removed then.
```

Quote the link in the shell: `#` starts a comment otherwise. Copy out what you
want to keep before you leave. Canvas rooms can only be joined in a browser
for now.

### Several files in one room

Name several files to share them in one room, under one link. Guests switch
between them with the tabs above the editor:

```text
❯ pedit agenda.md docs/spec.md board.canvas
```

While sharing, type the path of another file and press Enter to add it to the
room, without a new link: a meeting can start with the agenda and bring in the
spec when it comes up. Only the host adds files; nobody in the room can ask for
one. A room shares up to 20 files, each a regular UTF-8 file, as when sharing
one. Paths are shown relative to the directory `pedit` runs in.

A guest who joins from the command line gets a copy of each text file in the
same temporary directory, including files the host adds later, named after
the host's path: `docs/spec.md` is copied to `01-docs-spec.md`. Canvases are
for the browser.

### Comments

In the browser, select some text, a cell of a table (or a whole row or
column), or a node of a canvas, and write a comment in the panel beside it.
Everyone in the room sees it at once, marked where it points, and can reply
or resolve it; resolved threads stay under Resolved, to read again or reopen.
You can edit or delete your own comments from their ⋮ menu (deleting asks
first). Each file's tab (or its name, in a room of one file) shows how
many of its comments are still open, and the speech bubble in the header,
or Ctrl/⌘+Alt+M, shows or hides the comments. A comment never goes into the file: the host keeps the
comments of each file in `.pedit/meta/<path>.json`, and the next session
shows them again, found by the text, cells or node they pointed at. A
comment follows its place as people edit, and says so when that text changed
or is gone. A comment goes on up to 1,000 characters of text, or of a cell.

Comments are kept for files inside the project: the directory of
`.pedit/config.yaml`, or the one you run pedit in when there is none. Commit
`.pedit/meta/` to keep them with the files. A guest on the command line, or
an older pedit, does not see them. See
[the design](docs/design/comments.md) for how they are anchored and checked.

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

macOS / Linux:

```sh
curl -fsSL https://edit.piconic.ai/install.sh | sh
```

`install.sh` is served by the relay. To install from GitHub instead, use one
of the methods below.

Homebrew (macOS / Linux):

```sh
brew install piconic-ai/tap/pedit
```

mise:

```sh
mise use -g github:piconic-ai/pedit
```

Go 1.25+:

```sh
go install github.com/piconic-ai/pedit/cmd/pedit@latest
```

Binaries: [GitHub Releases](https://github.com/piconic-ai/pedit/releases) (macOS / Linux / Windows · amd64 / arm64).
Each archive carries a build provenance attestation; check that it was built
by this repository's release workflow with

```sh
gh attestation verify <archive> --repo piconic-ai/pedit \
  --signer-workflow piconic-ai/pedit/.github/workflows/release-build.yml
```

(releases up to v0.1.2 were signed by `tagpr.yml` instead). Releases after
v0.1.5 also carry the attestation as a file, `pedit_<version>.sigstore.json`,
for `gh attestation verify <archive> --bundle <file> ...`. The archives are
reproducible: GoReleaser v2.18.3 (`goreleaser release --clean --skip=publish`
with `.goreleaser.yaml`) run on the same tag with the Go version from `go.mod`
on `ubuntu-24.04` gives the same `checksums.txt`. Releases made before the
switch to GoReleaser were built by `scripts/build-cli-release.sh`; their tags
still carry it, so rebuild those with that script instead.

## Configuration and templates

Run `pedit` at a Git repository root to create `.pedit/config.yaml` and
`.pedit/templates/` with editable Markdown, CSV, and Canvas defaults.

```yaml
server: https://edit.piconic.ai
output: notes
```

Add your own template files directly to `.pedit/templates/`:

```sh
pedit                          # notes/pedit-<time>.md
pedit --csv                    # notes/pedit-<time>.csv
pedit --canvas                 # notes/pedit-<time>.canvas
pedit -t minutes.md             # notes/minutes-<time>.md
pedit -t minutes.md -d meetings # meetings/minutes-<time>.md
```

`.canvas` files use [JSON Canvas](https://jsoncanvas.org/), an open format for
whiteboard-style diagrams.

`-t` / `--template` selects a template; `-t csv` and `-t canvas` select
`default.csv` and `default.canvas`. `-d` / `--directory` overrides `output`.
New files get a timestamp and a counter if needed. Existing files are preserved.

Configuration is found from the current directory up to the Git root.
`output` is relative to the project; `-d` is relative to the current directory.
Without configuration, the public server and built-in defaults work immediately.
Set `server` in the config instead of `PEDIT_SERVER`.

## Privacy and security

In a browser, the editor's code comes from the relay, so you trust whoever
runs it and Cloudflare, which hosts it: a modified editor could read the key
and plaintext. The command line runs no code from the relay: guests can join
with `pedit '<link>'` instead of a browser, using a pedit installed from
Homebrew, `go install` or a release archive you verify, not from `install.sh`,
which the relay serves. Or [self-host](#self-host) the relay and editor. See
[security design](docs/security-design.md) for the encryption and what it does
not protect against, and [the public relay](docs/public-relay.md) for what
`edit.piconic.ai` logs and keeps.

![The browser encrypts Text. Cloudflare relays Encrypted Text to pedit CLI, which decrypts it and saves Text to local notes.md. The URL path identifies the room; its fragment contains the shared key, which is never sent to the server.](docs/assets/encryption-sequence.svg)

This is a simplified illustration: pedit encrypts document updates rather than
raw text. The relay sees the room ID and encrypted bytes, but not the key.
Edits in the opposite direction follow the same process.

- **End-to-end encryption.** Document updates and pasted images are encrypted
  on your devices. The relay receives ciphertext; the key stays in the link's
  `#fragment` and is never sent to the server.
- **Local files, temporary sessions.** The relay does not store document text,
  and attempts to delete encrypted images when the host leaves
  ([what the public relay keeps](docs/public-relay.md#what-it-keeps)).
- **Private local copies.** On Unix, new CLI join copies and saved attachments
  use owner-only permissions, further restricted by your umask. Updates retain
  an existing document's permissions; existing files are not retroactively made private.
- **Comments are encrypted too.** They travel as updates of a document of
  their own, end to end like edits, and only the host saves them, in
  `.pedit/meta/`; commit that only if you want them in the repository. The
  editor lets you change or delete only your own comments, but anyone with
  the link could change or delete any comment.
- **The link grants editing access.** Anyone with the full link can read and
  edit during the session. Share it only with people you trust. Closing a
  session does not erase copies participants have made.
- **Room IDs alone do not grant access.** Clients derive a separate admission
  token from the fragment key. The relay checks this token before accepting
  connections or attachment requests; the token cannot decrypt content.
- **Your relay, your access rules.** Use the public relay at `edit.piconic.ai`,
  or [self-host](#self-host) to require sign-in with Cloudflare Access.
- **Only the files you share.** The CLI reads and writes the files you name,
  images in `assets/` beside each, its own `.pedit/` configuration and a cache, and runs
  only a clipboard tool and, for Access, `cloudflared`. See
  [what pedit does on your computer](docs/local-files.md) for every file and
  what you accept.

You must also trust participant devices and browsers. Infrastructure can see
IP addresses, room IDs, request timing and ciphertext sizes; infrastructure and
Access logs have separate retention settings and are not erased when a room
closes.

Markdown previews can embed YouTube, Vimeo, Loom, Figma, CodePen, StackBlitz,
Observable, Spotify, SoundCloud and Miro players and public source files on
GitHub, and show external images and videos where the relay allows them (the
public relay does not). An embed loads only when someone clicks "Load from" on
it, or ticked "Always load" for its provider, so nobody in the room contacts a
third party just because a URL was written in the file. See
[embeds](docs/embeds.md) for the list, sizes such as
`https://youtu.be/dQw4w9WgXcQ#width=560&height=315`, GitHub line ranges, privacy,
and how a self-hosted relay adds or drops providers. With Access,
avatars may load from an identity provider or Gravatar using an email hash.
Those providers can see the requests.

Besides the relay, the CLI itself connects only to `api.github.com`, to check
for a newer release, and keeps the answer for a day; it never downloads or
installs one.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Self-host

The public relay at `edit.piconic.ai` is shared, so it has limits:

| | Public relay |
| --- | --- |
| People in a room | The host and 4 guests |
| Images | 5 MiB each, 50 MiB per session |
| New rooms | 20 a minute from one network |
| Connections | 60 a minute from one network |
| Session length | 24 hours |
| File size | About 1 MiB, on any relay ([details](docs/public-relay.md#limits)) |

Self-host when you need more, or when you want to limit who can join editing
sessions. Cloudflare Access lets you allow specific email addresses or identity
provider groups; participants need both an allowed identity and the session
link.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fpiconic-ai%2Fpedit%2Ftree%2Fmain%2Fpackages)

The button copies only the server workspace (`packages/`), without the Go CLI.
Deploy the relay and browser editor to your Cloudflare account, then:

```sh
# Set server: https://<worker>.<subdomain>.workers.dev in .pedit/config.yaml
pedit notes.md
```

See [self-hosting notes](docs/self-hosting.md) for requirements and Access setup.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and pull requests.
