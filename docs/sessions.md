# Sessions: dropped connections, saving and kept rooms

This page is for the host, the person who ran `pedit <file>`. It says what
happens when a connection drops, when pedit writes to your files, and how a
room stays open after you leave so that others can go on without you. A guest
needs only [getting started](getting-started.md#leave-and-come-back).

## If the connection drops

Keep `pedit` running. It reconnects with the same link and merges the edits
made while it was offline. The terminal shows an offline notice and says when
syncing resumes. A relay update can drop every connection at once; the same
reconnect covers it, and nothing on anyone's device is lost.

While your connection is down, the relay waits two minutes for you. Guests stay
connected and new ones can join, but nobody can edit. The browser pauses
editing and merges what was already typed when you are back. If you return
within the two minutes, the room carries on as before. If you do not, a room
that is not kept (`--keep 0`) ends, and a kept room goes on without you, as if
you had left with Ctrl+C ([kept rooms](#kept-rooms)).

A guest whose connection drops reconnects the same way. A guest who reconnects
before the host waits the same two minutes.

## Saving

pedit writes text, canvas changes and comments to your files during the
session, while edits continue. A save normally starts about a second after
the first pending change. Ctrl+C writes the pending changes before pedit
leaves.

A crash loses the changes still in memory, in transit, or waiting for a save.
Failed or slow disk writes make that window longer.

## Kept rooms

A room opened from existing files is kept for a day after you leave: the link
keeps working, and what others write meanwhile waits on the relay, encrypted,
until you are back. Without a keep (`--keep 0`), Ctrl+C closes the room:
guests are disconnected, the link stops working, and running pedit again makes
a new link.

### Leaving

Press Ctrl+C. pedit saves the files, leaves the room open on the relay, and
prints the room's ID and its deadline, with the command that takes the room up
again. The ID also appears as `Room: <id>` under the link when the room
starts, so you can name the room without picking it out of the link.

### While you are away

In the browser, the header says the host is away and until when. Text files
and their comments stay editable, images can be pasted, and the canvas board
can be edited; the canvas's JSON pane is read-only until you are back. Each
edit shows as sending until the relay has it, and closing the page with edits
still sending asks first. A guest on the command line (`pedit <link>`) takes
part the same way. The relay keeps all of it encrypted and cannot read it.

### Coming back

In the same project, run `pedit <file>` again, or `pedit resume`. pedit
connects as the host and merges what the guests wrote with your file, changes
you made to the file meanwhile included, the way a live room merges a save
from another editor. It saves the files, tells the relay it can drop what it
held, and carries on as a live room. Ctrl+C keeps the room again.

- `pedit resume` alone takes up the project's only kept room, or lists them
  and asks which. `pedit resume <room>` names one by its ID or its link.
- `pedit rooms` lists the project's kept rooms (`--json` for programs).
- Comments made while you were away go to `.pedit/meta/<path>.json`, as in a
  live room ([comments](comments.md#where-they-are-saved)). Images the merged
  text refers to are saved under `assets/` beside the file, and pedit reports
  any it cannot find.

### How long a room is kept

- A day, counted from the moment you leave, unless you say otherwise.
- `--keep 7d` keeps it longer, up to the relay's cap: 7 days on the public
  relay. pedit prints the value the relay settled on.
- `keep: 7d` in `.pedit/config.yaml` changes the default for a project, and
  `keep: 0` turns it off ([configuration](configuration.md)). The command line
  wins over the config.
- A room lives at most 7 days from when it was first opened, however often
  you come back; a keep never reaches past that.
- Your own connection lasts at most 24 hours at a time. Coming back to a kept
  room starts a new 24 hours.

### Which rooms are kept

A keep applies to `pedit <file>` and `pedit <file> <file>...` with existing
text and canvas files. These rooms are not kept:

- A scratch room: `pedit` with no file, `--template` or `--directory`
  ([templates](configuration.md#templates-and-new-notes)).
- A room you join with `pedit <link>`.
- A room hosted on Windows. The private record below needs Unix file
  permissions, so there a room ends when you leave, and `pedit resume` and
  `pedit close` are not available.
- A room on a relay that cannot keep rooms, such as a self-hosted one that is
  not updated. The room ends when you leave, and pedit says so at the start.

### The files of a kept room

- The set of files is fixed when the room opens; no file can be added later
  ([several files in one room](getting-started.md#several-files-in-one-room)).
  If a kept room already holds a file, `pedit <file>` resumes that room. A
  file the room does not hold is an error: run `pedit close` first, or
  `pedit --keep 0 <file>` for a separate room.
- You can edit a text file while you are away. On resume, pedit merges your
  changes with the guests' edits. Do not edit a `.canvas` file while away: a
  resume refuses external changes to it instead of merging them.
- A file that cannot be read, is not valid UTF-8 or is over the size limit is
  left alone: pedit does not write the room's edits into it. Fix the file,
  then resume again.
- The encrypted snapshot of all files together, comments included, must fit
  in 1 MiB. Edits made while you are away have a budget of their own
  ([limits](public-relay.md#limits)).

### The resume record

pedit remembers how to take a room up in a private file (mode 0600) under
`pedit/keep/` in your user configuration directory, outside the project. It
removes the record when `pedit close` ends the room, when a resume finds the
room gone, and at the next run in the same project for rooms past their
deadline, never while a write is pending. A room kept by an older version of
pedit cannot be resumed and is removed the same way.

## Closing a kept room

`pedit close` ends a kept room before its deadline. It names the room as
`pedit resume` does, and `pedit close --help` says more. It first does what a
resume does once: takes in the guests' edits, comments and images and saves
them to your files. Only then does it ask the relay to delete everything it
holds for the room (text, log and images), make the link stop working for
good, and remove the resume record. If a file cannot be saved, the room stays
open and the record stays, so you can fix that and run it again. Guests who
have the page open are told that the host closed the room; edits they had not
yet sent are lost.
