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
  file; it is a name for the pairing, not where the file is on disk.
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
| `messages` | a Y.Map of comments keyed by a random id, each `{author, time, body}`; `time` is RFC 3339 in UTC |

Comments are shown by `time`, then by id. Names are self-chosen and say nothing
about who wrote a comment.

### Anchors in a session

Each kind of file anchors on what survives its edits:

- **Text and Markdown:** two Yjs RelativePositions on the content's Y.Text,
  the start with assoc 0 and the end with assoc -1, so text typed at either
  edge stays outside. Positions are resolved with `followUndoneDeletions =
  false`, so every peer agrees after an undo.
- **CSV and TSV:** a cell is a range of the same Y.Text, plus positions of the
  delimiters and line breaks around it. The cell is deleted when its range has
  collapsed and one of those characters is gone; a value rewritten in place
  only collapses the range. A range of cells is its two corner cells.
- **Canvas:** the node's `id`. Stacking changes and undo replace a node's
  Y.Map, but keep its id.

A thread is **attached** when its anchor resolves to what the quote says,
**changed** when it resolves to something else, **detached** when its place is
gone, and **pending** while the content it names has not arrived.

## The next session

RelativePositions mean nothing in a new session: every run builds a new Y.Doc
from the file. So the metadata file keeps where each anchor was at the last
save, as a W3C TextQuoteSelector with a position as a hint:

```json
{"type": "text", "exact": "world", "prefix": "hello ", "suffix": "!", "offset": 6}
```

`prefix` and `suffix` hold up to 32 characters, and `offset` counts UTF-16 code
units, as Yjs does. A CSV anchor holds one of these per corner cell
(`{"type": "cells", "from": ..., "to": ...}`), and a canvas anchor is
`{"type": "node", "id": "n1"}`.

When the host loads the file, before the room opens, it finds each `exact` in
the file. Context, then closeness to `offset`, decide between several matches.
It then writes the thread's RelativePositions into the doc. Re-anchoring
happens once and on the host, so every peer starts from the same anchors. Text
that is not found leaves its thread detached, with its last saved place kept
for the next try.

## Input from other people

Everything in the metadata doc, and in the file on disk, may come from someone
else: a guest, or a teammate through Git. Every peer checks it the same way.

- Limits: 500 threads, 200 comments in a thread, 4,000 characters in a body,
  200 in a name, 1,000 in a quote, 1 MiB for the file.
- Names, bodies and quotes are shown as text, never as HTML, with control and
  bidi characters removed.
- Updates to the doc are bounded per update and per client, and an update with
  a gap in its clocks is dropped, so a hostile client cannot make a peer send
  frames the relay refuses.
- A metadata file that breaks these rules is left untouched, and its shared
  file offers no comments.

## Not yet

- Following a renamed file (a `pedit doctor` could list and repair).
- Suggestions (tracked changes), as another key of the metadata file.
- Merging edits made to the metadata file on disk while it is shared: pedit
  stops writing it and says so.
- Comments in the Markdown preview, on canvas edges, or in a CLI guest.
- Comment-only links (#122).
