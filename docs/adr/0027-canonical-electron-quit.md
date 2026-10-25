# ADR-0027: Canonical Electron quit

- **Status:** Accepted (owner decisions, 2026-10-21); decision 3's native-thread join
  retires under [ADR-0029](0029-main-is-a-launcher.md) once no native work runs on Main
- **Date:** 2026-10-21
- **Amends:** [ADR-0026](0026-lifecycle-readiness-liveness-joined-quit.md) R4. Git on
  Windows no longer runs in a per-command native Job, so quit has no git Job to join. A
  slow quit step is no longer named at warn. The rest of R1–R6 stands.

## Context

Desktop teardown had 22 fixes in six days (BST-2101 through BST-2292). The owner asked
for a canonical teardown in place of bespoke machinery.

Each piece of quit was reviewed against Electron's documented pattern:

- `before-quit` calls `preventDefault()`;
- cleanup runs;
- `app.quit()` is called again.

Three pieces were bespoke and guarded nothing:

- **The Windows git wrapper.** Every git command ran inside an Electron-as-Node wrapper
  process assigned to a native Job. Its result waited for a native join of that Job.
  On a loaded 2-core Windows box the join alone took 1.5 s at p50, 4.0 s at p90 and
  9.4 s at worst. That timed out workspace-bar (BST-2292). Quit also had to join every
  live Job, so that no join outlived Main's Node environment (BST-2250).
- **The sequence engine.** Quit ran its ordered steps through a generic engine in
  effect-kit, with option validation and a slow-step warn timer.
- **The re-export shim** left over from the git wrapper.

Three pieces are the canonical pattern already, and each protects a guarantee that a
test enforces:

- **The renderer flush.** Main asks each window to flush its write-behind writers and
  waits for the answer. This is why an edit made just before quit, reload or window
  close survives (`durable-ui-state`, `thread-workspace-close`). Saving on every change
  instead would leave the write in flight at the moment of quit unprotected. That is
  the same race behind the web pane flake in BST-2232.
- **Shutdown-time exit labelling.** Once quit has begun, a renderer or host that a
  process-group signal ended is recorded as retired, not as failed. This is why Ctrl-C
  to the app's process group still quits with exit 0 and no failed step
  (`shutdown-signals`, `native-index-shutdown-signal`).
- **Each child's close.** A child is closed with `kill()` or `destroy()`, and Main then
  waits for its exit. This is Node's ordinary idiom, and no handshake is left to remove.

## Decision

1. **Git runs as a plain Node child on every platform**, with its `timeout` and abort
   `signal`. Windows agent commands keep their wrapper and Job. Only git changed (#4125).
   Output past the capture ceiling closes the pipe so git ends itself; the runner never
   kills git for size, because on Windows a kill stops only the `cmd\git.exe` launcher
   (BST-2295).
2. **Quit is plain ordered awaits** in `desktop-graceful-shutdown.ts`. Each step runs
   until it settles. A failure is recorded and the next step still runs. The database
   closes after the steps, and the durable error log closes last. One
   `Graceful shutdown completed` record lists every step with its duration (#4127).
3. **These stay, by owner decision:**
   - the renderer flush;
   - the shutdown-time exit labelling;
   - joining each child's exit;
   - joining native work on Main's own threads (parcel subscribe and unsubscribe,
     root reads).

   Native work that outlives Node's environment crashes Main (BST-2244, BST-2250). A
   process container cannot reach threads inside Main, so it is no substitute for these
   joins.

**Rejected:** removing the renderer flush and the exit labelling. Both changes would
trade a guarantee that a test enforces for less code.

**Also rejected:** containing quit with an app-wide kill-on-close Job or a process-group
kill. The canonical pattern does not need one, and it would not cover Main's native
threads.

## Evidence

Every run used `--retries=0`. Every E2E teardown requires the app to exit 0.

**Windows box** (packaged build, app pinned to 2 cores next to three busy loops):

- **#4125:**
  - native smoke passed;
  - every smoke-lane test passed, with only the 5 existing Windows skips;
  - workspace-bar and git-panel passed 30 out of 30 repeated runs.
- **#4127:**
  - smoke had 35 passed, 5 skipped and 1 failed;
  - workspace-bar and git-panel passed 15 out of 15 repeated runs.

  The one failure, `thread-workspace-close`, failed the same way on #4125's build. An
  instrumented run showed that the app committed the edit every time and that the test
  read the wrong thread (BST-2294, fixed in #4130).

**Ubuntu box and Mac:** desktop smoke, delegated smoke and the quit specs passed for
both PRs. On Ubuntu, web full regression and the affected unit tests also passed for
#4125.

## Consequences

- Quit no longer has a native git wait to outlive Node.
- A git command's result no longer pays for a Job join.
- A slow quit step is visible only in the per-step durations of the completion record.
  Nothing warns while the step runs, and nothing abandons it.
- A git timeout or abort kills `git` itself. On Windows the launcher's child process
  ends on its own once its work is done.
