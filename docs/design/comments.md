# Comments

How comments (#121) work: where they live, how they reach the room, how they
stay on their place, and how they come back in the next session. The issue
holds the problem and the goal; the probes behind these choices are in its edit
history.

## Where comments live

- **A metadata file per shared file.** Comments on `docs/spec.md` live in
  `.pedit/meta/docs/spec.md.json`, under the directory whose `.pedit/` pedit
  uses: the one with `.pedit/config.yaml`, found as `cmd/pedit/config.go`
  finds it. A file outside that directory gets no comments, and pedit says
  why.
- **Never in the shared file.** CriticMarkup or canvas fields would make every
  comment an edit of the file, and CSV has no place for them.
- **Shaped for more than comments.** The file is
  `{"version": 1, "path": "docs/spec.md", "comments": {...}}`. Suggestions
  (tracked changes) can later be another top-level key. pedit keeps top-level
  keys it does not know when it writes the file. A file whose `version` it does
  not know is left alone, and that shared file offers no comments.
- **Keyed by path.** After `mv` or `git mv`, comments stay under the old path;
  move `.pedit/meta/<old>.json` along with the file. `path` records which file
  the metadata belongs to, so a later `pedit doctor` can list what lost its
  file. Following renames automatically was rejected: Git keeps no record of
  renames either, and matching by content mistakes files made from the same
  template.
- **Saved by default, by the host only.** The host creates the file when the
  first thread is added, writes it as it writes the shared file, and never
  removes it. Guests, the CLI guest included, write no metadata.

## How it reaches the room

- **One more file of the room.** Multi-file sharing (#113) gives every file its
  own Y.Doc, listed in the host's manifest with a format. The metadata doc is a
  manifest entry of format `meta`, whose path is `.pedit/meta/` + the shared
  file's manifest path + `.json` (`MetaPath` in `internal/protocol/files.go`,
  `metaPath` in `packages/protocol/src/files.ts`). That path pairs it with its
  file; it is a name for the pairing, not where the file is on disk. It is
  longer than the file's path, so the host lists it only if it keeps the
  limits on paths and names no file the room already shares: one bad path
  refuses the whole manifest. A field naming the file would be cleaner, but
  a manifest entry is a fixed (id, path, format), and older peers refuse a
  manifest with bytes they do not expect.
- **Additive.** Peers leave out formats they do not know, so older browsers and
  CLIs never see comments. No new message type, no `PROTOCOL_VERSION` bump.
- **Separate from the content.** One Yjs update can touch several roots of a
  doc, so comments in the content doc could not be told apart from edits.
  A doc of their own, with its own file id, lets comment-only links (#122)
  accept a message by the file it names.
- **Commenting needs a host that lists it.** A browser offers comments on a
  file only when the manifest pairs a `meta` entry with it.

## The shared doc

The metadata doc has one root map, `comments`, of threads keyed by a random id
(`^[A-Za-z0-9_-]{1,32}$`). A thread is a Y.Map:

| Key | Value |
| --- | --- |
| `anchor` | where it points, in this session (below) |
| `quote` | the text the anchor covered when the thread was made |
| `resolved` | `true` once someone resolved it |
| `messages` | a Y.Map of comments keyed by a random id, each `{author, time, body}`; `time` is RFC 3339 in UTC, as `toISOString` writes it |

Comments are shown by `time`, then by id. Names are self-chosen and say nothing
about who wrote a comment.

### Anchors in a session

Each kind of file anchors on what survives its edits:

- **Text and Markdown:** two Yjs RelativePositions on the content's Y.Text,
  the start with assoc 0 and the end with assoc -1, so text typed at either
  edge stays outside. Positions are resolved with `followUndoneDeletions =
  false`, so every peer agrees after an undo.
- **CSV and TSV:** a cell is a range of the same Y.Text that takes in what is
  typed at its edges (start assoc -1, end assoc 0), so a value rewritten in
  place stays in it and an empty cell has a place. A row or column inserted
  beside a cell comes into its place too, so the cell is the one that starts
  where its place does, past the delimiters and line breaks it took in, and
  ends at a cell's edge inside it; the host saves only that part. A cell
  that was empty, as the thread's quote tells, takes in what is typed after
  it as well: it is the empty cell at the start when its place holds
  something, and the one at the end when it holds only delimiters. A cell
  longer than a quote takes no thread, as the host could not keep its place. Deleting a
  cell takes a delimiter with it, so its place closes on an empty span
  between its neighbours, where no cell starts and ends: the thread is
  detached. A cell whose neighbour was deleted keeps its place, and its
  thread. The one case this cannot tell is an empty cell whose column goes
  beside another empty cell: nothing left in the text tells them apart.
  While the file does not parse as a table, its cells' threads are detached.
  A range of cells is its two corner cells, and quotes their raw text, cut
  to the quote's limit; the table marks a thread on its first cell, as
  spreadsheets do.
- **Canvas:** the node's `id`. Stacking changes and undo replace a node's
  Y.Map, but keep its id. A thread quotes what the node shows, its text,
  label, file or link, cut to the quote's limit: it is changed when the node
  shows something else, and detached while no node has its id. The board
  marks the nodes open threads are on.

A thread is **attached** when its anchor resolves to what the quote says,
**changed** when it resolves to something else, and **detached** when its
place is gone, or the content it names has not arrived yet.

## The next session

RelativePositions mean nothing in a new session: every run builds a new Y.Doc
from the file. So the metadata file keeps where each anchor was at the last
save, as a W3C TextQuoteSelector with a position as a hint:

```json
{"type": "text", "exact": "world", "prefix": "hello ", "suffix": "!", "offset": 6}
```

`prefix` and `suffix` hold up to 32 UTF-16 code units, and `offset` counts
them too, as Yjs does. A text anchor always has `exact`; an empty cell is found
by its neighbours. A CSV anchor holds one of these per corner cell
(`{"type": "cells", "from": ..., "to": ...}`), and a canvas anchor is
`{"type": "node", "id": "n1"}`.

When the host loads the file, before the room opens, it finds each `exact` in
the file. Context, then closeness to `offset`, decide between several matches.
It then writes the thread's RelativePositions into the doc. Re-anchoring
happens once and on the host, so every peer starts from the same anchors. Text
that is not found leaves its thread detached, with its last saved place kept
for the next try.

When the host saves, it writes each anchor's place as it is then. ygo cannot
resolve a position whose character was deleted as Yjs does, and what is left
of a deleted run cannot be told from outside it, so the host does not ask
ygo then: a `Tracker` takes each position while its character is still in the
text (as the room makes it, or as it arrives) and follows it through every
change to the text, as Yjs would place it. The one case it cannot follow is
text inserted concurrently right where a deleted character was. Placing a
position costs time in the length of the text, deleted characters included,
so only the host's handling of each update of the comments places new ones,
for up to a second per update, and under the time the room's checks allow
(see below); saving follows only those already placed. An anchor
whose text is gone keeps the place it last saved, or, for a thread made this
session, its quote, so it can be found if the text comes back. The doc's
shape and these rules are in `internal/meta/doc.go` and `track.go`.

## Input from other people

Everything in the metadata doc, and in the file on disk, may come from someone
else: a guest, or a teammate through Git. Every peer checks it the same way.

- Limits: 500 threads, 200 comments in a thread, 4,000 UTF-16 code units in a
  body (as JavaScript counts a string's length), 200 in a name, 1,000 in a
  quote, 1 MiB for the file, nested at most 32 deep. pedit never writes a file
  it would refuse to read.
- Keys must match exactly: JSON decoders that match names in any case would
  let a file show reviewers one comment and pedit another.
- Names, bodies and quotes are shown as text, never as HTML, with control and
  bidi characters removed.
- Every peer reads each update to the doc before applying it
  (`internal/meta/check.go`, `scan.go` and `lists.go`;
  `packages/protocol/src/meta.ts`), without applying it to a copy: Yjs takes
  time in the square of the length of a list (the items set under one key of a
  map, a run of values counting as many) to apply items to it, and a copy
  would pay that for the whole doc on every update. It finds the list of each
  item as Yjs would, by its parent and key or along the chain of items it
  follows, and drops an update that holds anything but maps and plain values,
  under the comments map and keys of at most 64 bytes; that needs structs or
  deletions not received yet, or follows an item, or sits in one, in a cycle
  (with each client's structs also following its one before) or ahead of
  itself (Yjs keeps those as pending, and sends them on with the
  doc, past every check); that takes one of its clients past 65,536
  operations; after which applying the doc's lists could take more than the
  sum of the squares of their lengths allows (1,048,576: honest comments stay
  far under it, and Yjs applies a doc at it in well under a second); or after
  which the doc would pass about 1 MiB. Yjs and ygo encode one doc in
  different sizes (Yjs merges deleted runs; ygo keeps each), so the limit is
  on a measure every peer works out alike from the structs, which neither
  encoding passes, and so fits the frame the state is sent in: a live item
  counts what Yjs writes for it, each deleted clock 96 bytes, and each client
  a few. Applying an update deletes more than it says: of the items set under
  one key, by peers that had not seen each other's, all but one, and what the
  maps among them hold. So an item that could be deleted that way, one of
  several under its key or in a map that could be, counts 96 bytes a clock at
  least, deleted or not, and a doc measures no less for having an update
  applied than the check foresaw. A doc a peer has, or its whole state to a peer that has none,
  measures the same everywhere. So a hostile client cannot make a peer hold,
  and send, what other peers refuse, nor spend long applying it. The host
  shares no comments over that limit, so every peer can take the state the
  host sends.
- An update dropped for a gap is refused for now: the peer asks the room for
  what it is missing (a sync step 1, at once or, if it asked in the last 5
  seconds, then), and an honest sender's updates come back whole. So is one
  that comes while checking and applying the updates of all checked files have
  taken a quarter of the time (up to a second in hand), so a flood of updates
  cannot keep a peer checking updates, or the host placing anchors: the host
  places the anchors of each update as it applies it (for up to a second),
  since one left for later could lose its character first. The host also turns
  a panic in ygo on such an update into an error.
- Anyone with the key can fill the lists' allowance, after which the room
  takes no more comments until the host starts again. Anyone with the key can
  as well delete or rewrite every comment, so it gives them nothing new. The
  measure counts what a session deletes or overwrites too, 96 bytes a value,
  so one session of the host takes about 10,000 of those (resolving, editing
  and deleting comments); each starts from the file, with none.
- A metadata file that breaks these rules is left untouched, and its shared
  file offers no comments.

## How the goals of #121 are met

- **Comment on text, cells or a node, live, with replies and resolving:**
  the web editor's comments panel (`packages/web/src/comments.ts`,
  `components/CommentsPanel.tsx`) on the selection, the table's cells or the
  board's node; marks in the text (`commentmarks.ts`), the table and the
  board. Tests: `packages/web/test/comments*.test.ts`.
- **Never in the file, only ciphertext on the relay:** the comments are a
  doc of their own, a `meta` file of the room (`internal/protocol/files.go`,
  `packages/protocol/src/files.ts`), synced and encrypted as every file is.
- **Outlive the session, re-anchored:** the host saves them to
  `.pedit/meta/<path>.json` (`internal/session/meta.go`) and finds each place
  again by its saved text (`internal/meta/doc.go`, `Load`). Tests:
  `internal/meta/doc_test.go`, `internal/session/meta_test.go`.
- **Follow edits, from the room or from disk, alike on every peer:** anchors
  are Yjs positions, resolved with `followUndoneDeletions` off; the host
  follows them through every change to the text, its own disk writes
  included (`internal/meta/track.go`), and every peer checks every update to
  the comments by the same rules (`internal/meta/check.go`,
  `packages/protocol/src/meta.ts`), so all hold the same doc.
- **Older clients keep working, no version bump:** a peer leaves out a file
  whose format it does not know (#113), so an older browser or CLI never
  sees the comments' file.

## Not yet

- Following a renamed file (a `pedit doctor` could list and repair).
- Suggestions (tracked changes), as another key of the metadata file.
- Merging edits made to the metadata file on disk while it is shared: pedit
  stops writing it and says so.
- Comments in the Markdown preview, on canvas edges, or in a CLI guest.
- A pending state, for a thread whose content has not arrived yet: it shows
  as gone until it does.
- Comment-only links (#122).
