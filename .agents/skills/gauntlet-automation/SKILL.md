---
name: gauntlet-automation
description: Execute Brainstrike's Gauntlet agent-behavior eval curator automation from `.night-shift/charters/gauntlet.md`. Use for scheduled or manual Gauntlet runs, eval-suite inventory and hash checks, assistant-failure candidate mining from tickets and merged fix PRs, scripted LanguageModelV2 gate authoring with paired control flows, eval-lane timing deltas, and append-only Gauntlet state checkpoints.
---

# Gauntlet Automation

Execute the repository-owned Gauntlet charter without duplicating its policy. Use the bundled collector for the deterministic repo-side evidence; retain judgment for candidate distillation, fixture design, and the control-rule proof.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/gauntlet.md`, the "Deterministic agent-behavior evals (BST-589)" section of `docs/agents/ci-quality.md`, and `docs/agents/assistant-runtime.md` — the eval lane's design rules are settled; you extend the instrument, never redesign it.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over the eval suite, Linear, or GitHub state.
4. Note the UTC start time and the live wall-clock budget. Fetch `origin/main`.
5. Resolve the exact charter-named Linear state issue and its latest append-only protocol-shaped checkpoint. Ignore newer non-checkpoint discussion.
6. Gauntlet is an EXTERNAL-STATE loop: the watched set is processed candidate-source IDs plus the collector's eval-suite hash. Never NOOP on the main diff alone.
7. Resume the one open Gauntlet PR before starting new work. Stop and surface a protocol violation if more than one is open.

Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Gauntlet charter, this skill.

## Collect repo-side evidence

Run:

```bash
node .agents/skills/gauntlet-automation/scripts/collect-gauntlet-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --watermark "$watermark" \
  --pretty
```

The collector performs no repository writes; its only `gh` use is read-only. It:

- validates repository identity and watermark ancestry;
- inventories the eval suite (flow names in both the gate and control suites, spec test titles, a content hash over the eval spec and its runner) and fails visibly if the spec or runner cannot be located — a curator blind to its own instrument must not proceed;
- computes the assistant-territory delta (`packages/agent`, `packages/assistant*`) between the watermark and `origin/main`;
- enumerates merged PRs touching assistant territory since the watermark via `gh`, with complete pagination;
- emits everything as leads — the collector cannot judge whether a change was a behavior-failure fix.

Gather the Linear side yourself with complete pagination: closed assistant-territory bug tickets and night-shift findings since the watermark. A candidate you cannot trace to observed evidence is not a candidate.

When the watched set (source IDs + suite hash) is unchanged and no Gauntlet PR is open, append the NOOP checkpoint and exit.

For a dry-run or audit request, stop after reporting the would-be candidates. Make no writes.

## Author gates under the lane's rules

1. Apply the charter's candidate gate literally (observed, behavior-class, deterministically reproducible against the real runtime, not already covered per the collector's inventory). At most TWO candidates per run, ordered by user impact.
2. Evidence-red first: the fixture must reproduce the original misbehavior and the flow must read `failed` against it — capture that output for the PR body.
3. THE CONTROL RULE is non-negotiable: every new gate ships with a paired control flow proving the gate can fail on its target regression. No control, no ship.
4. Wire the passing flow in and run the eval spec plus the full repository gates green in the same run. Measure and record the eval spec's wall-clock delta — the lane gates every PR, so its runtime is a shared budget.
5. Never touch production code, the runner's design, or any existing flow's assertions; a candidate needing runner changes becomes a fingerprinted `needs-human` ticket.

## Report and checkpoint

Open ONE PR per the charter's title format with the source incident, red proof, control proof, and timing delta. Use `$brainstrike-pr-loop` for stewardship through READY.

Append exactly one protocol-shaped checkpoint whose watermark is the processed source-ID set plus the new suite hash from a collector re-run. Never edit the state description or prior comments. Checkpoint BLOCKED when spec/runner location, pagination, or red-proof reproduction cannot be proven.

Durable fixture-authoring gotchas land in `.night-shift/gauntlet.md` in the same PR. Finish by verifying the PR set, checkpoint, working tree, and automation memory agree. Report NOOP as success — a week with no new observed failure modes is the product working.
