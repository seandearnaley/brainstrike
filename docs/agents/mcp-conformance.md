# MCP conformance and verification contract

Owns the MCP verification harness (`@brainstrike/mcp-test-lab`), the production
official-conformance client, the bounded official-runner driver, the evidence
schemas, and the durable official conformance run links. CI trigger shape,
budgets, and the red-`main` exit condition stay in `docs/agents/ci-quality.md`.

## MCP verification harness

### Package boundary

- `@brainstrike/mcp-test-lab` is a Node-only, production-independent verifier.
  It is not a production MCP client and must not enter an application dependency
  graph. It reaches protocol shapes only through `@brainstrike/mcp-tasks-extension`
  (`shared-foundation` in `architecture/domain-map.json`), never through
  production client code.
- A package export may appear only in the layer that implements and
  independently tests it: never advertise a transport, fault coordinate, OAuth
  route, evidence guarantee, or runner before that branch ships its executable
  path and focused verifier. Current public verifier subpaths: `./evidence`,
  `./faults`, `./lab`, `./runner`, `./scenario`.

Guard: `packages/mcp-test-lab/__tests__/package-contract.test.ts`.

### Scenarios and fixtures

- Read the closed `scenario.ts` manifest and negotiated per-fixture `mcpEvidenceCapabilitiesFor` in `evidence-schema.ts`.
  Never restate them; unknown ids fail visibly and no scenario consumes ambient credentials.
- Live provenance shares a 30-second I/O abort per test within a 35-second assertion ceiling.
  Read exact GitHub refs/tag objects; tags, digests and anchors stay strict without cache/retry/skip.
- Every scenario is executable: `modern-reference` and `legacy-reference` have
  `availability: 'executable'`, as do `stdio-reference`, `oauth-reference`,
  `tasks-reference`, and `apps-reference`.
- `modern-reference` is a bounded, source-backed profile of the official SDK v2
  everything server at peeled commit
  `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`, binding its local executable
  digest separately from that upstream pin. A derived profile — `tasks-reference`
  (SEP-2663, `2026-07-28`) and `apps-reference` — records partial upstream
  provenance and must never claim full upstream coverage.
- Listeners are ephemeral loopback on `127.0.0.1` behind the SDK Host/Origin
  validators; `oauth-reference` is executable only over an ephemeral loopback
  listener and closes on token-free zero counts; `stdio-reference` spawns one
  lab-owned child with an explicit empty environment and proves it gone.

Against the pinned SDK a Tasks listen lease cannot be honored, so the
production client rejects it, polling stays authoritative, and both ends share
one closed alias bridge (`tasks-wire-alias.ts`).
Evidence: `mcp-conformance/scenario-manifest.md`.
Guard: `packages/mcp-test-lab/__tests__/scenario-provenance.integration.test.ts`.

### Evidence integrity and schema

- The private artifact-integrity core reads each unique reference once, passes
  an explicit positive byte limit to the reader, copies bytes before SHA-256,
  decodes text as fatal UTF-8, and reports only bounded codes — never content.
- The `./evidence` verifier sanitizes schema metadata and every extracted
  artifact without trusting the schema's `sanitized` assertion, and does so
  before any dependency I/O. The private scanner adds bounded HTML-entity and
  structured JSON decoding under cumulative budgets that fail closed; only a
  detached, deeply frozen bundle is public.
- Evidence schema `1.1.0` makes desktop applicability explicit instead of
  interpreting an absent field: a lab run records the closed
  `{ required: false, reason: 'protocol-lab-only' }` arm, and a desktop-required
  run names the agent-debug profile, app identity, loopback CDT origin and
  renderer, a green Electron E2E command, and every id in the prescribed
  Settings/OAuth/assistant/cancel/restart/config/concurrency/disconnect matrix,
  with declared artifacts per result, one screenshot plus one durable log or
  trace, and a secret-scan claim covering each artifact exactly once.
- Runtime SDK versions match installed packages; fixture source tags and commits stay historical.
  Scenario, protocol, capabilities, versions and provenance match the closed manifest exactly.

Evidence: `mcp-conformance/evidence-integrity.md`.
Guard: `packages/mcp-test-lab/__tests__/evidence-artifact-integrity.test.ts`,
`packages/mcp-test-lab/__tests__/evidence-schema.test.ts`.

### Verification lanes and runner profiles

- Two closed deterministic profiles cover ten case ids:
  - `pr`: 6 cases, 10,000 ms per case, 90,000 ms per run.
  - `exhaustive`: 10 cases, 20,000 ms per case, 270,000 ms per run.
- Selection accepts only `profile`, `caseIds`, `caseTimeoutMs`, and
  `runTimeoutMs`, and cannot exceed its profile.
  Explicit `undefined` values are malformed and never treated as omission.
- Keep a run ceiling above the sum of its per-case ceilings. Why: case limits
  are ceilings, not reserved runtime, so a slow serial run fails per case rather
  than as a run timeout.
- `./runner` runs a selection serially as genuine RED, GREEN, and
  repeat-verification phases under bounded abort and cleanup; missing cleanup
  proof blocks evidence emission. A phase's cleanup reserve (a quarter, at most 1,000 ms) is cut from the end of its deadline, so time spent before the run starts never shrinks it; a late operation timer still does, because cleanup never outlives the case.
  Add a capability to a profile only once its case is executable and independently tested.
- The package CLI derives Git identity and workspace state itself and fixes the
  ticket to `BST-1486`; the repository wrapper rejects a dirty checkout or a
  `GITHUB_SHA` that differs from `HEAD`. Both lanes reach that one CLI:
  `pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json`
  (PRs that change the lab, its dependencies or its wrapper, and every push) and
  `pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json`
  (schedule/manual).

Evidence: `mcp-conformance/runner-profiles.md`.
Guard: `packages/mcp-test-lab/__tests__/runner-manifest.test.ts`, `packages/mcp-test-lab/__tests__/runner.test.ts`,
`scripts/__tests__/run-mcp-verification.test.mjs`.

### Official conformance client and driver

- `apps/desktop/src/mcp/official-conformance-client.ts` accepts only a validated
  URL, an exact `2025-11-25` or `2026-07-28` revision, and the closed scenario
  sets in `packages/assistant-contract/src/official-auth-conformance.ts` — the
  one typed authority for names, per-revision applicability, evidence paths,
  tickets, schemas, execution strategy, and budgets. An unknown, inapplicable,
  or fabricated pairing fails before runtime creation; nothing falls back.
- Drive the production path only: production config loader, a fresh
  `DesktopMcpHostRuntime`, list/call through `McpHostPort`. Never build a
  parallel SDK client or an unowned probe request. Every run closes the host,
  clears ephemeral OAuth state, and rejects a non-empty cleanup report. The
  headless opener accepts only an HTTP `localhost`/`127.0.0.1` authorization
  endpoint and one exact `127.0.0.1` `/mcp/oauth/callback` redirect.
- Negative auth proof requires real resource/metadata requests, the intended rejection and natural exit. Keep production-host/process tests and an early-exit control: alpha.10 `auth/resource-mismatch` can pass a client that never starts.
- `conformance/expected-failures/` holds exactly `2025-11-25.json` and
  `2026-07-28.json`, both the closed `{ "client": string[] }` shape and both
  empty. Accepting a failure takes a reviewed contract change plus a named
  Linear blocker.
- `scripts/run-official-mcp-client-conformance.mjs` validates the pinned
  manifest and both ledgers, then spawns the package's `dist/index.js` through
  `process.execPath` and argv arrays, never a package-manager shim. Upstream CLI
  availability is not an execution count.
- The driver provisions Desktop's Electron runtime once in the parent before the
  first wave. Why: the serial preflight owns Electron's lazy installation, so
  children never race to extract into the shared package directory.
- Never pass `--expected-failures` or auth `--output-dir`, and never inherit
  child stdio. Why: raw auth output carries token bodies and OAuth responses.
  Captured output is line-bounded and sanitized, prints only for a failed
  scenario, and never enters the evidence artifact.

Evidence: `mcp-conformance/official-conformance-client.md`, `mcp-conformance/official-runner-driver.md`, `mcp-conformance/resource-mismatch-process-proof.md`.
Guard: `scripts/__tests__/run-official-mcp-client-core.test.mjs`,
`scripts/__tests__/run-official-mcp-client-modern-auth.test.mjs`,
`scripts/__tests__/run-official-mcp-client-conformance-diagnostics.test.mjs`.

## Official conformance evidence (BST-1589)

- The first complete green official auth dispatch was
  [run 33541373505](https://github.com/seandearnaley/brainstrike/actions/runs/33541373505):
  28/28 baseline auth and 11/11 modern auth closeout, zero expected failures.
  The same matrices passed twice more at merged-main commit
  `f76ec5149fa435a541eca2c56e42be02da6d7e32` in
  [run 33545728828](https://github.com/seandearnaley/brainstrike/actions/runs/33545728828)
  and
  [run 33545945643](https://github.com/seandearnaley/brainstrike/actions/runs/33545945643).
  Link the run; a count copied into prose is not evidence. This is protocol-lab
  proof, not packaged Electron or live-provider acceptance.
- One root command builds the contract and the Desktop main bundle, then runs
  one profile:

```bash
pnpm run verify:mcp:official
pnpm run verify:mcp:official -- --profile core
pnpm run verify:mcp:official -- --profile modern-closeout
```

- Each profile writes only its own atomic, mode-0600 artifact under
  `packages/mcp-test-lab/artifacts/`; no raw auth artifact directory exists. The
  baseline keeps schema `1.0.0` with no `profile` field, core and
  modern-closeout use `1.1.0` and record theirs.
- `required: true` in that artifact mirrors the absence of `continue-on-error`
  on the official jobs, not whether the run happened in CI, so a local run
  writes the same value.

The official package stays prerelease, its three jobs are required
post-merge gates that detect rather than block, and both ledgers stay empty.
Evidence: `mcp-conformance/official-run-evidence.md`.
Guard: `scripts/__tests__/mcp-verification-ci-contract.test.mjs`.

### Process-group teardown

- Job and step budgets belong to `docs/agents/ci-quality.md`; contract tests
  compare the workflow to the shared descriptor. Change a timeout only with its
  arithmetic, and never shorten the 45-second per-scenario deadline.
- On Windows the driver joins Desktop's `@brainstrike/windows-job-native`
  kill-on-close Job Object before the first spawn and every child inherits it.
  Sequential runs clean a scenario's descendants before the next starts;
  parallel runs defer cleanup until every sibling in a wave settles.
- POSIX group teardown is three-valued and stays that way.
  `ESRCH` is the only proof the group is gone, while `EPERM` from `kill(2)`
  against a group of our own descendants is inconclusive rather than a denial —
  poll on as for a live group. A group still unsignalable at the confirmation
  deadline is a real permission failure, and the error names the state it gave
  up on.
- The ruling ports but its mechanism does not: the `EPERM` arm is observable
  only on Darwin, so the paired test asserts the kernel-appropriate not-gone
  state, not `EPERM` everywhere.
- Timeout, failed start, failed exit, and cleanup failure stay visible; there is
  no process-enumeration fallback.

Teardown follows the same rule as `packages/agent/src/fence/fence-executor.ts`.
Evidence: `mcp-conformance/posix-group-teardown.md`.
Guard: `scripts/__tests__/run-official-mcp-client-conformance-process-group.test.mjs`.
