# Internal multi-file checkpoint payload

This internal format is separate from the existing single-text checkpoint. It is
not connected to publication, recovery, the UI, or acknowledgements.

The authenticated plaintext starts with `pedit/v6/multi-checkpoint\0`, a zero
version byte, and length-prefixed fields. Lengths and counts are unsigned
32-bit big-endian integers. The fields are the canonical Files manifest, one
complete Yjs V1 update per manifest entry in manifest order, an attachment
count followed by that many length-prefixed UTF-8 attachment paths, and the
encoded kept ledger. No trailing bytes are allowed. The complete payload remains
subject to the existing checkpoint size limit.

Each text entry must have exactly one metadata entry with the corresponding
`metaPath`, file ID 0 must be text, and every manifest entry must have exactly
one state. Text and comments use the existing strict schema checks. Canvas and
unknown formats are rejected until their complete state models are defined.

The attachment inventory is a sorted, unique list of canonical
`assets/<32 lowercase hex>.<png|jpg|gif|webp>` paths, with at most 1024 paths.
Every matching reference in each text state must appear in it; unreferenced
inventory entries are retained. Go callers must provide a non-nil inventory,
even when empty. An inventory is an attestation by the caller: these codecs
cannot prove it includes all attachment sources, that the corresponding blobs
exist, or that the states, inventory and ledger were captured atomically. A
future publisher and recovery implementation must establish these properties
before accepting or acknowledging a checkpoint.
