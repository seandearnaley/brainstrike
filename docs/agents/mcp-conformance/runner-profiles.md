# Runner profiles, selection, and the verification lanes — evidence

Supports `docs/agents/mcp-conformance.md` § "MCP verification harness"
(BST-1486). Read this before changing `runner-manifest.ts`, a profile's case
set or timeout, or `scripts/run-mcp-verification.mjs`. The contract holds the
rules; this is the record of the incremental-capability policy, the exact case
composition of each profile, and the CLI/wrapper split.

## Profiles, selection bounds, and the CLI, as landed

Add verifier capabilities incrementally. A package export may appear only in
the layer that implements and independently tests it; do not advertise a
transport, fault coordinate, OAuth route, evidence guarantee, or runner before
that branch contains its executable path and focused verifier. The private
runner manifest owns two closed deterministic profiles over ten case ids:

- `pr`: 6 cases, 10,000 ms per case, 90,000 ms per run — modern in-process
  HTTP, legacy loopback HTTP, OAuth loopback HTTP, modern stdio, modern Tasks
  in-process HTTP, and modern Apps in-process HTTP.
- `exhaustive`: 10 cases, 20,000 ms per case, 270,000 ms per run — the PR set
  plus modern loopback, legacy in-process HTTP, modern Tasks loopback HTTP, and
  modern Apps loopback HTTP.

Selection accepts only `profile`, `caseIds`, `caseTimeoutMs`, and
`runTimeoutMs`; unknown fields, duplicate/foreign case ids, and out-of-bound
timeouts fail visibly. Omitted optional fields use the profile defaults.
Explicit `undefined` values are malformed and never treated as omission. An
explicit selection cannot exceed its closed profile, a case timeout stays
within 100–60,000 ms, and a run timeout stays within 100–600,000 ms without
falling below its case timeout. Case limits are per-case ceilings, not reserved
runtime, so the whole-run ceiling need not equal their sum; it does stay above
that sum so a merely slow sequential run fails per case, not as a run timeout.
The `./runner` owner executes closed profile selections serially as genuine RED, GREEN, and
repeat-verification phases. Every phase receives a bounded abort signal and an
independently bounded cleanup attempt; a primary plus cleanup failure remains
an `AggregateError`, while any missing cleanup proof prevents evidence emission.
The whole-run deadline can shorten a case budget but never silently expands one; phase
observations agree with the canonical scenario era/revision and stable
capability set before the existing evidence sanitizer and artifact-integrity verifier can return a
deeply frozen bundle. Current public verifier subpaths:
`./evidence`, `./faults`, `./lab`, `./runner`, `./scenario`.

The package CLI derives exact Git identity and dirty or clean workspace state;
those values are not caller arguments. The package CLI fixes the evidence ticket
to `BST-1486`; the repository wrapper rejects a GitHub Actions checkout whose `GITHUB_SHA` differs from
`HEAD` or whose tracked/untracked state is dirty before the run. The PR-required
representative command is `pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json`.
The exhaustive schedule/manual command is `pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json`.
Both reach the same package CLI and emit atomically verified, credential-free
JSON below the ignored `packages/mcp-test-lab/artifacts/` directory.

## Cleanup reserve anchoring (BST-1863, 2026-09-28)

Supports the contract rule that a phase's cleanup reserve is cut from the end of
its deadline. The reserve is `min(1000, max(1, floor(timeoutMs / 4)))` of the
budget measured when the phase starts.

- Before: the operation timer ran `timeoutMs - reserve` from the moment it was
  set, after `createPhaseOwner` returned. Any time spent in between came out of
  the reserve, and a slow owner creation could leave cleanup no time at all.
  The phase then failed as `MCP lab runner phase <case>/<phase> and its cleanup
  both failed` instead of the deadline error. Now the operation timer runs
  `ceil(remaining - reserve)` when it is set, so the operation deadline is the
  phase deadline minus the reserve regardless of what ran first.
- Guard: `runner.test.ts` › "charges time spent before the run starts to the
  operation, not the cleanup reserve" spins inside the fake
  `createPhaseOwner` for twice the reserve on the real clock. The pre-fix
  runner fails it every time; reverting the fix, dropping the reserve, or
  computing the operation budget from the phase-start `timeoutMs` all turn it
  red.
- Not fixable in the runner: an operation timer that fires late (a scheduler or
  GC stall across its due time) still shortens cleanup, because cleanup is
  capped by the remaining case and run time and the whole-run deadline never
  silently expands a budget. Measured by stalling the loop 5 ms before the
  timer was due, with a ~5 ms close: a 100 ms case (25 ms reserve) kept cleanup
  through a 20 ms stall and lost it at 30 ms; a 400 ms case (100 ms reserve)
  kept it through an 80 ms stall and lost it at 100 ms. The tests that need cleanup to succeed under a deadline therefore use
  a 400 ms case (`RESERVE_BUDGET` in `runner.test.ts`), and the real clock
  stays: a frozen clock leaves the whole run budget for cleanup and hides a
  lost reserve (BST-1817).
- A 32-process CPU burner on a 16-core host (load ~30) did not reproduce the
  100 ms flake in 300 iterations, so the CI failure needed a larger stall than
  ordinary oversubscription produces here. Do not read a passing local loop as
  proof the budget is safe.
