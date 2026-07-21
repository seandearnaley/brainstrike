---
name: watch-automation
description: Execute Brainstrike's Watch flake-investigator automation from `.night-shift/charters/watch.md`. Use for scheduled or manual Watch runs, external workflow-run watermark reconciliation, scheduled E2E and nightly run discovery, CI log and retry evidence collection, stable failure fingerprinting, Linear deduplication and ticket updates, bounded exact-SHA reproduction, flake-versus-regression classification, durable diagnostic learnings, and append-only Watch checkpoints.
---

# Watch Automation

Execute the repository-owned Watch charter without duplicating its policy. Use the bundled collector for deterministic read-only acquisition; retain judgment for fingerprint verification, reproduction, classification, and reporting.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/watch.md`, every top-level `.night-shift/*.md` file completely, and every document the live charter requires.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over repository, GitHub, or Linear state.
4. Note the UTC start time and live wall-clock budget.
5. Resolve the exact charter-named Linear state issue and select its newest comment matching the protocol checkpoint shape. Ignore newer discussion notes that are not checkpoints.
6. Parse the prior external-state watermark as the exact set of workflow-run IDs. Never substitute a main SHA, date, remembered run list, or automation-memory value.
7. Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Watch charter, this skill.

Keep the live charter authoritative for the workflow lookback, fingerprint shape, investigation limit, ticket fields, quarantine recommendation, state title, labels, and schedule. Re-derive them every run.

Stay diagnose-only. Never edit code or tests, retry or cancel CI, weaken an assertion or timeout, add retry masking, create a branch or PR, merge, deploy, migrate, or touch live data.

## Collect external-state evidence

Create a temporary output directory and run:

```bash
watch_logs="$(mktemp -d)"
node .agents/skills/watch-automation/scripts/collect-watch-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --watermark "$watermark" \
  --pretty > "$watch_logs/evidence.json"
```

Omit `--watermark` only for a proven first run.

The collector performs no repository or external writes. It:

- validates the live Watch safety boundary and derives the lookback from the charter;
- derives scheduled E2E and nightly workflows from local workflow definitions, then requires an exact path-and-name match with GitHub;
- fetches every run in the live window with complete pagination and compares the current run-ID set with the supplied watermark;
- stops before job/log collection when the external-state set is unchanged;
- collects all attempts, jobs, failed phases, bounded log excerpts, runner labels and image evidence, workflow rerun recoveries, and test retry signals for newly observed runs;
- emits candidate fingerprints and visibly lists unparsed failures instead of inventing a test title or error class;
- records the current worktree state and optionally reports local listener ownership for reproduction ports.

Treat `failureCandidates`, `passOnRetryCandidates`, and synthetic phase titles as evidence, not verdicts. Read the relevant raw log before accepting each fingerprint. Never search or file from a candidate with `fingerprintReady=false`; refine generic classes such as assertion, error, or test timeout to the demonstrated mechanism first. If `collection.analysisComplete=false`, inspect every listed run manually with `gh run view`; do not classify or file from incomplete parsing.

For a dry-run, audit, skill test, or collector-debug request, stop after reviewing the evidence. Make no GitHub or Linear writes.

When `watermark.noopEligible=true`, prove no Watch-owned open work requires continuation, append the charter-required NOOP checkpoint, update automation memory, and exit before further log or reproduction work.

## Reconcile stable fingerprints

1. Verify the exact workflow, test title or failed phase, error class, commit, runner evidence, attempt history, and run URL from source logs.
2. Normalize only volatile syntax such as line numbers and retry counters. Do not combine failures with different mechanisms merely because they share a test file.
3. Search Linear for the exact charter-shaped fingerprint before any write. Complete pagination and inspect open and closed matches.
4. Update an open match with the new occurrence. State signature drift explicitly and preserve both the old and new evidence.
5. Handle a closed match only as the live protocol and charter permit. Never silently create a replacement ticket.
6. Continue to investigation only for genuinely new fingerprints, ordered and bounded by the live charter.

Read before every Linear write and re-read after it. Surface partial or duplicate writes immediately.

## Reproduce without contaminating evidence

Use an isolated temporary worktree at the run's exact commit. Record the full SHA and preserve the original repository and user worktrees unchanged.

Before starting a server, derive its required host and port from the exact test/configuration. Run the collector again with one `--preflight-port <port>` argument per required listener. If any port is occupied, report the owning process and stop that reproduction attempt. Never kill an existing process, accept an automatically shifted port, or let Playwright target a different server than the one just started. Require strict-port behavior where the repository supports it.

Reproduce with the same test, project, environment, and relevant runner configuration. Keep attempts identical when testing inconsistency. A flake claim requires different outcomes on identical code and configuration; otherwise classify the evidence as a regression, test defect, infrastructure failure, or unresolved mechanism and say why.

Read the applicable `docs/agents/*` contracts before assigning a known root-cause class. Do not infer a class from timing or an error string alone. Stop at the charter's investigation limit and budget boundary.

Remove only the temporary worktree and processes created by this run after proving their identity. Preserve logs needed for the ticket until reporting is complete.

## Report and checkpoint

For each new fingerprint, create one Linear ticket with the live protocol labels and the charter-required evidence, reproduction, classification, mechanism, and disposition fields. Recommend quarantine only when the evidence meets the live charter's standard and use its exact lane shape; never implement quarantine.

Route durable, codebase-specific insights through the charter's pending-learning process. Watch has no repository-edit authority: if a bulletin-file instruction conflicts with diagnose-only scope, make no file edit, surface the conflict, and use only the permitted state/ticket channel.

Append exactly one protocol-shaped checkpoint using the fully observed workflow-run-ID set. Never edit the state issue description or prior comments. Checkpoint BLOCKED when authentication, pagination, log completeness, exact configuration, state identity, or the safety boundary cannot be proven.

Finish by verifying:

- every accepted occurrence maps to one exact fingerprint and Linear ticket;
- every new-fingerprint investigation stayed within the live limit;
- the checkpoint watermark equals the collector's current run-ID set;
- no repository file, CI run, test, branch, or PR changed;
- automation memory records UTC timing, watermark, ticket identifiers, classifications, reproduction status, blockers, and the exact next action.

Report NOOP as success. Never turn incomplete evidence into a confident flake claim.
