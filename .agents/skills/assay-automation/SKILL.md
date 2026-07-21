---
name: assay-automation
description: Execute Brainstrike's Assay PR risk-grading automation from `.night-shift/charters/assay.md`. Use when running, dry-running, debugging, or maintaining the Assay loop; grading open non-draft PRs; reconciling `review/*` risk labels and the single Assay brief; or refreshing Assay's Linear review queue and state checkpoint.
---

# Assay Automation

Run Assay consistently while keeping the repository charter authoritative. Use the bundled collector for deterministic read-only discovery; retain human judgment for the final grade and brief.

## Authority and scope

1. Work from the Brainstrike repository root.
2. Read `AGENTS.md`, `.night-shift/PROTOCOL.md`, `.night-shift/charters/assay.md`, and every `.night-shift/*.md` file completely.
3. Use the collector's `pinGuidance` locations to read the current pin sections in `docs/agents/ci-quality.md` and `docs/agents/database.md`. Read additional surrounding contract sections whenever the diff touches them.
4. Resolve conflicts in this order: repository instructions and architecture docs, protocol, Assay charter, this skill.
5. Never copy the rubric, charter version, label allowlist, pin list, state title, or loop schedule into this skill. Re-derive them every run.
6. Stay annotate-only: never approve, request changes, edit code, merge, deploy, or touch labels outside `review/*`. Never add or remove `coverage`.

## Run the deterministic preflight

Run:

```bash
node .agents/skills/assay-automation/scripts/collect-assay-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --pretty > /tmp/assay-evidence.json
```

The collector performs no writes. It:

- derives the charter version and allowed labels from the live charter;
- fails closed if any workflow or composite action contains a literal `review/*`, GitHub returns incomplete file pagination, or a PR head moves during collection; this scan is a tripwire, not proof — also review `labelSensitiveAutomation` (workflows reacting to label events or reading label names via expressions) and confirm none consumes a `review/*` label;
- enumerates open PRs and excludes drafts;
- computes work keys and checks marker-plus-label cache validity;
- gathers complete changed-file statistics, reads full patches for signals, and reports CI state, live pin guidance, factor candidates, and existing Assay comments;
- reports missing allowed labels and unexpected `review/*` repository labels.

Treat `factorCandidates` as evidence, not a verdict. Read the relevant diff before applying every factor. In particular, verify generated-file classification, behavior changes without tests, public API compatibility, dependency pins, and semantic test weakening manually against the live rubric.

For a dry-run or audit request, stop after reviewing the evidence and report what would change. Make no GitHub or Linear writes.

## Enforce the safety boundary

If the collector exits with `contract-violation`:

1. Stop all GitHub annotation.
2. Search Linear for the stable fingerprint before creating anything.
3. Create or update one `needs-human` ticket exactly as the protocol requires.
4. Append a BLOCKED checkpoint to Assay's state issue.

Fail visibly if GitHub authentication, repository identity, charter parsing, Linear access, or required pagination cannot be proven. Do not guess or silently degrade.

## Execute the charter beats

1. Ensure every charter-derived allowed label exists. Create only missing labels; do not rename, recolor, or repurpose existing labels.
2. For each eligible PR with `cache.valid=true`, skip grading. A matching work-key marker alone is insufficient when labels drifted.
3. For every remaining PR, inspect the full patch and relevant source/tests. Apply the charter's mechanical factors and grade formula exactly. Choose the higher grade when genuinely uncertain and state why.
4. Reconcile the PR to exactly one risk label plus supported factor labels. Remove only stale `review/*` labels.
5. Reuse the existing Assay marker comment. Edit it in place through the GitHub issue-comment API; create a comment only when no Assay marker comment exists. Never create a second Assay brief.
6. Keep the brief within the charter's line budget. Include one explicit `Labels:` line containing the exact asserted `review/*` labels so later runs can verify cache integrity mechanically.
7. Refresh the single Linear digest by fully replacing its generated description. Order eligible PRs by risk descending, then age descending. State clearly when the eligible queue is empty and list excluded draft numbers separately.
8. Append one checkpoint comment to the state issue. Never edit its description or earlier comments.
9. Record pending learnings only for a demonstrated rubric blind spot, with the required deduplicated Linear proposal. Never drift the rubric inside the skill.

Use connected GitHub and Linear tools for writes when available. Use `gh` for complete patches, exact label reconciliation, and editing an existing issue comment when the connector cannot prove those operations. Read before every write and verify the resulting remote state afterward.

## Finish the run

Verify:

- the eligible PR set still matches the heads graded;
- every processed PR has exactly the intended `review/*` labels and one Assay marker comment;
- the digest and checkpoint reflect the same queue and watermark;
- no repository file changed;
- automation memory records the run time, result, and stable identifiers when an Automation ID is present.

Report NOOP as success when nothing required grading. Surface any partial external write explicitly.
