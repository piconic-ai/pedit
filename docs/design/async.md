# Asynchronous rooms

The polling mode of kept rooms (`pedit --keep-polling`, the `?keep=1` page and
the HTTP endpoints under `/api/rooms/:id/keep/`) was removed in this version.
A kept room is now a live WebSocket room that stays open while the host is
away: see [rooms-away.md](rooms-away.md), which also describes merging local
edits, the resume record and journal, comments, images and limits.
