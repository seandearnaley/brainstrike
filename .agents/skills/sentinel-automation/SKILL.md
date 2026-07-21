---
name: sentinel-automation
description: Run Brainstrike's Sentinel night-shift security-maintainer loop from its repository charter. Use for scheduled or manual Sentinel sweeps, MAIN-DIFF watermark checks, changed-file secret scanning, known hardening-class review, security-boundary triage, Sentinel PR continuation, private live-exposure escalation, and append-only state checkpoints.
---

# Sentinel Automation

Execute the repository-owned Sentinel charter without duplicating its policy. Treat `.night-shift/PROTOCOL.md`, `.night-shift/charters/sentinel.md`, repository instructions, and subsystem contracts as authoritative.

## Establish authority and state

1. Resolve the repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/sentinel.md`, every `.night-shift/*.md` file, and every document the live charter requires.
3. Read the architecture contract for every changed subsystem before editing it. Never infer a contract from filenames alone.
4. Note the UTC start time and the live charter's wall-clock budget.
5. Use connected GitHub and Linear tools directly. Read before writing.
6. Resolve, in protocol trust order:
   - any open `night-shift/sentinel/*` PR;
   - the exact `STATE_ISSUE` from the live charter and its latest append-only checkpoint;
   - any reopened Sentinel-owned ticket that requires continuation.
7. Fetch `origin/main`. Require an exact MAIN-DIFF watermark from trusted state. Do not guess one or silently substitute a merge base. On first-ever setup, establish the baseline explicitly from repository evidence and record why.

Resume the single open Sentinel PR before starting another. If more than one exists, stop and surface the protocol violation.

## Collect read-only evidence

Run the bundled collector after fetching and resolving the watermark:

```bash
node .agents/skills/sentinel-automation/scripts/collect-sentinel-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --watermark "$watermark" \
  --pretty
```

The collector:

- validates the live charter and required repository files;
- proves the watermark is an ancestor of `origin/main`;
- inventories first-parent commits and changed files;
- checks for an existing Sentinel PR through `gh`;
- runs the repository's own secret scanner against the changed blobs at `origin/main`;
- reports changed-file candidates for known hardening classes and security-boundary surfaces;
- emits no secret contents and performs no GitHub, Linear, branch, or working-tree writes.

Treat candidate matches as triage leads, never as findings. Inspect the exact diff and relevant contracts. The collector intentionally does not resolve Linear state, assess exploitability, choose a finding, edit code, or checkpoint the run.

## Apply the evidence gate

Follow the charter's three sweep lenses. For each candidate, require a concrete attack path: actor, required access, reachable surface, and security effect. A silent degradation of a security control is a finding because Brainstrike requires fail-closed behavior.

Reject style preferences, hypothetical mechanisms with no reachable path, and findings already covered by an open ticket or PR. Before filing anything, derive the protocol fingerprint and search Linear for it verbatim. Update an open twin; reopen a closed twin only when the relevant code hash changed.

Select at most one finding. NOOP is success.

## Act without disclosing live exposure

- For hardening safe to describe publicly, use the protocol branch name, make the smallest relevant change, add a regression test that fails on the old code, and update `.night-shift/sentinel.md` in the same PR.
- For a live secret, actively exploitable weakness, or attacker-helpful description, make no telegraphing code or public metadata change. Create only the minimal private escalation allowed by the charter, with the required labels and no exploit details in public surfaces.
- When a defect class reaches the charter's recurrence threshold, deduplicate and route the guard-script proposal to Axiom.
- Never merge, enable auto-merge, deploy, migrate, touch live data, weaken a check, or add a retry to force CI green.

Before any external write, re-read the target and verify the fingerprint, labels, and disclosure classification. After writing, re-read it and confirm the visible state matches the intended state.

## Verify a public hardening change

1. Prove the new regression test fails against the old implementation.
2. Restore the fix and run affected package tests.
3. Run the repository-required build, lint, type check, unit tests, and other required gates together after the final change.
4. Manually exercise the affected boundary when the repository instructions require it.
5. Never use CI as the first test runner and do not loop on non-blocking CI work.

## Finish and checkpoint

Append exactly one checkpoint comment in the protocol format using the fully swept `origin/main` SHA. Never edit the state issue description or an older checkpoint.

- Empty delta, no open Sentinel PR, and no reopened Sentinel ticket: append `NOOP` and exit.
- Public hardening PR: append `PR` with the PR reference and processed watermark.
- Human/security dependency: append `BLOCKED` with the exact safe next action.

Add a bulletin line only when the charter's systemic-drift condition is met. Update the automation memory with the processed range, outcome, external objects changed, validation performed, and UTC completion time. Report repository files changed, nearby files intentionally untouched, and follow-ups.
