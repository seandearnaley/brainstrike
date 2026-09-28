# Effect rc118 qualification

Supports `docs/agents/effect-boundary.md` § "Version pins" and
§ "Where Effect runs".

## Rule

Keep Effect core at one exact catalog version and qualify upgrades separately
from adoption. Read the installed package guidance completely; the repository
contract overrides its examples of unstable APIs. rc118 removes the unstable
path segment but does not make those APIs stable or permitted here. Only
`effect` and `effect/testing` remain allowed imports.

## Evidence (2026-09-28, BST-1851)

Against rc117, the initial qualification suite had two failing regressions,
a passing shared Layer control, and a passing modeled Effect.die cleanup control.
Interrupting explicit Scope.close while the first finalizer was held let the
public Promise settle before resource release. An onExit callback that threw
synchronously replaced the typed primary failure with its cleanup error.
rc118 fixes these reproduced regressions upstream (#8512 and #8427); the same
tests pass.

After upgrading, the modeled cleanup control was replaced with genuine
Scope.addFinalizerExit callback-throw coverage for #8418. That final test was
run on rc118 only: later scope releases still run, the cleanup failure keeps
identity, and repeated close does not release twice. The shared Layer control
already passed on rc117 and is not claimed as a reproduced defect. Its strengthened
rc118 assertions prove one acquisition, waiter rejection, and an interrupt-only
exit when the owning build is interrupted. A review-batch negative control
replaces the pending acquisition with successful completion; the waiter still
settles, but the new rejection assertion fails (resolved versus rejected).
Restoring the pending acquisition passes all four qualification tests, all 39
effect-kit tests, and strict diagnostics for 12/12 files with zero issues.

No helper API, runtime, unstable import, consumer policy or fallback is added.
The AGENTS stack guidance establishes Effect 4 for typed runtime boundaries and
resource ownership while preserving the existing excluded subsystems.

## Package provenance and dependency quarantine

npm reports repository `https://github.com/Effect-TS/effect.git`, directory
`packages/effect`, tarball `https://registry.npmjs.org/effect/-/effect-4.0.0-rc.118.tgz`,
and publication `2026-09-28T02:08:42.505Z`. Registry integrity is
`sha512-hxhpCd+swzrtu9lnyPpEFre2ODQzJ9qxgyL1oHIEY8NKnW4PxTbM1XzplMZXiAsLD62HO+KJc41Nqxr9T791ZQ==`.
The registry advertises signatures and SLSA provenance. Inspection of the
attestation shows the matching package/digest and Effect-TS/effect release
workflow `.github/workflows/release.yml` on main commit
`ad61db80efd52637e2901c5ee56b9e0fb4e8ac48`. This records inspected provenance,
not an independent cryptographic signature verification.

The unchanged 1440-minute release-age floor initially rejected normal install.
Its documented exception workflow now exempts only effect@4.0.0-rc.118, with
published timestamp and the two reproduced resource failures in the ledger.
Remove that exact exception when the floor admits the version after
2026-09-29 02:09 UTC; the existing guard also bounds its maximum lifetime.
Unrelated lockfile changes produced by initial resolution were discarded;
the committed dependency change is restricted to Effect rc118.

## Verification commands

- `pnpm exec vitest run src/__tests__/rc118-qualification.test.ts` in packages/effect-kit.
- `pnpm run type-check` in packages/effect-kit (includes test TypeScript and strict Effect diagnostics).
- `pnpm install --frozen-lockfile` at repository root.
- `node --test scripts/__tests__/effect-boundary-contract.test.mjs scripts/__tests__/agent-contract-budget-contract.test.mjs`.
- `node scripts/verify-minimum-release-age-exclusions.mjs`.

The configured pnpm Node runtime is 26.8.2; the host Node version is 26.10.
Bundle and consumer qualification measurements are recorded below by delivery.

## Bundle qualification

Compared with base `6050af3a5`, using the configured pnpm Node 26.8.2 and
unchanged build commands. Counts include emitted `.js` files; gzip is level 9
per file. Startup closure follows static imports and modulepreloads from HTML,
excluding dynamic imports. Both closure traversals have no unresolved external imports.

| Surface | JS files | rc117 raw / gzip bytes | rc118 raw / gzip bytes | Raw / gzip delta |
| --- | ---: | ---: | ---: | ---: |
| Chunking worker | 11 | 2,050,190 / 695,555 | 2,050,190 / 695,555 | +0 / +0 |
| Token cache | 17 | 1,567,985 / 602,056 | 1,567,985 / 602,056 | +0 / +0 |
| Desktop renderer | 399 | 22,692,923 / 5,246,743 | 22,695,345 / 5,247,198 | +2,422 / +455 |
| Web | 415 | 17,863,423 / 4,967,986 | 17,862,849 / 4,968,070 | -574 / +84 |
| Desktop startup closure | 80 | 10,303,759 / 2,221,751 | 10,305,395 / 2,222,167 | +1,636 / +416 |
| Web startup closure | 3 | 16,268 / 6,467 | 16,268 / 6,467 | +0 / +0 |

All eight desktop main/preload outputs retain their sizes; `main.js` stays
2,742,205 raw / 584,738 gzip bytes. Main and package worker outputs retain
external Effect imports, so unchanged package output sizes do not imply the
dependency is absent; renderer builds measure their bundled dependency cost.
No startup-latency or throughput improvement is claimed.

## Consumer qualification

All eight direct consumers pass their full `type-check` scripts, including strict
Effect diagnostics. Local unit results: effect-kit 39, assistant-contract 1,074,
chunking-worker 174, worker-runtime 60, token-cache 182, embeddings 362, database
2,078 and desktop 4,988 cases. The database's existing opt-in pg-textsearch
durability test remains disabled in its standard unit lane; no test was newly
skipped or weakened. Embeddings integration passes 91 cases in 17 files.

The first local embeddings and desktop unit runs inherited provider credentials.
Tests expecting no configured credential consequently failed (five embeddings,
two desktop). Their resolver paths prefer environment values by design. Removing
OPENAI_API_KEY for embeddings and the affected desktop provider tests, and
ANTHROPIC_API_KEY for the remaining desktop secret-store fixture, resolves those
failures without source or assertion changes. Passing files were not rerun just
to hide the original run: the affected fixtures were rechecked explicitly.

Desktop integration and required remote CI results are recorded in the PR.

## Shutdown timer oracle correction

PR 3358 Unit(rest) job 108800499443 exposed an existing process-wide timer-count
oracle: the test compared all active Timeout resources before and after its
shutdown sequence. An unrelated timer expiring during that interval changed
one to zero despite successful owned deadline cleanup. A controlled unrelated
25ms timer reproduced the false failure locally (two before versus one after).

The test now spies on the real dynamic setTimeout/clearTimeout calls used by
rc118 ClockImpl.sleepMillis, captures the single 60,000ms deadline handle,
proves it remains uncleared while the step gate is held, and checks its exact
clear immediately after public completion. No fake clock or process-wide
count is used. Finally opens/joins the step, clears every successfully created 60,000ms native
handle, and restores both spies even if joining unexpectedly rejects or the
acquisition-count assertion fails.

A negative control suppresses only the owned deadline clear: the specific
clear assertion fails with zero observed calls. Its leaked native handle is
cleared in finally before restoration. Restoring cleanup passes the suite.
All 39 effect-kit tests pass after restoration; strict Effect diagnostics cover
12/12 files with zero errors, warnings or messages. This correction changes
only the test oracle; runtime behavior is unchanged.
