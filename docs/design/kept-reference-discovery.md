# Conservative retained attachment discovery

This unconnected prototype scans one UTF-8 Markdown document for literal image
markers. It accepts only inline `![alt](assets/<hash>.<ext>)` forms where the
alt text contains ASCII letters, digits, spaces, dots, hyphens or underscores,
and the path uses the existing canonical asset format. It sorts and deduplicates
paths. Any other `!` causes an error, even in plain text, code or an external
image. Code containing an accepted form may produce an extra path; callers must
treat the result as a conservative superset, not an exact rendering.

This depends on the current preview's Markdown image rule beginning with a
literal `!`, with raw HTML disabled. The shared renderer cases document behavior
but do not prove the contract for every Markdown input or future parser version.
Different directories, reference-style images, escapes, entities, canvas and
multi-file identity require further work. Input and marker counts are bounded.
Do not use this prototype to claim a complete inventory, permit a recovery save,
or acknowledge or cut relay history.
