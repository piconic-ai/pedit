# Internal signed inventory replay

This prototype is not connected to Room read, the editor, host file writes,
cut, or acknowledgement. It accepts a host-signed encrypted checkpoint whose
plaintext has the domain `pedit/v6/inventory-checkpoint\0`, version byte zero,
and a canonical multi-checkpoint payload. The prototype accepts exactly one
text document and its metadata. The signed payload declares an inventory; a
signature authenticates that declaration, not its completeness or the existence
of the blobs. Existing single-text or multi-checkpoints do not select this mode.

Each supplied ciphertext frame is opened with the checkpoint's room, epoch and
generation. Only editor records in the versioned inventory text-update format
are supported. The format is checked even on duplicate receipts; legacy, unknown,
comment and malformed records fail closed. The existing ledger validates sender
sequence and duplicates. Applying text, inventory additions and ledger changes
takes place only in an isolated candidate; a failure returns no observation.

The #273 text work budget applies to the checkpoint and all applied tail
updates together, before each ygo application. The existing multi-checkpoint
validation also checks text and metadata work before applying checkpoint states.
A conservative reference scan checks supported inline image paths against the
inventory at the checkpoint and after each update. It rejects unsupported image
markers and can require extra paths for images appearing in code. It cannot
attest that inventory is complete. Observations do not prove that the relay delivered all records, that
blobs remain available, or that either output has been durably saved. Explicit
version negotiation, full reference enumeration, blob verification, metadata
updates and crash-durable storage are separate prerequisites for integration.
