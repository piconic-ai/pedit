# Kept browser crash recovery test

From `packages`, run `node worker/test/browser-kept-recovery/run.mjs` after
installing workspace dependencies. Node.js 22 or newer, a local Chromium or
Chrome binary, and permission to bind loopback ports are required. Set
`CHROME_BIN` to the browser executable; the default is the macOS Chrome path.
The script uses a temporary browser profile, Worker storage, and test-only
routes; it does not deploy or contact a public relay.

The test seeds a signed text checkpoint in a real local Room Durable Object,
drives the production Yjs editing controller, simulates an initial persistence
failure, retries into real browser IndexedDB, and simulates a lost response
once Room accepts the append. It forcibly terminates Chrome, restarts the same
profile, and checks that the default browser fetch resends identical ciphertext,
the relay has one record, and the local ACK survives reopening IndexedDB. It
reads the checkpoint and tail from Room and checks the restored text. The read
is deliberately marked `tail-unverified` and `applicable: false`: this test does
not establish completeness against a malicious relay or exercise the product UI.

The earlier unpublished experimental database format from commit 67d6d8f is
not migrated. This test uses disposable profiles; do not use that experimental
store for data that must be retained.

The test-only page also mounts CodeMirror against the kept controller. It
checks pending, failure, and relay-receipt wording, keeps rejected input in a
copyable draft, and restores the editor when the controller rejects an edit.
This harness is not the product UI and does not enable a public v6 route.
