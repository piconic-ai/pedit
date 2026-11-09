# Getting started

Install pedit, share a file, and learn the handful of things a room can do.
This page is for the person who runs `pedit`; the people you invite need only
a browser.

- [Install](#install)
- [Share a file](#share-a-file)
- [Leave and come back](#leave-and-come-back)
- [Several files in one room](#several-files-in-one-room)
- [Links that can only comment or read](#links-that-can-only-comment-or-read)
- [Join from the command line](#join-from-the-command-line)
- [Next](#next)

## Install

macOS / Linux:

```sh
curl -fsSL https://edit.piconic.ai/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://edit.piconic.ai/install.ps1 | iex
```

`install.ps1` adds the install directory to your user PATH; set
`PEDIT_NO_MODIFY_PATH=1` to skip that.

To update a pedit installed this way, run `pedit self-update`; it checks the
release as the install scripts do before replacing anything.

`install.sh` and `install.ps1` are served by the relay. To install from
GitHub instead, use one of the methods below.

Homebrew (macOS / Linux):

```sh
brew install piconic-ai/tap/pedit
```

mise:

```sh
mise use -g github:piconic-ai/pedit
```

Go 1.26+:

```sh
go install github.com/piconic-ai/pedit/cmd/pedit@latest
```

Binaries: [GitHub Releases](https://github.com/piconic-ai/pedit/releases)
(macOS / Linux / Windows · amd64 / arm64). Every archive carries a build
provenance attestation, which the install scripts check when the GitHub CLI
is installed; see [verifying releases](verifying-releases.md) to check one
yourself.

## Share a file

Run `pedit <file>` and send the printed link:

```text
❯ pedit notes.md

  notes.md is ready to write together.

  Send this link to the people you want to invite:
    https://edit.piconic.ai/r/<room-id>#<key>

  Press Ctrl+C when you are done. Everything is saved to notes.md.
  To share another file in this room, type its path and press Enter.
  Press Ctrl+L for links that can only comment or read.

  ● Alice and Bob are here
```

Edits are saved to your file as they come in. If the connection drops, keep
`pedit` running: it reconnects with the same link and merges what was written
meanwhile. Ctrl+C saves and leaves.

The file must be a regular UTF-8 text file. A `.csv` opens as a table in the
browser and a `.canvas` ([JSON Canvas](https://jsoncanvas.org/)) as a board;
anything else is edited as text, with a live preview for Markdown.

## Leave and come back

A room opened from existing files is kept for a day after you leave: the link
keeps working, and what guests write while you are away waits on the relay,
encrypted. Run `pedit notes.md` again (or `pedit resume`) to take their edits
in and carry on, `pedit rooms` to list kept rooms, and `pedit close` to end
one for good. (Kept rooms are not available on Windows yet: there a room ends
when you leave.) `--keep 7d`
keeps it longer (7 days at most on the public relay); `--keep 0` opens a room
that ends when you leave. See [sessions](sessions.md) for how reconnecting,
saving and kept rooms work.

## Several files in one room

Name several files to share them in one room, under one link. Guests switch
between them with the tabs above the editor:

```text
❯ pedit agenda.md docs/spec.md board.canvas
```

Name every file when you start: a kept room (the default) shares the files it
started with. In a room that is not kept (`--keep 0`), you can also type the
path of another file and press Enter while sharing to add it to the room,
without a new link: a meeting can start with the agenda and bring in the spec
when it comes up. Only the host adds files; nobody in the room can ask for
one. A room shares up to 20 files, each a regular UTF-8 file, as when sharing
one. Paths are shown relative to the directory `pedit` runs in.

## Links that can only comment or read

The link pedit prints lets people edit. To let someone only comment, or only
read, press Ctrl+L while sharing, or choose Share in the browser's header, and
send one of these instead:

```text
  Links with less access:
    Comment only  https://edit.piconic.ai/r/<room-id>#c.<key>
    Read only     https://edit.piconic.ai/r/<room-id>#r.<key>
```

| Link | Read the files and comments | Write comments | Edit the files |
| --- | --- | --- | --- |
| Edit | ✓ | ✓ | ✓ |
| Comment only | ✓ | ✓ | |
| Read only | ✓ | | |

A comment-only link is offered while some file keeps comments. Each link
also gives the ones below it, never the ones above, and every peer checks what
the others may do, not the relay. A comment-only link also joins from the
command line, to read and answer comments (its copies of the files are not
sent back); a read-only link opens in a browser.

## Join from the command line

Collaborators who would rather stay in their own editor join from the command
line instead. Given the link, `pedit` mirrors the shared file to a temporary
copy and keeps it in sync both ways until they leave or the host closes the
room; the copy is removed then, like closing a browser tab:

```text
❯ pedit 'https://edit.piconic.ai/r/<room-id>#<key>'

  Joined. Your copy of the shared file:
    /tmp/pedit-<room-id>-2271/00-notes.md
    Copied to your clipboard.

  Edit it with any editor; changes sync both ways while you are in the room.
  Press Ctrl+C to leave. The copies are temporary and removed then.
```

Quote the link in the shell: `#` starts a comment otherwise. Copy out what you
want to keep before you leave. A guest who joins this way gets a copy of each
text file in the room, including files the host adds later: `docs/spec.md` is
copied to `01-docs-spec.md`. A canvas comes as its JSON Canvas, under `.json`
(`00-board.json`). See [sessions](sessions.md#joining-from-the-command-line)
for how copies are named and synced.

Joining from the command line also runs no code from the relay, which matters
if you do not trust whoever serves the browser editor. For that, use a pedit
from Homebrew, `go install` or a [verified release archive](verifying-releases.md),
not the install scripts, which the relay serves; see
[security design](security-design.md#in-a-browser-you-trust-the-relay).

## Next

- [Comments](comments.md): commenting in the browser, and from scripts and
  agents.
- [Configuration and templates](configuration.md): a default server, an
  output directory, notes from a template.
- [Sessions](sessions.md): reconnecting, saving, and kept rooms in detail.
- [What pedit does on your computer](local-files.md): what you accept by
  running it.
- [Self-hosting](self-hosting.md): your own relay, with sign-in and your own
  limits.
