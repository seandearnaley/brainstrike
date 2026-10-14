# Agent-debug launcher — evidence

Supports `docs/agents/ci-quality.md` § "Agent-debug macOS automation identity"
and its § "Stale-profile sweep". Read this before changing
`apps/desktop/scripts/start-agent-devtools-session.mjs`: the macOS shim, pnpm
re-entry, process-tree ownership, profile cleanup, or the stale-profile sweep.
It also holds the manual QA script. The contract holds the rules; this file is
the record of why.

Corrected since first written: the launcher spawns `pnpm run dev:runtime`
(after its own synchronous dependency preflight), not `pnpm dev`; the four
statements below that named `pnpm dev` as the spawned command now say
`pnpm run dev:runtime`.

### Agent-debug macOS automation identity

On macOS, `dev:agent-debug` launches through a lightweight temporary
`Electron.app` shim inside its disposable profile. The shim symlinks the
installed Electron executable, Frameworks, and Resources, but owns an
`Info.plist` with display name `BrainStrike Agent Debug` and bundle identifier
`com.brainstrike.desktop.agent-debug`. It is not a packaged application, does
not copy Electron's framework payload, and is scoped to the isolated temporary
profile. Shim construction is fail-closed: an unexpected Electron bundle
layout or malformed plist aborts startup rather than falling back to the
ambiguous `com.github.Electron` identity. Agent-debug windows pin the native
and accessibility title `BrainStrike Agent Debug`.

The launcher re-enters the exact pnpm CLI recorded in `npm_execpath` through
`process.execPath`. On Windows this is required because Corepack exposes a
`pnpm.cmd` shim rather than an executable that `child_process.spawn` can invoke
directly without a shell. The recorded entrypoint must be an absolute
`pnpm.cjs`, `pnpm.js`, or `pnpm.mjs` path — Corepack-managed pnpm resolves to
the `.mjs` form under its cache (`.../corepack/v1/pnpm/<version>/bin/pnpm.mjs`)
on every platform, so all three are accepted; `pnpm.cmd` stays rejected because
re-entering a shim as a Node script is exactly what this contract prevents.
Missing pnpm launch context fails before the
disposable profile is created; child spawn errors are observed and flow through
the normal owned-tree/profile cleanup path. Do not replace this with the shared
shell-based spawn helper: the extra `cmd.exe` process would sit between the
launcher and the process tree whose ownership the Windows Job Object enforces.

The launcher owns its development subprocess tree. On POSIX, `pnpm run dev:runtime` is the
leader of a detached process group; shutdown signals that exact group with
SIGTERM, waits for quiescence, and escalates to SIGKILL after a bounded grace
period. This remains effective when the direct `pnpm` child exits before a
late-writing Electron or PGlite grandchild. Although other Windows process-tree
helpers may use an ancestry walk while their direct child remains addressable,
agent-debug does not use that weaker path: its launcher first joins a private
Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then starts
`pnpm run dev:runtime` console-bound so Ctrl-C can be handled gracefully. Every descendant
inherits the non-breakaway job, so membership remains authoritative after an
intermediate parent exits. Cleanup waits for the job to contain only the
launcher, then terminates only the remaining job members after a bounded grace
period. Missing or malformed native Job Object support aborts Windows startup;
there is no ancestry-walk fallback. Only after the owned tree is stopped may
the launcher remove its temporary profile. Process-tree or profile cleanup
failures are visible fatal errors with a non-zero exit, never warning-only
cleanup. The always-on `Native Windows` CI job builds and exercises the native
addon with a late-writing orphan plus an unrelated-process survival assertion.

#### Stale-profile sweep (abrupt-kill recovery)

In-process cleanup covers every exit the launcher can observe, but SIGKILL, a
panic, and loss of power run no handler at all, and nothing reclaims `$TMPDIR`
while the machine stays up — 121 profiles totalling 262 GB accumulated over a
single eleven-day uptime. Because the profile is also
`BRAINSTRIKE_DB_ROOT_PATH`, each abandoned profile retains a whole PGlite
cluster, so the leak is measured in gigabytes.

Each profile records an `agent-devtools-owner.json` marker
(`{ pgid, pid, platform, startedAtMs }`). `pid` and `platform` are written
immediately after `mkdtemp`; `pgid` is added right after `pnpm run dev:runtime` is spawned,
because the group does not exist before then. On startup, after spawning its own
dev server, the launcher sweeps sibling `brainstrike-agent-devtools-*`
directories.

**A dead launcher pid is not proof the profile is idle.** On POSIX `pnpm run dev:runtime` is
spawned detached, so SIGKILLing the launcher leaves the whole tree reparented and
still writing to this directory. Reclaiming on the pid alone would `rm -rf` a
live PGlite cluster — the historical failure, re-created from the other side —
and on macOS would also delete the running app's own `electron-dist` bundle.
Verified by experiment: after `kill -9` of the launcher, the detached tree stays
alive and keeps writing.

The sweep is opportunistic hygiene, **not** the ownership guarantee, and the two
must not be conflated:

- A sibling is reclaimed only when the launcher pid is dead **and** its recorded
  process group has no live members. Every uncertain liveness answer resolves to
  alive (`EPERM`, a recycled pid), so the sweep can only under-delete. An age
  threshold is deliberately **not** the deciding signal: a long-running
  agent-debug session is both old and live.
- A marker written before the current boot is reclaimable outright: no process
  from before the boot survives. Without this, pids re-issued from a low
  watermark after a reboot probe as alive against unrelated processes and the
  profile becomes permanently unreclaimable.
- On `win32` the launcher pid suffices — descendants inherit a non-breakaway Job
  Object with `KILL_ON_JOB_CLOSE`, so no tree outlives the launcher.
- A profile with a missing/malformed marker, or a POSIX marker with no recorded
  `pgid`, cannot be proven stale. It is reported as an explicit list of paths,
  **with no removal command**, and is **never** auto-deleted. Any glob in that
  report is paired with `ls -d` only: a `brainstrike-agent-devtools-*` glob also
  matches a concurrent session's profile.
- Skipped and failed profiles are both reported. Skipping is the safe answer,
  but a machine where the sweep never reclaims anything must not look identical
  to one with nothing to reclaim.
- The sweep runs after the dev server is spawned, so it overlaps startup instead
  of delaying it, and it never fails a launch. The run's own profile stays
  fail-loud through `removeUserDataDir`; do not make the sweep fatal to "match"
  it.

The marker sits at the profile root, which is safe only because the database
joins `<root>/profiles/<profile>` and never enumerates the root. Re-verify that
before adding anything else there.

Manual QA must cover both automation surfaces while another Electron app is
running:

1. Run `pnpm --filter @brainstrike/desktop dev:agent-debug` and connect CDT to
   the printed local CDP endpoint (default `http://127.0.0.1:9222`). Confirm the
   visible target is the expected BrainStrike renderer.
2. In Computer Use, verify `list_apps` reports
   `com.brainstrike.desktop.agent-debug` as `BrainStrike Agent Debug`, then call
   `get_app_state({ app: "com.brainstrike.desktop.agent-debug" })`.
3. Confirm the accessibility tree describes the same renderer URL/title seen
   through CDP. Do not stop or retarget unrelated Electron processes.
4. Stop the documented root command with Ctrl-C, wait for it to exit, and
   confirm the printed `brainstrike-agent-devtools-*` profile remains absent
   after a bounded post-exit observation. Keep unrelated Electron processes
   running throughout this check.
5. Verify abrupt-kill recovery in the correct order — the orphaned tree must be
   spared, not reclaimed, while it is still alive:
   a. Start the launcher, `kill -9` its pid, and confirm the printed profile
      survives and the orphaned Electron/PGlite tree is still running.
   b. Start a second session. It must report the profile as *still in use* and
      leave it on disk. Reclaiming it here would delete a live database.
   c. Kill the orphaned process group, then start a third session and confirm it
      now reports reclaiming that profile and the directory is gone. A
      concurrently running session's profile stays untouched throughout.
