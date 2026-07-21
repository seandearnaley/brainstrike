---
name: pruner-automation
description: Execute Brainstrike's Pruner dead-code burndown automation from `.night-shift/charters/pruner.md`. Use for scheduled or manual Pruner runs, MAIN-DIFF watermark checks, Knip and React Doctor baseline collection, adversarial dead-code verification, one-package cleanup PRs, durable false-positive learnings, and append-only Linear state checkpoints.
---

# Pruner Automation

Execute the repository-owned Pruner charter without duplicating its policy. Use the bundled collector for deterministic advisory counts and logs; retain human judgment for every deletion.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instructions.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/pruner.md`, every `.night-shift/*.md` file completely, and every architecture contract required by the files under consideration.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over repository or remote state.
4. Note the UTC start time and live wall-clock budget.
5. Fetch `origin/main`, then resolve state in protocol trust order: an open `night-shift/pruner/*` PR, repository HEAD, the exact Linear state issue and latest checkpoint, then nothing.
6. Require an exact MAIN-DIFF watermark from trusted state. Do not guess one. For a first-ever run, establish the baseline from current `origin/main` and create the charter-required state issue or missing loop label before checkpointing.
7. Resume the single open Pruner PR before starting another. Stop and surface a protocol violation if more than one exists.

When the watermark range is empty, no Pruner PR is open, and no reopened Pruner ticket needs work, append a NOOP checkpoint and stop before running expensive scans.

## Collect the advisory baseline

Create a temporary directory, then run:

```bash
pruner_logs="$(mktemp -d)"
node .agents/skills/pruner-automation/scripts/collect-pruner-baseline.mjs \
  --repo /absolute/path/to/brainstrike \
  --logs-dir "$pruner_logs" \
  --pretty > "$pruner_logs/baseline.json"
```

The collector performs no repository or external writes (its Git reads disable
optional locks, fsmonitor, and the untracked cache so `status` never rewrites
the index). It:

- runs `pnpm knip` and `REACT_DOCTOR_NO_TELEMETRY=1 pnpm run doctor -- --json` without shell pipelines;
- preserves each command's real exit code and distinguishes findings from operational failure for BOTH tools — Knip via exit-code + category counts, Doctor via its structured `--json` report (`ok`/`summary`), never scraped CLI copy;
- classifies a completed Doctor scan with error-severity diagnostics as a `findings` outcome (exit 1 is expected there), and only `ok:false` as operational failure; skipped checks are surfaced as `incompleteResults`, never treated as a clean bill;
- records Git heads, branch, worktree status, and exact log paths;
- fails visibly when repository identity, command execution, or report parsing cannot be proven.

Read `baseline.json` and both raw logs. Treat counts as observations, not deletion authority. Never infer safety from a clean-looking Knip row or a Doctor run with `incompleteResults=true`.

## Select and verify one package

1. Group actionable findings by package and apply the live charter's package-selection limit and prior-rejection rule.
2. Search Linear for each stable fingerprint before filing or updating a finding.
3. Adversarially verify every proposed deletion against all surfaces named by the live charter. Use `rg` from the repository root and inspect relevant config, manifests, scripts, workflows, worker aliases, package exports, packaging rules, tests, and `knip.jsonc` semantics directly.
4. Reject a deletion when any concrete consumer exists. Route genuinely ambiguous public exports, native binaries, worker entries, packaging-only dependencies, or dynamic resolution through the charter's Linear path.
5. Never make a finding disappear by adding an ignore, widening an allowlist, or weakening a check.

NOOP is success when no candidate survives verification.

## Make one mechanical cleanup

Follow the live charter exactly for branch, PR title, removal limit, and checkpoint status. Remove only the proven-dead code and its now-obsolete allowlist entries. Do not refactor neighboring code or combine packages.

Before writing, re-read the selected files and confirm the working tree contains no overlapping user changes. Use red-green TDD when behavior or a guard changes. Stop for confirmation before destructive work outside the charter's small, proven deletion scope.

## Verify and finish

1. Run Knip and Doctor again through the collector and prove the total advisory count decreased.
2. Run the selected package's build, type check, and tests plus every repository-required gate in one final run. Do not use CI as the first test runner.
3. Re-check the diff for package scope, obsolete allowlist removal, lockfile accuracy, and unrelated changes.
4. Create at most one PR and never merge or enable auto-merge.
5. Append exactly one Linear checkpoint using the fully processed `origin/main` SHA. Never edit the state description or prior comments.
6. Add a Pruner learning only for a durable, codebase-specific trap established by the run, and include it in the same PR.
7. Update automation memory with start/end times, watermark, before/after counts, decision evidence, validation, and stable remote identifiers.

Report repository files changed, nearby files intentionally untouched, and follow-ups. Surface partial external writes or operational failures explicitly.
