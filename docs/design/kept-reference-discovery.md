# Conservative retained attachment discovery

The scanner checks one UTF-8 Markdown document for literal image markers. It
accepts only inline `![alt](<directory>/<hash>.<ext>)` forms where the
alt text contains ASCII letters, digits, spaces, dots, hyphens or underscores,
and the filename uses the existing canonical asset format. The directory must
be a safe ASCII component of at most 255 bytes. It also accepts the `&#47;` and `\/` separator
forms used by the preview. It sorts and deduplicates
paths. Any other `!` causes an error, even in plain text, code or an external
image. Code containing an accepted form may produce an extra path; callers must
treat the result as a conservative superset, not an exact rendering.

This depends on the current preview's Markdown image rule beginning with a
literal `!`, with raw HTML disabled. The shared renderer cases document behavior
but do not prove the contract for every Markdown input or future parser version.
Other escapes and entities, reference-style images, canvas and multi-file
identity require further work. Input and marker counts are bounded. The scanner
alone does not prove a complete inventory or permit a recovery save, relay cut,
or acknowledgement. Isolated signed host replay checks the checkpoint and
each applied text update against its declared inventory using this scanner.
It rejects unsupported markers and undeclared candidate paths. That replay is
not connected to room reads or original-file writes.
