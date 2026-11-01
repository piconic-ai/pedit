# serve-app

A sample local app whose editor is bound to the document that `pedit serve`
holds (experimental, issue #372). There is no room and no relay: pedit listens
on a Unix socket only, the app's own server on `127.0.0.1` forwards the page's
WebSocket to it frame for frame, and pedit alone writes the file.

## Run

```sh
npm install
node app.mjs notes.md        # notes.md must exist; PEDIT=/path/to/pedit if not on the PATH
```

It prints `http://127.0.0.1:<port>/<token>/`. Open it. The token is a secret
generated for each run; the bridge refuses any connection without it, so other
users on the machine cannot reach your file. Do not share the URL. Ctrl+C in the terminal saves the
file and removes the socket and the lock.

## What to try

- Type in the page: `notes.md` is written about a quarter second after you stop.
- Save `notes.md` from another editor, with no dialog: the page takes the
  change in as an edit, and what you typed meanwhile is kept unless you both
  changed the same words.
- Open the page in two tabs: edits and cursors show in both.
- Run `pedit serve notes.md` in a second terminal: it is refused, naming the
  holder (`pid ..., app "sample"`). Kill the app with `kill -9` and run it
  again: the stale lock (`.notes.md.pedit-lock`) is taken over.
- Try a file with CRLF line endings, a BOM or YAML frontmatter: the file keeps
  its bytes.

## What to look at

- `app.mjs`: starts `pedit serve --json --app sample`, reads the socket path
  from the `listening` event, serves the page, and bridges the sockets. A
  `held` or `error` event (pedit's exit code 3 or 1, which the app passes on)
  is printed as a line before the app ends; `saved` and `external_save` also
  exist (see `pedit serve --help`) but the sample does not use them. pedit ends when this process does, because its stdin is a pipe.
- `page.mjs`: CodeMirror 6, y-codemirror.next and y-websocket's
  `WebsocketProvider`, unchanged, on `doc.getText('content')`.
