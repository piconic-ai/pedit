# Sessions: reconnecting, saving and kept rooms

## When the connection drops

If the connection drops, keep `pedit` running. It reconnects with the same
link and merges edits made while disconnected. The terminal keeps an offline
notice and confirms when syncing resumes. While the host is away, the browser
pauses editing; edits already made or still in transit merge when the host
returns. The public relay keeps guests waiting for up to two minutes. In a kept
room (the default, see [kept rooms](#kept-rooms)), the browser does not pause: the
header says the host is away and until when, text files and their comments stay
editable and images can be pasted, and the relay keeps each edit, which shows as
sending until the relay has it. The host takes the edits in on its return, and
everyone is live again. Closing the page with edits still sending asks first.
Canvas board edits are kept too; its JSON pane is read-only while the host is away.
Do not edit the local `.canvas` file while away: resume refuses external changes instead of merging them.

## Saving

Text, canvas changes, and comments save during the session, including while
edits continue. Saves normally start about a second after the first pending
change. A crash can lose changes still in memory, in transit, or waiting for a
save; failed or slow disk writes can extend that window. Ctrl+C flushes pending
changes and closes the room (a kept room stays open for you to come back to). Without
a keep (`--keep 0`), running `pedit` again creates a new link.

## Kept rooms

A room opened from existing text files is kept for a day by default. When you press Ctrl+C,
pedit saves the files and leaves the room open on the relay, and prints its deadline. Guests stay
connected, the link keeps working, and what they write while you are away waits on the relay,
encrypted, until you are back. In the same project, run `pedit notes.md` again (or `pedit resume`)
to take the room up: pedit connects as the host, merges what you changed in your files meanwhile
with the guests' edits, saves the files, tells the relay it can drop what it held, and carries on as
a live room (Ctrl+C keeps it again). `pedit resume` alone picks the one kept room, or lists them
and asks which (or pass the room ID, `pedit resume <room>`; the room's link works too).
`pedit rooms` lists the project's kept rooms (`--json` for programs), and `pedit close` takes in
the edits and closes the room for good. pedit prints the room's ID as `Room: <id>` under the link, and
when you leave a kept room, so you can name it without picking it out of the link.

`--keep 7d` keeps the room for that long instead (up to the relay's cap, 7 days on the public
relay; pedit reports the effective value). `--keep 0` opens a room that stores nothing and ends
when you leave. To change the default for a project, set `keep: 7d` in `.pedit/config.yaml`
(same syntax as `--keep`; `keep: 0` turns keep off). The command line wins over the config, and
the config over the default. Keep applies to `pedit <file>` and `pedit <file> <file>...` for existing
text and canvas files; a scratch room (`pedit` with no file, `--template`, `--directory`) and
joining a link (`pedit <link>`) are not kept. If a kept room already holds the file, `pedit <file>`
resumes it; its set of files is fixed, so a file it does not hold is an error: run `pedit close`
first, or `pedit --keep 0` for a separate room. A relay that cannot keep rooms (a self-hosted
one that is not updated) ends the room when you leave, and pedit says so. Resume information stays in a
private 0600 record under `pedit/keep/` in your user configuration directory, outside the
project. pedit removes that record when `pedit close` ends the room, when a resume finds the room gone, and at the
next run in the same project for rooms past their deadline (as for rooms kept by an older version of pedit,
which can no longer be resumed), never while a write is pending.
A kept room shares the fixed set of text files it started with (up to 64; no file can be added later), with their comments and pasted images:
guests can paste images (PNG, JPEG, GIF or WebP, within the public relay's image limits) as in a live room, and the relay keeps them,
encrypted, until the room's deadline. On `pedit resume` pedit saves each image the merged text refers to under `assets/`
beside its file, as a live room does, and reports any it cannot find. Guests can comment while you are away, and `pedit resume` writes the threads to
`.pedit/meta/<path>.json` as a live room does, never into the shared file.
The browser uses the same file tabs as a live room. The encrypted snapshot for
all files together, comments included, must fit within 1 MiB; log updates have a separate byte budget. Changes made directly to a local
file while away are merged with the guests' edits on resume, the way a live room
merges a save from another editor. A file that cannot be read or is not valid
UTF-8 is preserved and stops automatic recovery. These two host
commands currently require Unix file permissions and are unavailable on Windows.

## Closing a kept room

To end a kept room before its deadline, run `pedit close` (it takes the same room ID or link as `pedit resume`,
and picks or asks the same way; `pedit close --help` says more). It first does what `pedit resume` does once: takes in the guests' edits, comments and
images and saves them to your files. Only then does it ask the relay to delete everything it holds for the room
(text, log and images) and make the link stop working for good, and remove the resume record. If any
file cannot be saved, the room stays open and the record stays, so you can fix that and run it again. Guests who
have the page open are told that the host closed the room; edits they had not yet sent are lost.

## Joining from the command line

`pedit '<link>'` names each copy itself, from a number and the letters and
digits of the host's name for the file, never as the room names it:
`docs/spec.md` is copied to `01-docs-spec.md`. A canvas comes as its JSON
Canvas, under `.json` (`00-board.json`): edit it as JSON and pedit sends the
changed nodes and edges, as it takes in edits to the host's file. While the
host is away from a kept room, edits to a copy wait until it is back.

The copies end their lines with LF, whatever the host's file uses: a file
whose lines all end in CRLF is shared with LF (the browser editor counts
positions in LF) and saved by the host with CRLF again. A file with mixed
endings is shared as it is, and editing it in the browser may misplace edits.
