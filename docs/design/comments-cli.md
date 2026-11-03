# Comments from the command line

How a script or an AI agent reads, answers and resolves comments (#121) on a
shared file without a browser (#212), and how it names itself (#213). The
comments themselves work as `comments.md` says; this is only another way in.

## Goals

- **No flicker.** The agent is one participant, present for as long as it
  works, under a name of its own. A command that joins and leaves the room each
  time it runs would make people appear and vanish in everyone's list.
- **One way into the room.** The live connection of a session (`pedit <file>`
  or `pedit <share link>`) is the only one. No polling, no second transport to
  the relay, nothing kept rooms had and gave up (#344).
- **Nothing more on the relay.** The agent as host costs nothing extra; as a
  guest, what a browser tab costs.
- **Least privilege.** A comment link is enough to read and answer comments.

## Shape

One long-lived session holds the room. Short commands reach it on the same
machine, and the session tells what happens in the room on its standard
output:

    pedit notes.md --json --name tate-pm        # host, events on stdout
    pedit <share link> --json --name tate-pm    # guest, the same events
    pedit comments [list] [--room ID] [--file PATH] [--all] [--json]
    pedit comments reply [--room ID] [--file PATH] <thread-id> <text | ->
    pedit comments resolve|reopen [--room ID] [--file PATH] <thread-id>

An agent starts the session in the background, reads its events, and runs the
short commands when it acts. The short commands never connect to the relay.
Without a running session they fail and say how to start one, except `list`,
which then reads what the host saved last (below).

Starting a thread is not offered: an anchor is a place the browser selects,
and a reply, resolving and reopening are what #212 asks for.

## The name (#213)

`--name <name>` sets the session's name, for the host and for a guest. It is
the name in presence, the `author` of every comment the session writes, and
nothing else: names are self-chosen and say nothing about who wrote a comment
(`comments.md`), so the account behind a session stays what the link tier
shows. Without it the name is the user's login name, as today. It is cleaned
as the browser cleans one (control and bidi characters removed) and cut to 200
UTF-16 code units.

A browser session can set its name in the editor; that is #213's other half,
out of this design.

## Events

With `--json` a session prints one JSON object per line on stdout and nothing
else there; everything for people goes to stderr. Events are about the room as
this session sees it:

| Event | Fields |
| --- | --- |
| `ready` | `session` (its id, below), `room`, `access` (`edit`, `comment`), `files` (paths as the room shows them), and for the host `links` (`edit`, `comment`, `read`) |
| `comment` | `file`, `thread`, `message`, `author`, `time`, `body`, `quote`, `anchor` (`{"type":"text"}`, `{"type":"cells"}` or `{"type":"node","id":...}`), `new_thread` (the first comment of a thread) |
| `edited` | `file`, `thread`, `message`, `body` |
| `deleted` | `file`, `thread`, `message` (`message` empty when the thread went) |
| `resolved`, `reopened` | `file`, `thread` |
| `status` | `status`: `connecting`, `connected`, `waiting` or `kept` (the host is away), `disconnected`, or why the room ended (`closed`, `expired`, ...) |
| `ended` | `reason`: `stopped`, or the status the room ended with; the last event |

- A change is reported once it is in the session's doc: from the room, from
  the browser on the same machine, or from a short command. The session's own
  writes are reported too, so an agent reading only events sees everything.
- Comments the session found when it started (on disk for the host, in the
  room for a guest) are not events; `pedit comments list` shows them.
- Events come from the comments doc's update hook: the session reads the
  threads before and after each update (`meta.Read`'s rules, without anchors)
  and reports what differs. Text is shown as in the browser: control and bidi
  characters removed.
- The share link is printed on stdout only by the host, as it is today without
  `--json`. The key never leaves the machine but in the link people are given.

## The local channel

A session started with `--json` registers itself in its own directory:

    <UserConfigDir>/pedit/sessions/<session id>/
        session.json      written once, 0600: version, pid, room, access,
                          project (host), files, name
        lock              held by the session while it runs
        req/  res/        requests and their answers

- **Where.** Beside the kept rooms' records (`<UserConfigDir>/pedit/keep/`),
  which already hold room keys: the same trust boundary, the user's own
  configuration directory. The directories are created `0700`; on Windows,
  where there is no mode, owned by the user's SID and checked as
  `internal/fileowner` checks configuration. `session.json` holds no key.
- **The id** is 16 random bytes in hex, new for every session: a host and a
  guest of one room on one machine are two sessions.
- **Alive** means its lock is held (`internal/serve`'s lock: `flock`, or
  `LockFileEx` on Windows). A directory whose lock is free belongs to a session
  that ended without cleaning up; the next command removes it. A session
  removes its directory when it stops.
- **A request** is `req/<nonce>.json`, written to a temporary name in `req/`
  and renamed, so the session never reads half of one:

      {"version": 1, "op": "reply", "file": "docs/spec.md", "thread": "...", "message": "...", "body": "..."}

  `op` is `list`, `reply`, `resolve` or `reopen`; `file` is a path as the room
  shows it, and may be empty. `message` is the id of the reply, chosen by the
  command (16 random characters, as the browser makes one) or given with
  `--id`, so a reply sent twice is written once (see Writing). A request names no path on disk and opens
  nothing: it acts only on the comments docs the session already shares, with
  the session's name. The session takes a request only if it is a regular file
  in `req/` (no link), of at most 64 KiB, and parses under the checks of
  `internal/meta` (exact keys, limits).
- **Taking a request.** The session renames `req/<nonce>.json` to
  `work/<nonce>.json` before it acts on it, and a command that gives up
  renames its request out of `req/` the same way. Only one rename succeeds,
  so a request is either taken or withdrawn, never both.
- **The answer** is `res/<nonce>.json`, written the same way, then the
  request is removed:

      {"version": 1, "ok": true, "message": "...", "delivered": true}
      {"version": 1, "ok": false, "error": "no thread abc in this room"}

  `list` answers with the threads, as `pedit comments list --json` prints
  them. The command waits for the answer with fsnotify, then removes it.
  The session answers every request it took within 15 seconds: the delivery
  wait below is 10. The command waits 30 seconds; then, if it can still
  withdraw its request, nothing was written, and it says so (exit 1). If the
  session had taken it, the outcome is unknown (exit 4), and the command says
  how to retry safely: the same command with `--id <message id>`. The
  session watches `req/`
  with fsnotify, as it watches the shared files, and also reads it once on
  start and every time the watch reports an overflow.
- **Choosing a session.** Without `--room`, a command takes the only live
  session; with several, it lists them (room, files, name) and asks for
  `--room`. A thread id names a thread in one file's doc: if two files of the
  room have one by that id, the command asks for `--file`.

Why not a socket: a listening socket is a second transport to keep on every
platform (pedit serve gave up its Unix socket for Windows, `serve.md`), and on
macOS a listener can bring up the firewall's question. A directory in the
user's configuration needs only what pedit already uses: atomic renames,
fsnotify, the lock, and the owner check.

## Writing

The session writes as the browser does (`packages/web/src/comments.ts`), in
Go (`internal/meta`): a reply is a message `{author, time, body}` under the
request's id in the thread's `messages` map; resolving sets `resolved`. A
reply whose id the thread already holds, with the same author and body, is
done already: the session answers as if it wrote it, and writes nothing. With
another author or body it is refused. Resolving a resolved thread, or
reopening an open one, writes nothing either. The same
limits hold (4,000 UTF-16 code units in a body, 200 comments in a thread), and
the update passes `meta.CheckUpdate` before the session applies it, as every
peer's does.

When the request is answered:

- **The host** applies the write to its own doc; the room is its doc, so the
  answer says `delivered` at once. The write is saved to `.pedit/meta` as any
  change of the comments is: the host now schedules a save for its own
  changes too, not only the room's (`internal/session/meta.go`).
- **A guest** answers `delivered` once the host has applied the write: the
  host saves comments, so another peer having it proves nothing about
  `.pedit/meta`, and every peer checks and may refuse an update on its own.
  - What is confirmed is that the host has every struct the session's
    comments doc has, once the request is done: the item that holds what
    the request asked for (the reply's message under its id, or the
    thread's `resolved` value) is among them, whether this request wrote it
    or the doc already held it. So a retry is confirmed the same way as the
    first try, and no item has to be named (ygo gives no ids of map
    entries).
  - The session sends a SyncStep1 with its state vector lowered by one for
    every client. A peer that writes the doc answers it (`room_files.go`)
    with everything it has past that state: for each client, the answer
    reaches the session's clock if, and only if, the peer has every struct
    of that client the session has. (An answer to the current state vector
    leaves the session's structs out either way.) The answer's own state
    vector (`EncodeStateVectorFromUpdate`) tells that without applying it,
    and it holds one struct a client, or more, so it stays small.
  - Deletions follow: a map entry deletes the entry it overrides when it is
    integrated, on every peer, and a reply deletes nothing.
  - Only the host's answer counts. The Client remembers which sender each
    awareness state came in, and the host is the editor whose state says
    `role: host`, as `join.go` finds it. An editor could claim the role, but
    an edit link can rewrite every comment anyway.
  - The SyncStep1 is sent again every second until the host's answer covers
    the session's doc, as the host may not have taken the guest's frames yet
    (`fresh.go`). After 10 seconds without it the session answers
    `delivered: false`: the update stays in the session's doc and reaches the
    room as every unsent update does; it is not an error. A test runs a
    guest whose host never applies the write and checks that the command
    gets this answer, not a timeout.
- **A guest while the host is away** (a kept room): the write is a kept
  entry, as the browser sends one (below), and `delivered` once the relay
  logged it: it comes back as kind 4, and the host takes it in when it
  resumes. A comment link cannot write while the host is away, in the
  browser as here: the session answers `host away` and writes nothing, as it
  does in the two minutes of grace before a room is kept.

## Guests while the host is away

A command line guest takes part in a kept room as the browser does
(`packages/protocol/src/kept-away-client.ts`, `rooms-away.md`), so an agent
can read and answer comments while the host is away, and the host finds them
when it resumes. The checks and the formats are the host's own
(`OpenKeptBundle`, `OpenKeptFileUpdate`, `SealKeptFileUpdate`, the kept
document checks, `meta.CheckUpdate`).

- **Joining.** A guest that joins while the room is kept has no host to
  answer it: it is in the room once the relay's replay ends (kind 6). The
  bundle (kind 5) names the files, as the host's manifest does (a file whose
  path is the metadata path of another holds its comments), and gives each
  its content; the first file's copy is made from it.
- **What the relay holds.** For each file the guest keeps a copy of what the
  relay holds (the snapshot and the log), to check entries against and to
  tell what the relay lacks.
- **Entries in.** A kind 4 entry is opened (the editors' signature), checked
  against the copy as the host checks one (its roots, nothing left waiting,
  `meta.CheckUpdate` for comments), and applied to the copy and to the
  guest's doc; one that does not hold is skipped. Its id is the guest's
  cursor.
- **Entries out.** While the room is kept, what an editor's session changes
  in a doc (its copy of a file, or its comments) goes to the relay as a kind
  1 entry, sealed and signed, not as a live update. It is pending until it
  comes back as kind 4. After each replay the guest sends, as entries, what
  its docs hold that the relay lacks: changes made while it was not
  connected.
- **Live, then kept.** A guest that was in the room when it became kept has
  no replay: on `kept` it connects again, with its cursor as the `after`
  query parameter, as the browser does.
- **Host back.** On `host back` the guest drops its copies and pending
  entries and greets the room as on connecting: the host reconciles by sync.

## Guests from the command line

`pedit <share link>` takes a comment link as well as an edit link. With a
comment link the copies of the files are not watched, and pedit says that edits
to them are not sent (the relay and every peer refuse them anyway). The
comments docs are joined as the browser joins them: a
`meta` entry of the manifest paired with its file by `protocol.MetaFiles`, kept
in sync with `AddCommentsFile` and checked with `meta.CheckUpdate`. A guest
never writes `.pedit/meta`: the host is the only one that saves comments.

A read link stays refused: it can neither comment nor edit, and an agent that
only reads has nothing to answer.

A canvas (the first file of the room, or another) is copied as its JSON
Canvas, rendered from the doc's nodes and edges (`canvas.Render`), under
`.json`: an app that opens `.canvas` may show what its nodes link to. An
edit to the copy is taken in as the host takes in an edit to its file
(`canvas.Apply`), so a canvas room is open to an agent that is a guest, and
its comments are on node ids as in the browser. Edits typed as JSON in the
browser stay the host's to answer.

## Listing without a session

`pedit comments list --file <path>` with no live session reads the metadata
file the host saved, `.pedit/meta/<path>.json`, found as the host finds it, and
prints its threads. It writes nothing. It says the list is as the host saved
it, which may be older than the room.

## Output

`pedit comments list` prints open threads, oldest first: the id, the file, the
anchor (the node id, or the quote cut to one line), and each comment's author,
time and body. `--all` adds resolved threads. `--json` prints

    [{"file": "...", "thread": "...", "anchor": {...}, "quote": "...",
      "resolved": false, "messages": [{"id": "...", "author": "...",
      "time": "...", "body": "..."}]}]

with threads and messages in the order the browser shows them.

`reply` prints the new message's id. Exit codes: 0 done, 1 error (nothing
written), 2 usage, 3 written but not confirmed as delivered (a guest's
`delivered: false`), 4 the outcome is unknown (the session took the request
but did not answer in time). After 3 or 4, the same command with `--id` is
safe to run again.

## Order of work

1. This design.
2. `--name`, and `--json` events: the status and lifecycle of host and
   guest sessions, and the host's comment events. A guest reports comment
   events once it joins the comments docs, in step 4.
3. The local channel and `pedit comments list|reply|resolve|reopen` for the
   host, with the host saving its own writes.
4. Guests: comment links, the comments docs, `delivered`.
5. Guests while the host is away: kept entries from Go (after step 6 in the
   stack of pull requests).
6. `pedit comments list` without a session.
