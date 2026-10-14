# MCP verifier lanes — evidence

Supports `docs/agents/ci-quality.md` § "MCP verifier lanes" and
§ "MCP 2026 fleet working agreements (BST-1590)" (BST-1495, BST-1560,
BST-1576, BST-1582, BST-1583, BST-1590). Read this before changing
`.github/workflows/mcp-verification.yml`, the `verify:mcp*` commands, a
timeout or artifact bound, or the required post-merge posture of the official
conformance jobs. The contract holds the rules; this file is the record of the
budget arithmetic, promotion evidence, and the incident behind the fleet
agreements.

## Verifier lanes

The required `Static` job and the default local `pnpm check` plan both invoke
`pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json`.
That representative profile is part of the required PR gate; it is not advisory
and must not gain `continue-on-error`, an event predicate, or a second selection
planner. `.github/workflows/mcp-verification.yml` owns the scheduled and
manual exhaustive lane, using
`pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json`.
The exhaustive job has a ten-minute outer bound, an eight-minute verifier-step
bound, and uploads the exact-SHA sanitized evidence for 14 days. The workflow
also subscribes to pushes to `main` (BST-1582), but the exhaustive `verify` job
is predicated off that event (`if: github.event_name != 'push'`) and must
remain `schedule` plus `workflow_dispatch` only; running it on PRs or pushes
would duplicate the required representative gate. The push trigger exists for
the official conformance jobs below and carries a `paths-ignore` for `docs/**`
and `**/*.md`, because a docs-only merge cannot regress client conformance.

`scripts/run-mcp-verification.mjs` is an identity guard, not a planner. It
derives `HEAD` and porcelain workspace state and under GitHub Actions requires
`GITHUB_SHA` to equal `HEAD` and the checkout to be clean. It then invokes the
one package CLI, which fixes the parent ticket to `BST-1486` and independently
derives the Git identity recorded in evidence. The wrapper accepts exactly one
closed profile and one safe JSON output below `artifacts/`; unknown, duplicate,
or shell-sensitive input fails before platform-specific spawning. The paired script tests control
identity mismatch and dirty-checkout failures; the CI contract test pins the
commands, profile ownership, timeouts, artifact path/retention, and local-check
mapping. Exhaustive artifacts are uploaded only after complete verification;
failed or partial runs never emit an artifact that could be mistaken for proof.
Both automated profiles emit evidence-schema `1.1.0` with desktop applicability
explicitly set to `protocol-lab-only`; they do not fabricate Electron or CDT
proof. Desktop-required bundles remain the bounded implementation-ticket gate
described in `mcp-conformance.md`, outside the scheduled verifier loop.

The same workflow — which runs on every push to `main`, on the nightly
schedule, and on manual dispatch — has a separate `Official MCP auth
conformance` job. It builds the Desktop main-process runtime dependencies
and bundle through the root command.

```bash
pnpm run verify:mcp:official
```

Since BST-1582 the three official jobs (`official_auth`, `official_core`,
`official_modern_auth`) are **required post-merge gates**: none carries
`continue-on-error`, so a single failing scenario fails the workflow and turns
`main` red visibly. "Required" here is deliberately not the ruleset sense used
for `test.yml`'s PR checks — a `push: branches: [main]` job runs after the
merge and can never block one; it detects, it does not block. The entry
condition for promotion was three consecutive exact-head green runs
(33541373505, 33545728828, 33545945643). They deliberately run on `main`
pushes rather than in the PR lane: three Electron-provisioned jobs cost
roughly 30 runner-minutes, and a main-push gate bounds a regression to one
merge instead of 24 hours. The workflow-level `concurrency` group with
`cancel-in-progress: false` serializes overlapping main-push runs rather than
cancelling them, so an intermediate merge commit is never silently skipped.

Exit condition when it goes red: the merge that turned `main` red is fixed
forward or reverted before the next MCP-touching merge, and the failing run
URL is attached to that merge's ticket (working agreements, BST-1590). The
official jobs live outside `test.yml`, so the `notify-main-failure` issue
notifier does not yet cover them; whoever merges checks the workflow run on
their own commit until BST-1591 extends notification to this workflow.

Its combined build/run step has a seven-minute bound and its job an 11-minute
bound (four-minute build, three-minute Electron provisioning, three-minute run,
one minute of workflow overhead). A bounded three-minute "Provision Electron
binary" step runs before the suite: the conformance children execute the desktop
dist entry, which requires the real Electron binary, and Electron has no install
lifecycle — provisioning once prevents parallel children racing an on-demand
download into EEXIST extraction failures. Pinned
`@modelcontextprotocol/conformance@0.2.0-alpha.10` remains prerelease
software, and the evidence records `prerelease: true` alongside
`required: true`. Its runner executes the closed 28-case auth matrix without
`--expected-failures` or `--output-dir`, captures child output through a
bounded line-boundary collector, sanitizes it (ANSI stripped; URL queries,
OAuth parameters, and structured secret assignments redacted), prints a
bounded per-scenario diagnostics block to job stderr for failed scenarios
only, and atomically emits only sanitized fixed-id/timing evidence at
`packages/mcp-test-lab/artifacts/official-auth-evidence.json` — captured
child output never enters the evidence file. The workflow
uploads that file on both green and red scenario outcomes for 14 days under an
exact-SHA artifact name. Missing evidence is a visible job
failure; raw official auth request/response artifacts are never uploaded.
The parent driver provisions and validates Desktop's Electron runtime exactly
once before it launches either parallel protocol wave; scenario processes must
not lazily install the shared runtime concurrently.
Scenario pass/fail counts always sum to the execution count; Job cleanup has its
own status and never inflates scenario failures. If evidence collection or its
atomic write fails after conformance has already failed, the job preserves both
causes rather than replacing the primary conformance failure.

BST-1583 adds the independent required `Official MCP core conformance`
job. It runs the exact alpha.10 non-auth scenarios
applicable to each revision: four at `2025-11-25` and seven at `2026-07-28`.

```bash
pnpm run verify:mcp:official -- --profile core
```

The core job has the same bounded Electron provisioning, parallel-by-protocol
execution, sanitized diagnostics, empty expected-failure ledgers, and 11-minute
job budget as the baseline auth profile. It uploads only
`packages/mcp-test-lab/artifacts/official-core-evidence.json` for 14 days under
`mcp-official-core-${{ github.sha }}`. BST-1582 promoted it, with the two
auth jobs, to a required gate.

BST-1576 adds a second independent job, `Official MCP modern auth closeout`.
It runs:

```bash
pnpm run verify:mcp:official -- --profile modern-closeout
```

The command has a four-minute build allowance, ten-minute runner allowance,
14-minute combined step bound, and 21-minute job bound (which also reserves the
three-minute Electron provisioning step both official jobs share).
The profile executes exactly the eleven alpha.10 scenarios that apply only at
`2026-07-28`, sequentially inside one evidence wave, with zero expected failures.
It uploads only
`packages/mcp-test-lab/artifacts/official-auth-modern-closeout-evidence.json`
for 14 days under `mcp-official-modern-auth-${{ github.sha }}`. The baseline
BST-1560 job remains its reviewed 28 executions; neither job passes
`--expected-failures` or `--output-dir`, and neither uploads raw auth output.
The ten-minute step is load-bearing math: 11 × 45-second scenario deadlines is
495 seconds, leaving 105 seconds for setup, cleanup, and sanitized evidence
persistence. The 21-minute job additionally reserves the four-minute build,
the three-minute Electron provisioning step, and four minutes for workflow
setup/upload. Shared typed descriptors and workflow
contract tests pin these budgets and the required posture of all three
official jobs.

## Why the fleet working agreements exist

Standing rules for every agent on the MCP 2026 project until BST-1472 closes.
They exist because on 2026-09-01 the same Electron install race was fixed twice
by two agents 44 minutes apart (#2900, #2901), BST-1574 was implemented twice,
roughly 40% of the overnight spend went to rewrite-in-place review loops and
blind iteration against a mute verifier, `assistant-providers.md` was rewritten
by every landing commit, and two epics were marked Done while their product
surface was unreachable. The Linear project description carries the same list.

1. **Dedupe before starting.** Search open PRs and the last 24 hours of merged
   PRs for the same root cause before opening a branch; review an existing fix
   instead of re-fixing it.
2. **WIP limit of 2** on the project until BST-1472 closes; the Tasks
   (BST-1473) and Apps (BST-1474) ladders stay frozen behind the core closeout.
3. **Evidence is a CI artifact URL** at the exact head, linked in the PR body
   and on the ticket. Self-reported test counts are notes, not proof.
4. **Done means reachable.** A host-only deliverable carries an explicit
   "host-only, product surface pending" note and does not close as Done.
5. **PRs only.** No direct-to-main pushes.
6. **One status update per day** on the project: gate state, pass counts,
   blockers.
7. **Doc contention.** Conformance and verification prose lives in
   `docs/agents/mcp-conformance.md`, not in `assistant-providers.md`.
