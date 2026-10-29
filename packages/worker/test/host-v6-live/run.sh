#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/pedit-host-read.XXXXXX")
port=$(node -e "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close() })")
pid=''
cleanup() {
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf "$test_dir"
}
trap cleanup EXIT INT TERM
cd "$root/packages/worker"
XDG_CONFIG_HOME="$test_dir/config" pnpm exec wrangler dev --config test/host-v6-live/wrangler.jsonc --local --port "$port" --persist-to "$test_dir/state" >"$test_dir/wrangler.log" 2>&1 &
pid=$!
ready=false
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then ready=true; break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat "$test_dir/wrangler.log"; exit 1; fi
  sleep 0.25
done
if [ "$ready" != true ]; then cat "$test_dir/wrangler.log"; exit 1; fi
cd "$root"
PEDIT_TEST_LIVE_ROOM="http://127.0.0.1:$port" go test ./internal/keptclient -run '^TestLiveHost(Lifecycle|InitializationRace|MaximumTail)$' -count=1

PEDIT_TEST_LIVE_ROOM="http://127.0.0.1:$port" go test ./internal/session -run '^TestLiveKept(Initial|HostObserver)$' -count=1
