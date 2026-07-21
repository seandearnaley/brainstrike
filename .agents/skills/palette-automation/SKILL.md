---
name: palette-automation
description: Execute Brainstrike's Palette accessibility and UI-consistency maintenance automation from `.night-shift/charters/palette.md`. Use for scheduled or manual Palette runs; MAIN-DIFF watermark checks; ARIA, keyboard, focus, imagery, shared-component, tree, or context-action audits; one small verified Palette fix; and append-only Linear state checkpoints.
---

# Palette Automation

Execute the repository-owned Palette charter consistently. Keep the live
charter, protocol, contracts, labels, and state authoritative; do not copy
their policy into this skill.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus every
   applicable nested instruction file.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/palette.md`, and
   every `.night-shift/*.md` file completely. Read
   `docs/agents/ui-conventions.md` before inspecting or changing a tree or
   context-menu surface. Read every other architecture contract required by
   the selected component.
3. Resolve automation memory when an Automation ID is present. Treat it as an
   execution aid, never as authority over repository or remote state.
4. Note the UTC start time and the live wall-clock budget. Fetch `origin/main`.
5. Resolve state in protocol trust order: an open `night-shift/palette/*` PR,
   repository HEAD, then the exact Linear state issue and its latest
   append-only checkpoint. Require a proven MAIN-DIFF watermark; never infer
   one from a date, branch name, or local reflog.
6. For a first run, locate the Night Shift bootstrap commit by inspecting the
   history that introduced the live Palette charter. Sweep that eligible range,
   then create a missing state issue or loop label only as required by the
   live protocol before checkpointing the current `origin/main` SHA. If the
   initial range cannot be proved, stop and surface the block.
7. Resume the one open Palette PR before starting new work. Stop and surface a
   protocol violation if more than one is open.

Resolve conflicts in this order: repository instructions and subsystem
contracts, protocol, Palette charter, this skill.

## Sweep the current UI delta

Inspect only the live charter's scoped UI delta between the trusted watermark
and `origin/main`. Re-derive the paths from the charter each run.

Use the Palette learning classes as audit lenses, not as an excuse to search
the whole repository:

- Identify interactive elements without accessible names, disclosure controls
  without truthful state, inaccessible focus/keyboard behavior, and imagery
  without appropriate semantics.
- Identify a component that duplicates or diverges from the shared UI
  primitive, tree convention, or context-action convention that actually
  owns the behavior.

For every candidate, name the exact element and either the affected user or
the diverged shared component. Reject purely aesthetic preferences. Route a
layout, color, copy, or other design decision through the live Linear process
instead of changing code.

When the scoped range is empty, no Palette PR is open, and no reopened Palette
ticket requires work, append the charter-required NOOP checkpoint and stop.
Do not run unrelated expensive checks merely to manufacture activity.

## Make at most one mechanical fix

Before writing, search Linear for the protocol fingerprint and handle an
existing issue exactly as the protocol requires. Re-read the selected source,
tests, and existing shared-component pattern. Preserve unrelated working-tree
changes.

Implement at most one eligible finding, or the charter-permitted same-class
batch in one component family. Extend the owner in `@brainstrike/ui` when it
owns the behavior; do not create a local fork. Keep the diff mechanical and
within the live charter's title, branch, and PR limits.

For interaction changes, first add or extend a targeted test that proves the
ARIA state, accessible name, focus behavior, or keyboard behavior. Prefer the
repository's role, text, and test-id selector style. Do not reduce selector
viability, weaken checks, add fallbacks, or silently degrade an unsupported
capability.

## Verify, checkpoint, and finish

For a code change, run the affected package tests, `pnpm doctor`, and every
repository-required gate in one final run. Confirm no new error-severity
Doctor issue was introduced. Re-check the final diff for scope, source of
truth, test coverage, and unrelated changes before proposing a PR. Follow
current repository authorization rules for every remote write; never merge,
enable auto-merge, deploy, or alter live data.

Append exactly one state comment using the fully processed `origin/main` SHA.
Never edit the state description or prior checkpoints. Add a Palette learning
only for a durable, codebase-specific recurrence; when the live charter's
recurrence threshold is met, follow its ticket and bulletin requirements.

After each external write, re-read the affected remote state. Finish by
verifying the open-PR set, checkpoint, working tree, and automation memory
agree. Record the UTC completion time, outcome, watermark, validation, and
stable remote identifiers in automation memory when an Automation ID is
present. Report NOOP as success and surface every partial write or block.
