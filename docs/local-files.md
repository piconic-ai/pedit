# What pedit does on your computer

`pedit` runs as you, with your permissions. This page lists every file it
reads or writes, every program it runs and every host it talks to, what keeps
each of them in bounds, and what you accept by using it. It was checked by
tracing the system calls of the real binary against a local relay; see
[How this was checked](#how-this-was-checked). "Before" and "after" there
refer to the changes made with this page.

## In short

pedit touches the file you name, an `assets/` directory beside it, its own
`.pedit/` configuration and a small cache; when you join a room, only the copy
it keeps. If what you name is a directory or does not exist, it also looks
through that directory to suggest a file, and shares none of what it reads
there. It runs a clipboard tool and, only
for servers behind Cloudflare Access, `cloudflared`. It never runs anything
that comes from a document, a guest or the relay, and never updates itself.

By using it you accept that:

- **Anyone with the full link** reads and edits the file while you share it,
  and their edits are saved to your file. They can also save images into
  `assets/` beside it. They cannot choose a path, read or write any other
  file, or make pedit run anything.
- **The link is the key.** pedit copies it to your clipboard and prints it in
  your terminal. A link you join with, `pedit '<link>'`, is in that command
  line, which other users of the same machine can see while it runs (`ps`),
  and in your shell history.
- **The project chooses the relay.** `.pedit/config.yaml` decides which server
  receives the encrypted file and serves the editor that reads the key. pedit
  refuses one that another user owns, but not one that came with a repository
  you cloned. Read it as you would a Makefile.
- **Saving replaces the file.** pedit writes a new file and renames it over
  yours. Permissions are kept; hard links to the old file, extended attributes
  and ACLs are not, and the file then belongs to whoever runs pedit.
- **When you join with `-d <dir>`, the host names the copy.** It is one new
  file with a plain name, never a path, and never one that already exists, but
  the host chooses the name and its content: `.bashrc` is a plain name.
- **Images your file refers to when you start are yours.** A guest can ask
  for them, including references a guest added in an earlier session that
  were saved to the file.
- **Your user name is shown to the others** as your name in the room, with the
  file's name (not its path).

## Sharing a file: `pedit <file>`

| | What | What keeps it in bounds |
| --- | --- | --- |
| Reads | `.pedit/config.yaml`, in the current directory or the nearest one above it, up to the Git root (outside a repository, up to `/`) | Used only if you or root own it; otherwise pedit stops and names the file. Windows has no such check. pedit follows a link here; if it, or `.pedit`, is a link whose target does not exist, pedit stops and names it rather than use the default server. |
| Reads | The shared file | Must be a regular file, not a symlink, and UTF-8 text. Opened through a handle on its directory taken at start, and never through a symlink that replaces it later. |
| Reads | When `<file>` is a directory: the names in it, and the first 8 KiB of each regular file whose name does not start with `.`, following symlinks, until six look like text | Only to print up to five names to pick from. No room is made and nothing is sent. |
| Reads | When `<file>` does not exist: the names in its directory | Names only, to suggest close ones. |
| Reads | `.pedit/templates/<name>`, only when pedit creates the file | Only inside the project: a template that is a symlink out of it is refused. |
| Reads | `assets/<hash>.png` (or `.jpg`, `.gif`, `.webp`), when a guest asks for an image | Only images your file referred to at start, that you added while sharing, or that were saved this session. A regular file of up to 10 MiB whose content matches the hash in its name. |
| Writes | The shared file | Through a new `.pedit-<random>.tmp` beside it, renamed over the file. Not while the file has changes pedit has not taken in yet, nor once the file has become a symlink or is no longer UTF-8. Permissions are kept. |
| Writes | `assets/` and the images guests paste | PNG, JPEG, GIF or WebP, judged by their bytes (SVG is never saved); up to 10 MiB each, 100 MiB and 500 images a session. Named by content hash, never over a different file, never outside the shared file's directory, even if `assets` is swapped for a symlink. Images are created `0600`, `assets/` `0755`, before your umask. |
| Writes | `.pedit/config.yaml` and `.pedit/templates/default.{md,csv,canvas}` | Only on the first run at a Git repository root, and only files that do not exist yet. |
| Writes | A new file, with `pedit`, `pedit -t <template>` or `--<type>` | In `output` from the configuration, or `-d`. Created `0644` before your umask, only if no file has that name; the directory is created if needed. |
| Writes | The update check cache, `pedit/update.json` in your [user cache directory](https://pkg.go.dev/os#UserCacheDir) | Only for release builds writing to a terminal, at most once a day. |
| Watches | The shared file's directory | Reacts to changes to the shared file's name only. |

While sharing, the only file pedit removes is its own temporary file, when a
save fails. It never deletes your files.

## Joining from the command line: `pedit '<link>'`

| | What | What keeps it in bounds |
| --- | --- | --- |
| Writes | A copy of the shared file, in a new private directory such as `$TMPDIR/pedit-<room>-<random>/` | The directory is `0700` and the copy `0600`. Both are removed when you leave or the host closes the room, with anything else you put in that directory. |
| Writes | With `-d <dir>`, the copy in `<dir>` | The name comes from the host: a plain name, without `/`, `\`, control characters or characters that reorder how it prints; refused if a file of that name exists. Created `0600` before your umask, and kept when you leave. |
| Reads | The copy, when you edit it | The same guards as the host's file: never through a symlink, only UTF-8. |

A joined session saves no images and reads no configuration. Besides the
copy, it writes only the update check cache.

## Programs pedit runs

| Program | When | Arguments |
| --- | --- | --- |
| `pbcopy` (macOS), `clip` (Windows), `wl-copy`, `xclip` or `xsel` (Linux) | Once, to copy the link when sharing, or the copy's path when joining | The text on standard input, not in arguments |
| `cloudflared` | Only when the server answers room creation with a Cloudflare Access sign-in | `access token -app=<server>`, then `access login --quiet <server>` if there is no valid token |

Both are looked up in your `PATH`. A program in the current directory is not
run even when `PATH` contains `.`. When a newer release is out, pedit prints
the command that upgrades it; it never downloads or runs one.

## Network

| Host | What |
| --- | --- |
| The configured server (`https://edit.piconic.ai` by default), or the one in the link you join | Creates the room, relays encrypted updates over a WebSocket, stores encrypted images. The key stays in the link's fragment and is never sent. The server sees the room ID, your IP address and the sizes and timing of what is sent. |
| `api.github.com` | The latest release of pedit, at most once a day, for release builds on a terminal. |

With Cloudflare Access, the browsers of the others in the room load your
picture from Gravatar, which receives a hash of your email address.

## What to do

- Share the link only with people you would give the file to. On a machine
  others can log in to, join from the browser: they can see the link in a
  `pedit '<link>'` command while it runs.
- Before running pedit in a repository you did not write, look at
  `.pedit/config.yaml`: `server` is where the link points.
- Join with the default temporary copy, or give `-d` a directory meant for it.
- Keep a file you care about under version control, as pedit saves edits as
  they come. Convert a file that is not UTF-8 before sharing it; pedit refuses
  it otherwise.

## How this was checked

On Linux 6.18 with Go 1.25, before and after the changes made with this page,
the `pedit` binary was run against the relay and editor served locally by
`pnpm --dir packages --filter @pedit/worker dev`, under
`strace -f -e trace=%file,execve,unlink,unlinkat,rename,renameat,renameat2`.
Guests were a second `pedit` joining from the command line, and a script that
speaks the room protocol through `packages/protocol`, as the browser editor
does, to paste images and ask for them. The tables above list every file
operation and program the traces showed, besides system libraries, TLS
certificates and name resolution.

| Check | Result |
| --- | --- |
| Share a symlink to a file, inside or outside its directory | Refused before a room is made |
| Share a file in a directory reached through a symlink | Shared |
| Name a directory holding a symlink to a file outside it; name a file that does not exist | Read the start of the link's target to judge it text and printed names only, without making a room; listed the directory's names only |
| Replace the shared file with a symlink to another file while sharing | Nothing reaches the guests; the final save is refused and reported |
| An editor saves by writing a new file and renaming it | Taken in and sent to the guests |
| A guest's edit to a file with a hard link and an extended attribute | New file with the same mode; the hard link keeps the old content; the attribute is gone |
| Paste a PNG; paste a shell script announced as `image/png` | Saved `0600` in `assets/`; refused as `type` |
| Ask for an image in `assets/` that the file does not refer to; add a reference to it as a guest, then ask | Not uploaded, both times |
| Swap `assets` for a symlink to another directory in a loop while saving 20000 images | 9 to 64 images outside in four runs before; none after, with about 700 saves succeeding |
| `.pedit/config.yaml` in a parent directory, owned by another uid | Used before; refused after |
| A cloned repository whose `default.md` template is a symlink to a file outside it | That file was shared as a new note before; refused after |
| Share a Shift_JIS file, and a binary file, then edit | Both changed to U+FFFD for good before; refused after |
| Join a room whose file is named `.bashrc`, with `-d`; again with the file present | Created `0600`; refused |
| Join a room whose file name holds U+202E | Created before; refused after |
| Guest pastes an image while a command line guest is in the room | Saved by the host only |
| An executable `./xclip` with `PATH=.:$PATH` | Not run |
| A server that sends room creation to `/cdn-cgi/access/` | `cloudflared` run with the arguments above |
| The relay's log | Room IDs, never the key |

Another user was played by the same account, with `chown` for the
configuration file, so these checks do not cover permissions between real
users. macOS, Windows and the browser editor were not traced. The commands,
scripts and outputs are in the
[audit record](security/2026-10-12-local-files.md).
[SECURITY.md](../SECURITY.md) says how to report a way around any of this.
