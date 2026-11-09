# Configuration and templates

Without configuration, the public server and built-in defaults work
immediately. A project can set its own server, where new notes go, how long
rooms are kept, and the templates new notes start from.

## `.pedit/config.yaml`

Run `pedit` at a Git repository root to create `.pedit/config.yaml` and
`.pedit/templates/` with editable Markdown, CSV, and Canvas defaults.

```yaml
server: https://edit.piconic.ai
output: notes
keep: 7d   # optional: how long pedit <file> keeps its room (1d if unset, 0 turns it off)
```

- `server`: the relay that receives the encrypted file and serves the editor.
  Set it here rather than with `PEDIT_SERVER`. pedit refuses a configuration
  file that another user owns, but not one that came with a repository you
  cloned, so read it as you would a Makefile before running pedit there.
- `output`: where notes made from a template go, relative to the project.
- `keep`: the default for `--keep` ([sessions](sessions.md#kept-rooms)). The
  command line wins over the config, and the config over the default.

Configuration is found from the current directory up to the Git root.

## Templates and new notes

Add your own template files directly to `.pedit/templates/`:

```sh
pedit                          # notes/pedit-<time>.md
pedit --csv                    # notes/pedit-<time>.csv
pedit --canvas                 # notes/pedit-<time>.canvas
pedit -t minutes.md             # notes/minutes-<time>.md
pedit -t minutes.md -d meetings # meetings/minutes-<time>.md
```

`-t` / `--template` selects a template; `-t csv` and `-t canvas` select
`default.csv` and `default.canvas`. `-d` / `--directory` overrides `output`
and is relative to the current directory. New files get a timestamp and a
counter if needed. Existing files are preserved.

`.canvas` files use [JSON Canvas](https://jsoncanvas.org/), an open format for
whiteboard-style diagrams.

A note made from a template is a scratch room: it is not kept after you leave
([sessions](sessions.md#kept-rooms)).
