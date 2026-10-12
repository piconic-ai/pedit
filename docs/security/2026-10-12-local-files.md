# Local file access audit (October 12, 2026)

This records how [What pedit does on your computer](../local-files.md) was
checked: what pedit reads, writes and runs on the machines of the host and of
command line guests, and whether those operations stay in bounds. It continues
the [October 5 audit](2026-10-05-audit.md); its findings are numbered from
SEC-007.

The audit started at `9d785f0` (`main`). The fixes are the commits after it on
the branch that added this record. Line references are to `9d785f0`.

## Scope and method

In scope: the Go CLI, sharing (`pedit <file>`, `pedit`, `pedit -t`) and joining
(`pedit <link>`, with and without `-d`). Out of scope: the relay and the
browser editor, except as the other end of the CLI.

Environment: Linux 6.18 (x86_64), Go 1.25.0, Node.js 22.22, running as root in
a disposable container. `fs.protected_symlinks` was `0` and `/proc` was
mounted without `hidepid`.

1. Read `cmd/pedit` and `internal/` for every file, process and network
   operation.
2. Ran the relay and editor locally with
   `pnpm --dir packages --filter @pedit/worker dev`, and pointed the CLI at it
   with `server: http://localhost:8787` in `.pedit/config.yaml`.
3. Ran the built binary under strace and summarized the trace with
   [strace_summary.py.txt](repro/strace_summary.py.txt):

   ```sh
   strace -f -qq -o host.strace \
     -e trace=%file,execve,unlink,unlinkat,rename,renameat,renameat2,inotify_add_watch \
     pedit notes.md
   python3 -I strace_summary.py host.strace
   ```

4. Played guests with a second `pedit` joining from the command line, and with
   [peer.mjs.txt](repro/peer.mjs.txt), which uses `packages/protocol` as the
   browser editor does, to paste images, ask for images and edit:

   ```sh
   node peer.mjs packages/protocol '<link>' paste image.png
   node peer.mjs packages/protocol '<link>' want <hash>
   node peer.mjs packages/protocol '<link>' insert 'text'
   ```

Another local user could not be created in the container. Where a check needs
one, the file was given to another uid with `chown`, or the same account
played both sides, as in the October 5 audit.

One run before step 2 used the generated configuration, which points at
`https://edit.piconic.ai`: it created a room on the public relay with a
two-line synthetic file, and was stopped within a minute. All other runs used
the local relay.

## What the traces showed

Sharing `notes.md` at the root of a new Git repository, a guest editing it,
then Ctrl+C (lines shortened):

```text
READ-OPEN  openat(AT_FDCWD, ".../proj/.pedit/config.yaml", O_RDONLY) = -1 ENOENT
MKDIR      mkdirat(AT_FDCWD, ".../proj/.pedit", 0755) = 0
MKDIR      mkdirat(AT_FDCWD, ".../proj/.pedit/templates", 0755) = 0
WRITE-OPEN openat(AT_FDCWD, ".../proj/.pedit/config.yaml", O_WRONLY|O_CREAT|O_EXCL, 0644) = 5
WRITE-OPEN openat(AT_FDCWD, ".../proj/.pedit/templates/default.md", O_WRONLY|O_CREAT|O_EXCL, 0644) = 5
WRITE-OPEN (default.csv and default.canvas likewise)
READ-OPEN  openat(AT_FDCWD, ".../proj", O_RDONLY) = 5
READ-OPEN  openat(5, "notes.md", O_RDONLY|O_NOFOLLOW) = 8
WRITE-OPEN openat(5, ".pedit-d8c06080e5f49e49e38c53ce4049b81e.tmp", O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600) = 11
RENAME     renameat(5, ".pedit-d8c06080e5f49e49e38c53ce4049b81e.tmp", 5, "notes.md") = 0
```

Joining that room without `-d`, editing the copy, then Ctrl+C:

```text
MKDIR      mkdirat(AT_FDCWD, "/tmp/pedit-5O-ANEG5aj6nLqoDMR-Pdl-1470475545", 0700) = 0
WRITE-OPEN openat(8, ".pedit-41aae629ada86ee45cbe5c5dd04df960.tmp", O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600) = 9
RENAME     renameat(8, ".pedit-41aae629ada86ee45cbe5c5dd04df960.tmp", 8, "notes.md") = 0
READ-OPEN  openat(8, "notes.md", O_RDONLY|O_NOFOLLOW) = 10
OPEN-DIR   openat(7, "pedit-5O-ANEG5aj6nLqoDMR-Pdl-1470475545", O_RDONLY|O_NOFOLLOW|O_DIRECTORY) = 8
DELETE     unlinkat(8, "notes.md", 0) = 0
DELETE     unlinkat(7, "pedit-5O-ANEG5aj6nLqoDMR-Pdl-1470475545", AT_REMOVEDIR) = 0
```

No `execve` besides pedit itself: no clipboard tool was installed, and the
update check does not run without a terminal. With a release build under
`script`, the trace added `mkdirat(".../pedit", 0755)` and
`openat(".../pedit/update.json", O_WRONLY|O_CREAT|O_TRUNC, 0644)` in the cache
directory, and nothing else.

The relay's log held the room ID in `GET /api/rooms/<id>/ws` lines and never
the key.

## Checks that held

| Check | Observed |
| --- | --- |
| `pedit link-out.md`, a symlink to a file outside the directory; `pedit link-in.md`, to `notes.md` beside it | `shared file ... is not a regular file`, exit 1, no room created |
| `pedit linkdir/notes.md`, `linkdir` a symlink to another directory | Shared, through a handle on the resolved directory |
| While sharing, `notes.md` replaced with a symlink to a `0600` file outside (SEC-004) | The guest kept the previous text; the file outside was not changed; on Ctrl+C `could not save notes.md: shared file notes.md is not a regular file` |
| An editor-style save: write `.notes.md.swp`, rename it over `notes.md` | The guest received the new text |
| A guest edit to `notes.md` with mode `0640`, a second hard link and the extended attribute `user.tag` | New inode, mode `0640`, link count 1; the other link kept the old text; no extended attribute |
| Paste a PNG | Stored as `assets/<hash>.png`, mode `0600` |
| Paste `#!/bin/sh` announced as `image/png` | Rejected as `type` |
| Ask for an image in `assets/` that the file does not refer to (SEC-005) | Not uploaded |
| As a guest, add a reference to it, then ask | Not uploaded |
| Ask for an image the file referred to at start | Uploaded |
| A command line guest in the room while another guest pastes an image | Only the host saved it; the guest's directory held only the copy |
| Join a room whose file is `.bashrc`, with `-d` to an empty directory; again with it present | Created `.bashrc` `0600`; `.bashrc already exists; move it away, or join from another directory` |
| An executable `./xclip` in the current directory, `PATH=.:$PATH` | Not run (Go refuses a lookup that resolves to the current directory) |
| A server that answers `POST /api/rooms` with `302 Location: /cdn-cgi/access/login/x`, and a stub `cloudflared` first in `PATH` | Ran `cloudflared access token -app=http://127.0.0.1:18999`, then `cloudflared access login --quiet http://127.0.0.1:18999` |

## Findings

| ID | Severity | Issue | Needs |
| --- | --- | --- | --- |
| SEC-007 | Medium | A `.pedit/config.yaml` in a parent directory owned by another user is used | A local user who can write a directory above where the victim runs pedit, such as `/tmp` |
| SEC-008 | Medium | A template that is a symlink is followed out of the project | A repository with such a template, in which the victim runs `pedit` without a file |
| SEC-009 | Low | Swapping `assets` for a symlink while an image is saved writes it outside the directory | A local user who can write the shared file's directory, racing the save |
| SEC-010 | Low | A file that is not UTF-8 is changed for good on the first edit | Sharing such a file; any edit |
| SEC-011 | Low | A host-chosen file name with bidi controls is accepted by a command line guest | A guest joining a hostile host |

### SEC-007 Configuration owned by another user

CWE-427. `loadConfig` (`cmd/pedit/config.go:35`) reads `.pedit/config.yaml` in
the current directory and each one above it, up to the Git root, or up to `/`
outside a repository. Nothing checked who wrote the file.

With `/tmp/claude-0/exp/D/shared/.pedit/config.yaml` setting
`server: http://127.0.0.1:9` and `output: ../../outside/made-by-config`, running
in `shared/work`, which has no `.git`:

```text
$ pedit notes.md
pedit: failed to create a room: Post "http://127.0.0.1:9/api/rooms": dial tcp 127.0.0.1:9: connect: connection refused
$ pedit
  Saved to /tmp/claude-0/exp/outside/made-by-config/pedit-2026-10-12-065025.md
```

So a planted configuration chooses the relay, and through it the editor the
share link opens, which reads the key; and it chooses where new files and
directories are created.

Fix: `Refuse a configuration file another user owns`. The file is opened, and
used only if it belongs to the user running pedit or to root. Test:
`TestConfigOwnedByAnotherUserIsRefused`, which gives the file away with `chown`
when run as root. After the fix, with the file owned by uid 1001:

```text
pedit: /tmp/claude-0/exp/K/.pedit/config.yaml belongs to another user (uid 1001), so pedit does not use it: it decides where your files are sent. Remove it, or run pedit from a directory you own
```

Not fixed, and documented instead: a configuration that came with a
repository you cloned is yours, and is used.

### SEC-008 Template symlinks out of the project

CWE-59. `config.template` (`cmd/pedit/config.go:101`) read
`.pedit/templates/<name>` with `os.ReadFile`, which follows symlinks. Git keeps
symlinks, so a repository can carry one. With
`.pedit/templates/default.md -> /tmp/claude-0/exp/D2/home-secret/id_test`,
committed, cloned, and `pedit` run in the clone, a command line guest received:

```text
PRIVATE KEY MATERIAL (synthetic)
```

Fix: `Read templates only inside the project`. Templates are read through an
`os.Root` at the project root. Test: `TestTemplatesStayInsideTheProject`. After
the fix:

```text
pedit: could not create a scratch file in .../clone/notes: template "default.md": .pedit/templates/default.md is a link that leads out of the project; pedit reads templates only inside it
```

### SEC-009 Swapping `assets` while an image is saved

CWE-367. `Attachments.dir` (`internal/attach/attach.go:509`) checked `assets`
with `EvalSymlinks`, and `save` (`:437`) then wrote with `os.CreateTemp` and
`os.Rename` by path. [assets_swap_race_before_test.go.txt](repro/assets_swap_race_before_test.go.txt)
swaps `assets` between a symlink to a directory inside and one to a directory
outside while saving 20000 images. Images that landed outside, in four runs:
18, 9, 23 and 64.

Fix: `Save and read attachments through the shared directory's handle`.
Attachments use the `os.Root` the session opened for the shared file:
`assets` is opened with `Root.OpenRoot`, and the image is created, renamed and
read relative to it. With [assets_swap_race_after_test.go.txt](repro/assets_swap_race_after_test.go.txt),
in four runs: none outside, with 697 to 844 saves succeeding. Test, without a
race: `TestKeepsToTheDirectoryItOpened`.

### SEC-010 Files that are not UTF-8

CWE-176. `BoundFile.Read` (`internal/filewriter/bound.go:74`) replaced bytes
that are not UTF-8 with U+FFFD, and the next save wrote that back. 議事録 and
メモ in Shift_JIS, one guest edit:

```text
before: 8b638e96985e0a838183820a
after:  efbfbd63efbfbd5e0aefbfbd0a6164646564
```

A small binary file went the same way. Fix: `Refuse files that are not UTF-8,
and keep one that stops being UTF-8`. Tests:
`TestRefusesFileThatIsNotUTF8BeforeARoomIsMade`,
`TestKeepsAFileThatStopsBeingUTF8`, `TestBoundFileReadsBytesAsTheyAre`. After
the fix:

```text
pedit: .../memo2.txt is not UTF-8 text. pedit shares UTF-8 only, and would replace the bytes it cannot read; convert the file first (for example, iconv -f SHIFT_JIS -t UTF-8)
```

### SEC-011 Bidi controls in a joined file name

CWE-451. `sharedFileName` (`internal/session/join.go:342`) refused control
characters but not bidi controls. A host sharing `invoice<U+202E>cod.md` had a
guest create a file that prints as `invoicedm.doc`. Fix: `Refuse joined file
names that reorder how they print`. Test: `TestSharedFileName`. After the fix:
`pedit: the host did not share a usable file name`.

## Accepted, and documented

These hold after the fixes, and [What pedit does on your computer](../local-files.md)
tells users about them:

- A guest's command line, `pedit '<link>'`, holds the key. `/proc/<pid>/cmdline`
  is readable by other users unless `/proc` is mounted with `hidepid`, and
  `ps` showed the full link during the checks. Shell history keeps it too.
- A configuration from a cloned repository chooses the relay.
- Saving replaces the file: hard links, extended attributes and ACLs are not
  kept, and the owner becomes whoever runs pedit.
- With `-d`, the host names one new file in that directory.
- References in the file at start authorize images, including ones a guest
  added in an earlier session that were saved to the file. In one check, a
  sibling image referred to that way was uploaded when asked for in the next
  session.
- The display name is the OS user name.

## Results

After the fixes: `PEDIT_INTEROP=1 go test -race ./...` passed except
`TestStopReportsFailedFinalWrite`, which also fails on `9d785f0` when run as
root, because root can write in a `0555` directory. `go vet ./...` passed for
Linux, macOS and Windows. `pnpm test` passed (protocol 44, worker 40, web 590),
as did `pnpm typecheck` and `pnpm lint`.

## Limits

Only Linux was traced. Ownership between real users, macOS, Windows (where the
configuration has no ownership check, and reserved device names and alternate
data streams in joined names were not tested), the browser editor and the
production relay were not examined. This does not show that no other problem
exists.
