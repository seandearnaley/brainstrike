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
