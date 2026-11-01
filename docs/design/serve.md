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
  7 days, or whose document does not apply is discarded.

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
