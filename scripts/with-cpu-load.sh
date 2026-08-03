#!/bin/sh
set -eu

# Run a command while saturating CPU cores with busy loops, for reproducing
# load-dependent test flakes (e.g. PR #2238's long-task telemetry race).
#
#   scripts/with-cpu-load.sh pnpm --filter @brainstrike/app-shell run test
#   CPU_LOAD_LOOPS=20 scripts/with-cpu-load.sh pnpm vitest run -t "test name"
#
# CPU_LOAD_LOOPS defaults to the core count (1x saturation). Invalid or
# undetectable counts abort loudly (NO SILENT FALLBACKS): a run with zero
# spinners would look exactly like a successful load run.
#
# The spinners cannot outlive the run, in three layers:
#   1. Traps are installed before the first spinner forks. INT/TERM/HUP kill
#      the wrapped command — it runs as a background child under `wait`, so
#      the signal actually interrupts the harness instead of queuing behind
#      a foreground command — and EXIT kills the spinners.
#   2. Each spinner re-checks that this harness is still alive between spin
#      bursts and exits on its own, surviving even SIGKILL of the harness,
#      which no trap can catch.
#   3. Each spinner enforces a wall-clock ceiling (CPU_LOAD_MAX_SECONDS,
#      default 7200) so PID reuse handing the harness pid to an unrelated
#      long-lived process cannot turn layer 2 into a leak. If the ceiling
#      expires before the command finishes, the harness says so.
#
# An ad-hoc `for … ( while :; do :; done ) & … kill $PIDS` has none of
# these: when the parent dies mid-run the loops reparent to launchd and pin
# every core until someone notices.

if [ "$#" -eq 0 ]; then
  echo "usage: $0 command [args...]" >&2
  exit 2
fi

loops="${CPU_LOAD_LOOPS:-$( { sysctl -n hw.ncpu || nproc; } 2>/dev/null || true )}"
case "$loops" in
'' | *[!0-9]*)
  echo "with-cpu-load: loop count must be a positive integer; CPU_LOAD_LOOPS/core detection produced '$loops'" >&2
  exit 2
  ;;
esac
if [ "$loops" -lt 1 ]; then
  echo "with-cpu-load: loop count must be >= 1, got $loops" >&2
  exit 2
fi

max_seconds="${CPU_LOAD_MAX_SECONDS:-7200}"
case "$max_seconds" in
'' | *[!0-9]*)
  echo "with-cpu-load: CPU_LOAD_MAX_SECONDS must be a positive integer, got '$max_seconds'" >&2
  exit 2
  ;;
esac
deadline=$(($(date +%s) + max_seconds))

parent=$$
spin() {
  bursts=0
  while kill -0 "$parent" 2>/dev/null; do
    i=0
    while [ "$i" -lt 20000 ]; do i=$((i + 1)); done
    bursts=$((bursts + 1))
    if [ $((bursts % 256)) -eq 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then
      exit 0
    fi
  done
}

pids=""
cmd_pid=""

# shellcheck disable=SC2086 # pids is a deliberate word-split list
cleanup() {
  [ -n "$pids" ] && kill $pids 2>/dev/null
  return 0
}
on_signal() {
  [ -n "$cmd_pid" ] && kill "$cmd_pid" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap on_signal INT TERM HUP

for _ in $(seq 1 "$loops"); do
  spin &
  pids="${pids:+$pids }$!"
done

echo "with-cpu-load: $loops busy loops running for up to ${max_seconds}s (pids: $pids)" >&2

"$@" &
cmd_pid=$!

status=0
while :; do
  if wait "$cmd_pid"; then
    status=0
    break
  else
    status=$?
    # wait may have been interrupted by a trapped signal while the wrapped
    # command is still exiting; reap it for its real status in that case.
    kill -0 "$cmd_pid" 2>/dev/null || break
  fi
done

if [ "$(date +%s)" -ge "$deadline" ]; then
  echo "with-cpu-load: CPU_LOAD_MAX_SECONDS ($max_seconds) elapsed before the command finished — load was NOT sustained for the whole run" >&2
fi

exit "$status"
