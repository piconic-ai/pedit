# Host recovery credentials

The internal host credential store saves the relay origin, room ID, host token,
editor secret, host signing seed, and last accepted checkpoint generation. It
derives the room keys locally. The caller must verify the checkpoint and make
its recovery state durable before advancing the generation. This store does not
persist the checkpoint, ledger, pending edits, or attachment inventory.

The implementation is available only on local APFS on macOS; other platforms
and uninspectable filesystems fail closed. It creates a dedicated directory,
sets and checks an explicit empty ACL before putting secrets inside it, checks
owner and mode, and holds an exclusive process lock until close. Existing
unverified directories, symbolic links, hard-linked credential files, invalid
records, changed identities, and decreasing generations are rejected. Records
are written through an exclusive temporary file, synced with `fsync` and
`F_FULLFSYNC`, renamed, and followed by directory synchronization. A failed
sync returns an error; after a failure following rename, the caller must reload
and reconcile the complete record under the lock.

The caller must put the directory under a parent that other users cannot move,
replace, or use to access it. This implementation does not prove every parent
ACL or defend against a process running as the same user. The tests establish
process termination behavior, not power-loss durability: macOS does not provide
an established guarantee here that a synced directory rename survives power
loss. Filesystem, hardware, or backup rollback can also restore an older whole
record without detection. A backup containing the directory contains secrets.

The store is an internal API and is not wired into the CLI, room creation, or
resume. It must not be taken as evidence that the host can yet recover a room
or acknowledge guest operations safely.
