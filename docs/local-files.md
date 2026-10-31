# What pedit does on your computer

`pedit` runs as you, with your permissions. This page lists every file it
reads or writes, every program it runs and every host it talks to, what keeps
each of them in bounds, and what you accept by using it. It was checked by
tracing the system calls of the real binary against a local relay; see
[How this was checked](#how-this-was-checked). "Before" and "after" there
refer to the changes made with this page.

## In short

pedit touches the files you name, and those you add while sharing, an
`assets/` directory beside each, its own `.pedit/` configuration, the comments
it keeps in `.pedit/meta/`, and a small cache; when you join a room, only the copies it keeps. If what you name is a directory or does not exist, it also looks
through that directory to suggest a file, and shares none of what it reads
there. It runs a clipboard tool and, only
for servers behind Cloudflare Access, `cloudflared`. It never runs anything
that comes from a document, a guest or the relay, and never updates itself.

By using it you accept that:

- **Anyone with the full link** reads and edits the files while you share
  them, and their edits are saved to your files. They can also save images
  into `assets/` beside each. They cannot choose a path, add a file to the
  room, read or write any other file, or make pedit run anything: only you add
  files, by naming them or typing their paths into pedit. Someone with a
  comment-only link (Ctrl+L) can write comments but not the files, and
  someone with a read-only link neither.
- **The link is the key.** pedit copies it to your clipboard and prints it in
  your terminal. A link you join with, `pedit '<link>'`, is in that command
  line, which other users of the same machine can see while it runs (`ps`),
  and in your shell history.
- **The project chooses the relay.** `.pedit/config.yaml` decides which server
  receives the encrypted file and serves the editor that reads the key. pedit
  refuses one that another user owns, but not one that came with a repository
  you cloned. Read it as you would a Makefile.
- **Saving replaces the file.** pedit writes a new file and puts it in place of
  yours. Permissions are kept; hard links to the old file, extended attributes
  and ACLs are not, and the file then belongs to whoever runs pedit. Where the
  file system can swap two files (most Linux and macOS disks), the new file is
  swapped with yours, so a save your editor makes while pedit writes is swapped
  back and merged in. Elsewhere (Windows; NFS, SMB and FUSE; exFAT, and FAT on
  macOS) it is renamed over yours after one more check, and a save that lands
  just after that check can be lost.
- **When you join, the room chooses what your copies hold, not what they are
  called.** Anyone in the room can name a file, and a name can mean something
  to your computer: `.git/config` makes a folder a repository whose commands
  your shell prompt runs, `desktop.ini` and `x.scf` make Explorer fetch from
  another computer, `notes.md.bat` runs when opened. So pedit names each copy
  itself: a number, then the ASCII letters and digits of the host's path,
  then an extension kept only from a short list of text formats (md,
  markdown, txt, csv, tsv, json, yaml, yml, toml), `.txt` otherwise. All go in
  one new temporary directory, with no directory of their own:
  `docs/spec.md` is copied to `01-docs-spec.md`, `.git/config` to
  `02-git-config.txt`. Their content is the room's, as in a browser: a CSV
  opened in a spreadsheet can hold formulas, and Markdown or JSON opened in an
  editor can point to pictures or schemas on the web.
- **Comments are saved in your project.** What people write as comments on a
  file, with the names they gave and the text they commented on, is saved in
  `.pedit/meta/<path>.json`, even if that text is deleted later. Anyone in
  the room can add, change or delete any comment. Committing `.pedit/meta/`
  publishes all of it to whoever can read the repository. A file that was
  moved or renamed loses its comments until you move its metadata file along
  with it.
- **Images your file refers to when you start are yours.** A guest can ask
  for them, including references a guest added in an earlier session that
  were saved to the file.
- **Your user name is shown to the others** as your name in the room, with the
  file's name (not its path). In a room that shares several files, the others
  see each file's path relative to the directory pedit runs in, or its name
  alone for a file outside it.

## Sharing a file: `pedit <file>`

| | What | What keeps it in bounds |
| --- | --- | --- |
| Reads | `.pedit/config.yaml`, in the current directory or the nearest one above it, up to the Git root (outside a repository, up to `/`, or the drive root on Windows) | Used only if you or root own it (on Windows: you, SYSTEM or the Administrators group); otherwise pedit stops and names the file. pedit follows a link here; if it, or `.pedit`, is a link whose target does not exist, pedit stops and names it rather than use the default server. |
| Reads | The shared file, and each file named after it or typed in while sharing | Must be a regular file, not a symlink, and UTF-8 text. Opened through a handle on its directory taken when it is added, and never through a symlink that replaces it later. A file already shared under another name (a hard link), one whose name macOS or Windows would take for one already shared (`Notes.md` and `notes.md`), and a 21st file are refused. |
| Reads | When `<file>` is a directory: the names in it, and the first 8 KiB of each regular file whose name does not start with `.`, following symlinks, until six look like text | Only to print up to five names to pick from. No room is made and nothing is sent. |
| Reads | When `<file>` does not exist: the names in its directory | Names only, to suggest close ones. |
| Reads | `.pedit/templates/<name>`, only when pedit creates the file | Only inside the project: a template that is a symlink out of it is refused. |
| Reads | `.pedit/meta/<path>.json`, for each shared file inside the project (the directory of `.pedit/config.yaml`, or the current one) | Read through a handle on the project directory, never through a symlink, the file's or a directory's on the way (a cloned repository could hold `.pedit/meta` as a link), and only a regular file of up to 1 MiB, checked as input from anyone: a file pedit cannot read, or written by a newer pedit, is left as it is, and that shared file offers no comments. |
| Reads | `assets/<hash>.png` (or `.jpg`, `.gif`, `.webp`), when a guest asks for an image | Only images your file referred to at start, that you added while sharing, or that were saved this session. A regular file of up to 10 MiB whose content matches the hash in its name. |
| Writes | The shared file | Through a new `.pedit-<random>.tmp` beside it. Where the file system can swap two files (most Linux and macOS disks) it is swapped with the file in one step, and the old file, now under the temporary name, is removed only once pedit has read it twice, 5 ms apart, and found what pedit expected; a save that landed meanwhile is swapped back. Elsewhere (Windows; NFS, SMB and FUSE; exFAT, and FAT on macOS) the file is checked once more just before the new one is renamed over it: a save renamed over the file after that check is lost, and one written into the old file after it is lost and reported, without a report where a file cannot be replaced while open (FAT, exFAT and some SMB shares on Windows). A missing file is created only if no file appeared at its name meanwhile (on FAT and exFAT, only after a check). Not while the file has changes pedit has not taken in yet, nor once the file has become a symlink or is no longer UTF-8. Permissions are kept; if the file is deleted while sharing, the next save creates it again, `0600` before your umask. A save that fails is tried again every few seconds. |
| Writes | `assets/` and the images guests paste | PNG, JPEG, GIF or WebP, judged by their bytes (SVG is never saved); up to 10 MiB each, 100 MiB and 500 images a session. Named by content hash, never over a different file, never outside the shared file's directory, even if `assets` is swapped for a symlink. Images are created `0600`, `assets/` `0755`, before your umask. |
| Writes | `.pedit/meta/<path>.json`, and the directories above it | Only once someone comments on the file, or if it existed. In a kept room, as in a live room, and on `--resume` for what was commented while away. Written as the shared file is, through a new `.pedit-<random>.tmp` beside it, within the project directory and through no symlinked directory. A file under `.pedit/meta/`, by any path, is never shared itself. Never over a file that appeared at its name, nor over one changed outside pedit since it was read or written: pedit then stops saving comments to it and says so. Never removed. Created `0600`, directories `0755`, before your umask. |
| Writes | `.pedit/config.yaml` and `.pedit/templates/default.{md,csv,canvas}` | Only on the first run at a Git repository root, and only files that do not exist yet. |
| Writes | A new file, with `pedit`, `pedit -t <template>` or `--<type>` | In `output` from the configuration, or `-d`. Created `0644` before your umask, only if no file has that name; the directory is created if needed. |
| Writes | Kept-room resume records: `pedit/keep/<sha256(project path)[:16]>/<room>.json` under `os.UserConfigDir()` | Holds the project and source paths, room key, host token, recoverable document state and the last entry of the relay's log taken in. Created by `--keep` (which `pedit <file>` applies by default) outside the project with directories `0700` and files `0600`. Used by `pedit <file>` and `--resume` (with or without the room ID or link) from the same project; removed by pedit when `--close` ends the room, when a resume finds the room ended or expired, and, without asking the relay, at `pedit <file>`, `--resume` and `--close` for records of the same project whose deadline passed more than an hour ago or that belong to rooms kept by an older version of pedit (by polling), which can no longer be resumed; never while a write is pending. Other records, and those pedit cannot parse, are left alone. An old `.pedit/<room>.keep.json` is refused with a warning that it contains the room key. |
| Writes | The update check cache, `pedit/update.json` in your [user cache directory](https://pkg.go.dev/os#UserCacheDir) | Only for release builds writing to a terminal, at most once a day. |
| Watches | Each shared file's directory | Reacts to changes to the shared files' names only. |

While sharing, the only name pedit removes is its own temporary file: the new
content when a save fails, your old file once pedit has checked it holds what
pedit expected, or an older save of yours that a newer one replaced while pedit
put it back. Rarely (saves landing faster than pedit can put them back, or an
error while it does) a save of yours stays under that `.pedit-<random>.tmp`
name, and pedit names it in the terminal (on Ctrl+C, see below).

When saving the file fails, and fails again when tried again, or the file
changes into something pedit cannot take in (text that is not UTF-8, a canvas
that does not parse), pedit says so in the terminal, and again once it saves
again. Until then the file misses the latest edits: fix it before you press
Ctrl+C. pedit also says when it cannot save an image someone pasted, for
example because `assets` is a file or a link out of the folder, and when it
can tell that a save your editor made while pedit wrote the file was lost.
While pedit saves on exit after Ctrl+C, it reports only what goes wrong in its
last attempt, in its closing message; a save lost or set aside before that
shows only with `PEDIT_DEBUG=1`.

## Joining from the command line: `pedit '<link>'`

| | What | What keeps it in bounds |
| --- | --- | --- |
| Writes | A copy of each text file the room shares, in a new private directory such as `$TMPDIR/pedit-<room>-<random>/` | Named by pedit, as above, never as the room names it, and never in a directory of its own. The directory is `0700` and each copy `0600`, both before your umask; every copy is made through a handle on the directory held since joining, so the directory moved and replaced by a link cannot lead elsewhere. Never over a file that is there. Canvases are not copied. At most 20 files. All are removed when you leave or the host closes the room, with anything else you put in that directory; when the room closes because a file grew too large, they stay, and pedit says where. |
| Reads | The copies, when you edit them | The same guards as the host's file: never through a symlink, only UTF-8. |

In a kept room, `--resume` also saves, under `assets/` beside each
file, the images that file's text refers to and that guests pasted while you
were away, with the same checks and permissions as above (content hash, PNG,
JPEG, GIF or WebP by their bytes, `0600`). It fetches only images the text
refers to, and none already there.

A joined session saves no images, keeps no comments and reads no
configuration. Besides the
copy, it writes only the update check cache. A save of the copy that fails is
retried and reported the same way.

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
- Copy out of the temporary directory what you want to keep before you leave
  a room you joined from the command line.
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

Sharing several files ([#113](https://github.com/piconic-ai/pedit/issues/113))
came after this trace. Its guards are covered by tests
(`internal/session/files_test.go` and `mirror_test.go`), not by a trace.

Another user was played by the same account, with `chown` for the
configuration file, so these checks do not cover permissions between real
users. macOS, Windows and the browser editor were not traced. The commands,
scripts and outputs are in the
[audit record](security/2026-10-12-local-files.md).
[SECURITY.md](../SECURITY.md) says how to report a way around any of this.
