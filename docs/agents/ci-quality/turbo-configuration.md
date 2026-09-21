# Turbo 2.10 configuration audit and 3.0 preparation — evidence

Supports `docs/agents/ci-quality.md` § "Turbo 2.10 configuration audit and 3.0
preparation" (BST-1013). Read this before changing `global.concurrency`, the
root `dev` cap, the `global.inputs` list, a Turbo future flag, or before
proposing shared package-config composition or `turbo query affected` as a CI
planner. The contract holds the rules; this file is the record of why.

Corrected at extraction (verified against the repo): `turbo.jsonc` now enables
`futureFlags.affectedUsingTaskInputs` alongside `globalConfiguration` (see the
contract's affected-selection rules), so the "no adopted call site" sentence
below no longer covers the affected flag. The package-config evaluation counted
ten package `turbo.json` files; fourteen exist today and the class counts were
not re-derived.

The root config opts into Turbo 2.10's `futureFlags.globalConfiguration` and
uses the Turbo 3.0 `global.concurrency` / `global.inputs` shape. This is a
mechanical config migration: a before/after `turbo run build type-check lint
test --dry=json` selected the same 47 packages and 235 task nodes. Under this
future flag, Turbo no longer reports these files in `globalCacheInputs.files`;
it injects them into each executable task's resolved inputs instead.
`scripts/__tests__/turbo-global-configuration.test.mjs` therefore expands the
configured globs, runs the pinned Turbo binary, and checks every executable
task at that actual boundary. Its floors require at least 9 matched global
files, 47 packages, 230 total task nodes, and 160 executable tasks. Mutation
controls remove one real input from one task and empty the task selection, and
prove both cases fail visibly. The structural tsconfig contract separately
proves the future flag/layout and the load-bearing tsconfig globs; its controls
reject the legacy layout and a missing preset input. Keep both controls when
editing the global block. On the same machine and base revision, the complete
script-test phase moved from 14.23 seconds / 781 tests to 15.00 seconds / 784
tests: +0.77 seconds (+5.4%). The Turbo dry-run is memoized within the test file
so the money controls do not spawn it twice.

**`global.concurrency` is the build/test calibration; the dev floor lives on
the dev script.** `turbo run dev` selects every workspace `dev` task and turbo
refuses to start when concurrency is <= the number of persistent tasks in the
selection — a property of that selection, not a parallelism budget. Raising the
global value to satisfy it is what produced the 28 → 29 → 30 → 31 → 32 treadmill
and, at 40 tasks vs. concurrency 40, a `pnpm dev` that failed outright. The
global value stays pinned at 40 (structurally, in the tsconfig contract) and the
root `dev` script carries `--concurrency=100`.

Be precise about who inherits the global value: not every CI invocation caps
itself. The Unit lanes pass `--concurrency=4` / `=2`, Type check sets
`TURBO_CONCURRENCY=4`, native-electron and coverage pass `=4` — but the **Build**
job (`test.yml`, `runs-on: ubicloud-standard-4`) runs `pnpm turbo run build`
with no cap and inherits the global number, as do local `pnpm build` /
`pnpm check`. Its effective parallelism is bounded by the build DAG's width, but
the global value is the ceiling, so treat a change to it as a change to Build.

`turbo-global-configuration.test.mjs` enforces the dev cap against a memoized
`turbo run dev --dry=json`: it must exceed both the planned persistent-task
count AND the workspace package count. The second bound is the one that retires
the treadmill — turbo can never plan more `dev` tasks than there are packages,
so a cap above the package count can never bind, and the guard goes red while
`pnpm dev` still works rather than on the commit that breaks it. Controls cover
a cap equal to the task count, a cap that clears the task count but not the
package count, a collapsed dev sweep, and a dev script with no cap at all. The
same file also pins `$schema` to the `package.json` Turbo version, so a bump
cannot leave editors validating against the previous release's schema.

Arithmetic over a planned graph assumes turbo enforces the rule at all, and
neither `--dry` nor `--graph` exercises that check while the real `dev` graph
cannot be run in a test (it launches every watcher). A money test therefore
proves the rule on a two-package fixture at the pinned binary: concurrency 2
against 2 persistent tasks must be rejected naming the floor, concurrency 3
must succeed. That is the file's dominant cost — measured on one machine, it
moved from 1.06 s / 2 tests to 5.88 s / 4 tests, roughly 3.7 s of which is the
fixture's two real turbo runs. Keep the fixture if a future turbo changes the
rule; without it the arithmetic could quietly guard nothing.

The same audit found no active repository use of Turbo 2.9's deprecated
`turbo-ignore`, `turbo scan`, `--parallel`, Turbo's `--no-cache`, daemon flags,
non-HTML `--graph` output, legacy remote-cache flags/environment variables, or
`prune --scope`. The only `--no-cache` match is Alpine's unrelated
`apk add --no-cache` in `scripts/setup-headless-display.sh`. Do not enable the
remaining 3.0 future flags speculatively: `filterUsingTasks` would change the
settled explicit affected filters in `test.yml`; the watch/prune flags
have no adopted call site (`affectedUsingTaskInputs` was adopted later, with
`ci-input-locality.test.mjs` as its proof); `longerSignatureKey` needs the real remote-cache
signing setup to validate; and the diagnostic-only flag has no CI benefit.

Package-config composition was evaluated and deliberately not adopted. The
classification below is HISTORICAL: it counted ten package `turbo.json` files,
and fourteen are tracked today (see this file's header). The ruling stands; the
class tally has not been recomputed. Those ten represented seven behavior classes; five are
unique cache-safety or cross-input contracts. Only app-shell/db-explorer/
vector-management and secure-fs-native/windows-job-native repeat behavior.
Introducing a config micro-package for groups of three and two would add graph
and ownership surface, while extending an operational package would couple
unrelated owners. Turbo's native `extends` is still the required mechanism if
a stable repeated policy grows large enough to justify a shared owner; do not
invent a merger or config registry.

Turbo 2.9's stable `query affected` was also evaluated but is not a CI planner.
Against `origin/main..HEAD` with no package change it correctly returned zero;
against the BST-1011 root/lockfile change it returned 48 package nodes including
the workspace root, or 46 with `--tasks test`. That offers no saving over the
Unit job's native affected selection, cannot weaken the always-on
web/desktop smoke checks, and would create a second selection/reconciliation
seam. `scripts/run-turbo-command.mjs` also appends `--cache-dir`, which run
commands accept but `turbo query affected` rejects. Because no repository query
entrypoint was adopted, the bounded run wrapper was not broadened for an
unsupported command.
