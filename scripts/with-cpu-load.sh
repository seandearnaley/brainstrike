#!/bin/sh
set -eu

# Run a command while saturating CPU cores with busy loops, for reproducing
# load-dependent test flakes (e.g. PR #2238's long-task telemetry race).
#
#   scripts/with-cpu-load.sh pnpm --filter @brainstrike/app-shell run test
#   CPU_LOAD_LOOPS=20 scripts/with-cpu-load.sh pnpm vitest run -t "test name"
#
# CPU_LOAD_LOOPS defaults to the core count (1x saturation).
#
# The spinners are orphan-proof in two layers:
#   1. A trap kills them on EXIT/INT/TERM/HUP (the normal paths).
#   2. Each spinner re-checks that this harness is still alive between spin
#      bursts and exits on its own — so even SIGKILL of the harness (which
#      no trap can catch) cannot leak a spinner. An ad-hoc `for … while :;
#      do :; done` with a trailing kill leaks exactly that way when the
#      parent dies mid-run: the loops reparent to launchd and pin every
#      core until someone notices.

if [ "$#" -eq 0 ]; then
  echo "usage: $0 command [args...]" >&2
  exit 2
fi

loops="${CPU_LOAD_LOOPS:-$( { sysctl -n hw.ncpu || nproc; } 2>/dev/null )}"

parent=$$
spin() {
  while kill -0 "$parent" 2>/dev/null; do
    i=0
    while [ "$i" -lt 20000 ]; do i=$((i + 1)); done
  done
}

pids=""
for _ in $(seq 1 "$loops"); do
  spin &
  pids="$pids $!"
done

# shellcheck disable=SC2086 # pids is a deliberate word-split list
cleanup() { kill $pids 2>/dev/null || true; }
trap cleanup EXIT INT TERM HUP

echo "with-cpu-load: $loops busy loops running (pids:$pids)" >&2

"$@"
