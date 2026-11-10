# Comments

People in a room can comment on what they see without changing the file. This
page says how comments work in the browser, where the host keeps them, and how
a script or an AI agent reads and answers them from the command line.

## In the browser

Select some text, a cell of a table (or a whole row or column), or a node of a
canvas; a small button appears beside the selection (or press the shortcut)
and opens a composer right there. Everyone in the room sees the comment at
once, marked where it points. The panel beside the editor lists the threads,
where anyone can reply or resolve them; resolved threads stay under Resolved,
to read again or reopen. You can edit or delete your own comments from their
⋮ menu (deleting asks first).

In a Markdown file you can also select text in the preview, in Split or
Preview mode. The comment goes on the Markdown from the first to the last
character you selected, with any marks between them: a selection that runs
past both ends of a bold word quotes its `**` as written. When the preview cannot place the start or
the end exactly in the Markdown (an HTML entity, say), no button appears;
select the text in the editor instead.

Each file's tab (or its name, in a room of one file) shows how many of its
comments are still open. The speech bubble in the header, or Ctrl/⌘+Alt+M,
shows or hides the comments.

A comment follows its place as people edit, and says so when that text changed
or is gone. A comment goes on up to 1,000 characters of text, or of a cell.
[The design](design/comments.md) says how comments are anchored.

## Where they are saved

A comment never goes into the file. The host keeps the comments of each file
in `.pedit/meta/<path>.json`, and the next session shows them again, found by
the text, cells or node they pointed at.

Comments are kept for files inside the project: the directory of
`.pedit/config.yaml`, or the one you run pedit in when there is none. Commit
`.pedit/meta/` to keep them with the files; that also publishes them, with the
names people gave, to whoever can read the repository. Anyone with an edit or
comment-only link can change or delete any comment, not only their own: the
editor only hides the buttons.

## From scripts and agents

A script or an AI agent can read and answer comments without a browser. It
runs the session itself, with `--json`, and reads what happens in the room
as JSON lines on stdout (messages for people go to stderr):

```sh
pedit notes.md --json --name tate-pm &   # {"event":"ready",...}, then
                                          # {"event":"comment","thread":"…","body":"…",...}
pedit comments list                       # the open threads (--all, --json)
pedit comments reply <thread> "Done."     # prints the reply's id
pedit comments resolve <thread>           # or reopen
```

The `pedit comments` commands talk to the session running on the same
machine, so the agent is one participant, named by `--name`. An agent that is
a guest does the same with `pedit <share link> --json`. With no session
running, `pedit comments list --file notes.md` lists the comments as the host
saved them last. `pedit comments --help` says more, and
[the design](design/comments-cli.md) how it works.

An app that embeds pedit takes part in comments the same way, through
[`@pedit/serve`](../packages/serve/README.md#comments).
