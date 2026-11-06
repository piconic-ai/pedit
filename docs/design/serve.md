# pedit serve: the document across restarts

`pedit serve` owns one file's Yjs document for an app's browsers. Restarts are
ordinary: the child stops 60 s after the last page left, the app hot-reloads, or
the child crashes. A page that kept its `Y.Doc` must meet the same document
again, or its copy would merge into a new one and the text would appear twice.
Continuity is pedit's job, not the app's. It mirrors what a kept room does
(see [rooms-away.md](rooms-away.md)): the host resumes with the Yjs identifiers
from its record, and trusts the record only against the file.

## The state file

- Where: `<UserConfigDir>/pedit/serve/state/<sha256 of the file's path>.json`
  (under the socket base when one is given). It is in the user's state
  directory, not beside the file: the lock beside the file excludes a second
  pedit, and the state is only for recovery. Created `0600`, written
  atomically.
- What: a version, a `generation`, the time saved, the text pedit last wrote
  (`Written`), the text about to be written (`Pending`, only while a write is
  in doubt), and the whole Yjs document as one update.
- When: at start, before each write of the file, after it, and on exit.
  The document is saved before the file write it precedes, so a crash never
  leaves the file ahead of the state.
- Who: only the process holding the lock reads or writes it.

## The last-written check

On start the state is used only if it still fits the file, as a kept room's
record fits its source file:

- The document's text must equal `Written` (or `Pending`).
- If the file holds `Written`, the document is resumed as is. If it holds
  something else, that is a save by someone else: it is merged into the resumed
  document as an external edit, never written back over it.
- With a write in doubt (`Pending`), the file must hold `Written` or `Pending`;
  anything else starts afresh, because the text the editor started from is not
  known.
- A state that is unreadable, not `0600`, of another version, older than
  7 days, or whose document does not apply is discarded. While a kept room's
  record for the file exists, age does not discard it, and a state that cannot
  be used gives way to the record's document when that fits the file
  (docs/design/embedding.md, "Kept rooms keep one history").

## Generation

The state carries a `generation` (16 random bytes in hex). A restart that
resumes the state keeps it; starting afresh makes a new one. The `listening`
event reports it, `@pedit/serve` hands it to the page with each session, and the
page compares: the same generation means the page's `Y.Doc` and the server's
share one history and a reconnect merges normally; a different one means the
page's copy cannot be merged, so the client stops with `gone`. The page's unsent
edits stay in its `Y.Doc`; the app decides whether to offer them for copying or
to reload. `/:id/doc` also compares the session's generation with the child it
reached, so a restart between the two requests is refused with 403.

## Removal

The state is removed when the file is gone (on exit, and when pedit is asked to
serve a path that does not exist). Age does not remove it: an old state is only
ignored, and replaced by the next write. A state for a file that is never
served again stays until removed by hand.

## Transport: the child's standard streams

Until now the child listened on a Unix socket in a `0700` directory, and the
app dialled it once per page. Node cannot reach an AF_UNIX socket on Windows
(it takes a path there as a named pipe), and a host without Node, such as a
Tauri app, would have to speak WebSocket to the socket. So the socket goes:
the app talks to the child over the child's stdin and stdout, one stream per
page. The browser side does not change: the routes, the session token, the
Origin check and `resolve` stay in `@pedit/serve`, and `ServedFile.dial`
still returns a `Bridge`.

`pedit serve --stdio` is the only way to serve; the socket mode and the
`listening.socket` field are removed, not kept beside it. `@pedit/serve`
requires the pedit version that ships this (`MIN_PEDIT_VERSION`), and its
version check refuses an older one as today.

### What may reach a file

The transport must not widen what the child can read or write. These hold,
and tests pin them:

- The file is chosen once, by the command line (`--root <dir> -- <name>`), and
  bound under `os.Root`. No frame names a path or asks to open anything; a
  second file is a second child.
- Besides the file, the child touches only its lock beside the file and its
  state file (see above). The socket directory is gone.
- While the app shares the file (serve version 2, docs/design/embedding.md),
  the child also touches what `pedit <file>` does for a shared file:
  - it reads the project's `.pedit/config.yaml`, and never creates one;
  - it reads and writes the file's comments under `<project>/.pedit/meta/`;
  - it saves images that reviewers paste beside the file;
  - it keeps a kept room's record under `pedit/keep/` in the user
    configuration directory.

  Nothing else changes: the file is still the one the command line chose, and
  no command names a path.
- A stream's role is set by its `open` frame and never changes. `read` is
  enforced by pedit: an update from a reader closes the stream (4003).
- Only the parent holds the pipes. Any process of the user could dial the old
  socket; nothing but the parent reaches stdin.
- The child gets only its three pipes and the environment `peditEnv()` lists.

### Frames

Each direction is a sequence of frames, nothing else:

    kind (1 byte) | stream (uint32, big-endian) | length (uint32, big-endian) | payload

| Kind | From | Payload |
| --- | --- | --- |
| `1` open | app | one byte: `0` edit, `1` read |
| `2` data | both | one y-websocket message, as a WebSocket binary frame carried it |
| `3` close | both | from the app, empty; from pedit, a uint16 close code and a UTF-8 reason of at most 123 bytes |
| `4` event | pedit | stream 0; one JSON event as `--json` printed it (`listening`, `saved`, `external_save`, `update_available`, `held`, `error`) |
| `5` command | app | stream 0; one JSON command of at most 64 KiB (`share`, `unshare`, `close`; serve version 2, see docs/design/embedding.md) |

- Stream ids are chosen by the app, start at 1 and only increase; an id is
  never reused within a child. At most 8 streams are open at once.
- A frame from the app that breaks the format ends the child (it saves first):
  an unknown kind, a length over 64 MiB, a `command` off stream 0 or over
  64 KiB, an `open` with an id that is not
  greater than every earlier one, an eighth-plus-one open stream, or `data`
  or `close` for an id never opened.
- `data` or `close` for a stream pedit has already closed is ignored: the app
  may have sent it before the close arrived.
- A malformed y-websocket message inside `data` closes that stream only, with
  the codes used today (1003, 1008, 4003).
- stdout carries frames only. Every message for people goes to stderr; a test
  parses all of stdout as frames.

### Liveness and back-pressure

- The pipe has no peer to lose but the parent: when stdin ends, pedit saves
  and exits, as it does now. No ping per stream: the app watches the browser's
  WebSocket and closes the stream when the page goes.
- One goroutine writes stdout. Each stream keeps its queue of 1024 messages; a
  stream that fills it is closed (1013) instead of holding the others back.
- The app reads stdout without pause and never waits on a browser; a page
  whose socket buffers more than 16 MiB is closed (1013), as today.

## The serve version and `--version --json`

`pedit --version --json` prints one line, for an app that has to know what it
is talking to:

    {"version":"v0.5.2","wire":7,"serve":2,"state":1}

- `version`: what `pedit --version` prints.
- `wire`: the relay protocol version (`internal/protocol`).
- `serve`: the version of the `pedit serve --stdio` surface, meaning the frames
  and the events. It starts at 1 and changes only additively within a value:
  new events and new fields may appear, and nothing that exists changes
  meaning. Anything that breaks an app raises the value. An app checks `serve`
  instead of comparing pedit versions, and ignores events and fields it does
  not know.
- `state`: the version of the state file above.

The `listening` event carries `version` and `serve` too, so an app that already
runs a child need not start a second process to learn them.

## Update events

After `listening`, the child checks for a newer release in the background, with
the same cache as the interactive check (`<UserCacheDir>/pedit/update.json`, so
at most one request a day across all children). If one exists it sends, once:

    {"event":"update_available","version":"v0.6.0","url":"https://github.com/piconic-ai/pedit/releases/tag/v0.6.0","security":false}

- Only the tag and the release page URL come from GitHub; nothing else is
  passed on.
- `security` is true when the release notes have a `## Security` or
  `### Security` heading. `.github/release.yml` files pull requests labelled
  `security` under that heading. The flag is kept in the cache beside the
  version; a cache written before it existed reads as false.
- Not checked: development builds (`dev`), when `CI` is set, or with
  `--no-update-check`. A failed request is silent and tried again next time.
- `@pedit/serve` passes it to the app as an `update_available` event once per
  version, however many children saw it.

## Windows

`@pedit/serve` supports Windows. With the transport above, these are what was
checked before lifting the refusal, each with a test on `windows-latest`:

- Stopping: Node's `child.kill('SIGTERM')` is `TerminateProcess` on Windows, a
  hard kill inside the write delay. Stop by closing stdin only, and give up
  (with an error event) instead of killing.
- The state file: Windows has no `0600`. `readState` refuses any state whose
  mode is not `0600`, so every restart would start afresh and pages would get
  `gone`. Check that the state directory is the user's own (by SID, as the
  configuration check already does) instead of the mode.
- Writing the file: the atomic replace (`internal/filewriter`) can fail while
  another process (an editor, an indexer, antivirus) holds the file open
  without sharing delete. Retry, then report, and never leave a partial file.
- Watching: fsnotify uses `ReadDirectoryChangesW`; check that an editor's
  atomic save is still taken in as an external save.
- One file, one child: `ServedFiles` keys a file by realpath and `dev:ino`.
  Distinct files must never share a child, and other spellings of one file
  must reach the same child.
  - Never fold case in the key. Case sensitivity is per directory on Windows
    (`fsutil file setCaseSensitiveInfo`), so `FOO.txt` and `foo.txt` can be
    two files. Take the spelling from the native `realpath`, which asks the
    open file for its final path, so another casing or an 8.3 short name of
    one file comes back as the name on disk.
  - Node can report an `ino` of 0 on some file systems (FAT, network shares),
    which would make different files one: do not alias on an `ino` of 0.
  - Tests on `windows-latest`: two case-distinct files in a case-sensitive
    directory get two children; another casing of one file in an ordinary
    directory reuses its child. Skip the first where the runner cannot make
    a case-sensitive directory, and say so.
- `root`: `inside()` uses `path.relative`, which returns an absolute path
  across drives; that is refused already, and a test should say so. Cover
  `\\?\` paths, 8.3 short names and junctions too.
- The binary: find `pedit.exe` on the PATH, and set the environment
  `peditEnv()` passes for Windows (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
  `SystemRoot`, `TEMP`).
- Line endings: a file with CRLF stays CRLF (`internal/lineend`).

## Order of work

1. This design.
2. pedit: `--stdio`, frames, the socket removed; tests including the stdout
   check and the format violations above.
3. `@pedit/serve`: the bridge over the child's pipes, `MIN_PEDIT_VERSION`
   raised; `hono.ts` and the client unchanged.
4. `examples/serve-app` on macOS, then its test on `windows-latest` in CI.
5. The Windows checks above, then lift the refusal.
6. irori-cms, as a trial on a branch of its own.
