# Experimental inventory text update

This internal format is not connected to any room, editor, host recovery, cut,
or acknowledgement. The caller must authenticate the baseline and each record
before replay, serialize persistence, and retain the original ciphertext on
failure. A declaration does not establish inventory completeness, blob
existence, freshness, or that the relay delivered every record.

The record's message bytes are the ASCII domain
`pedit/v6/inventory-text-update\0`, one version byte `0`, a big-endian uint32
length and one Yjs V1 text update, then a big-endian uint32 count and that
many uint32-length-prefixed UTF-8 paths. Paths are canonical
`assets/<32 lowercase hexadecimal>.<png|jpg|gif|webp>`, sorted and unique;
at most 1,024 may be declared in a record or held by replay. No trailing
bytes are accepted. The whole payload is bounded by the existing signed record
payload maximum. A kept edit record signs and encrypts these complete message
bytes; this format has no standalone signature.

The isolated replay model accepts edit records only, rejects legacy messages,
uses the existing sender ledger, adds paths monotonically, validates the Yjs
state, and requires every recognized asset reference to be declared. A repeated
record is not applied twice. Removing a text reference does not remove an
inventory entry. Unknown attachment representations and missing declarations
cannot be proven absent by scanning text, and complete baseline inventory must
be established separately.

To bound the work of this unconnected prototype before ygo applies an update,
replay accepts at most 64 records and 1,024 cumulative Yjs input bytes. This is
not a product limit. Before connecting it to a host or public route, rebase onto
the #273 work-bounded replay implementation and enforce its cumulative text
work budget across checkpoint and tail, with Go/TypeScript interoperability
and adversarial tests. Do not use this prototype to authorize saving, cut, or
ACK.
