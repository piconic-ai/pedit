# Canvas while the host is away

The current canvas document keeps nodes and edges in Y.Arrays. Reordering a
node deletes its Y.Map and inserts a new one. If a second peer edits the old
map concurrently, the rendered canvas can lose that edit. If two peers move
the same node concurrently, the array can contain duplicate IDs. The tests
`TestConcurrentReorderCanHideTextEdit` and
`TestConcurrentReordersCreateDuplicateRecords` characterize these failures.
They must become convergence tests when the representation changes.

The host currently validates JSON pane edits and answers each request. A room
without a host cannot use that exchange to make those edits visible. Moving
the current algorithm to each browser would expose the concurrent failures
above. A replacement must support JSON and board edits against the same shared
state before the host returns.

## Candidate representation

Store each node and edge under an immutable internal instance ID. Its fields
and text stay in the same Y.Map and Y.Text when its position in the file order
changes. Keep order separately and use the internal ID to break ordering ties.
Use distinct, versioned root names; a Y.Array and a Y.Map cannot share a root
name. Export the existing JSON Canvas arrays without the internal IDs or
ordering metadata, preserving unknown fields and top-level data.

The exact ordering algorithm, deletion and restore semantics, and conflict
resolution remain open. In particular, a deletion concurrent with an edit,
two additions with the same public ID, and an edge added to a deleted node
must not silently discard data. A conflict must stop a save that would lose
data and give the user a way to resolve it. Undo and comments must not attach
an operation or anchor to the wrong instance after deletion or restoration.

## Compatibility

The current browser reads the array roots directly. It also scopes Undo and
deep observation to those arrays, and comments refer to public node IDs. The
host uses the same arrays for file loading, JSON edits and external file
merges. The browser and host must switch together, including those callers.
Do not write both representations independently: they would diverge under
concurrent edits.

An unknown canvas format cannot simply be sent to older browsers, which may
treat it as text. A global protocol version bump would also reject older
clients from rooms that do not use the new model. Design and test room-level
version negotiation and a rolling deployment before enabling the new model.
An existing file remains ordinary JSON Canvas on disk.

## Verification

Exchange updates between Go and browser peers and check both the shared state
and exported file. Cover concurrent moves of the same node, move versus text
edit, delete versus edit, duplicate public IDs, and edge creation versus node
deletion. Cover undo, comments, unknown fields, external disk edits and both
old and new clients during a rolling deploy. Replay and recovery tests must
also establish that retries do not create a second operation.
