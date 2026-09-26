# E2E lane timeout budgets — evidence

Supports `docs/agents/ci-quality.md` § "Workload boundaries" (the
`--global-timeout` rules and the two-lane Desktop E2E smoke split; BST-1713,
BST-1762, BST-1763). Read this before changing a lane's `--global-timeout`,
moving a spec between `test:e2e:lane:smoke` and `test:e2e:lane:smoke-delegated`,
or when a desktop E2E failure shows an `interrupted` test plus a missing
`.playwright-artifacts` trace zip. The contract holds the rules; this file is
the measurement log — append new lane measurements here.

An E2E lane's `--global-timeout` is a **failure ceiling, not a latency target**,
and it stops being one silently. Read a lane's budget as a ratio against its
measured runtime, never as an absolute number: the desktop smoke lane's 300000
was calibrated on 2026-05-20 against three files finishing in 28.3s
(`docs/architecture-reset/pipeline-calibration-desktop-smoke-2026-05-20.json`),
a 10x ceiling, and nobody revisited it while the lane grew to 16 files and 34
tests. By 2026-09-09 ten green runs measured 226.5s-278.4s and run
`34353940887` measured 297.5s on a ~7% slower runner — 99.2% of budget. The
deadline landed mid-test and produced a failure that looks like a product bug
and is not one (BST-1713): Playwright marks the in-flight test `interrupted`
(**not** failed), reports two `Timed out waiting Ns for the ...` entries as
"errors not part of any test", and hands teardown the ALREADY-ELAPSED deadline,
so the trace zip is never finalised and the blob reporter raises
`ENOENT ... blob-report/.playwright-artifacts-<n>/<hash>.zip`. The named test is
whichever one was running — with `--workers=1` that is just the last file in
the lane's file list, and the surface it exercises is a red herring. Diagnose
this shape by checking the run's total against its budget FIRST; app shutdown
noise in the same log (git-inventory drain abandonment, `DB host closed.`,
`the worker is ending`) is per-test teardown chatter that also appears in green
runs, and timestamps place it minutes away from the interruption. Raise a
lane's budget when you add work to it, not after the next interruption. The
desktop smoke lane's 900000 ms ceiling (raised from 720000 ms when 43 cases
measured 11.8 minutes on main, Test 34646256371) was being reached again by a
passing suite by 2026-09-15: 47 cases took 722-871 s across 24 green Test runs
(2026-09-12..15), and run `34988958978` interrupted `worktree-mode` at 898 s
with the same missing-artifact shape. BST-1762 split the suite rather than
raising the ceiling a third time. `test:e2e:lane:smoke` (17 specs whose
per-case CI means sum to 337 s) and `test:e2e:lane:smoke-delegated` (the four
`delegated-*` specs, 466 s) run on separate `ubicloud-standard-4` runners,
each with a 900000 ms ceiling inside the unchanged 25-minute job boundary.
Their first run (Test 34997197693) took 367 s and 440 s of Playwright, 41% and
49% of that ceiling, in 496 s and 573 s jobs, so the required check now lands in
under 10 minutes instead of 14-16. A failure in one lane does not cancel the
other (`--max-failures=1` stops only its own lane), so a red PR can spend both
lanes' runner time. The required `Desktop E2E` check is a fan-in over
the `desktop-e2e-smoke` and `desktop-e2e-delegated` jobs, like `Unit` over
`unit-shard`: it carries their condition and fails unless both succeed, so the
ruleset did not change. Moving the delegated specs to nightly regression was
rejected on measurement: that lane had failed its last ten scheduled runs and,
under `--max-failures=1`, left 87-120 cases unrun. Add a smoke spec to the lane
whose measured headroom absorbs it and record the measurement here. Why these
specs run 4.6-9.5x slower on Linux CI than locally, while launch-only specs run
1.6-2.5x slower, is tracked separately by BST-1763. The exact lane commands and
the fan-in are pinned by
`scripts/__tests__/ai-tools-e2e-pr-gate-contract.test.mjs`, which is the guard
that forces the change to be deliberate.

## 2026-09-26: workers after a canvas approval

The delegated smoke lane adds one real Electron case with two completed
Explorers, a reload while root canvas approval is pending, then two fresh Worker writes
on the same resumed root turn.
It verifies separate child checkpoint ownership and durable completion of the
root and both Workers before teardown. On macOS it took 10.4 seconds for the
case, 25.0 seconds including setup; the lane retains its 900-second ceiling
and zero retries. The prior measured 440-second lane has headroom for this
case even using the historical 9.5x Linux/local ratio (about 99 seconds).
This is a headroom estimate, not a new full-lane measurement; PR CI measures
the new complete lane. The provider endpoint is a Chat Completions shim;
the app runtime, database, approval, filesystem writes, and reload are real.
