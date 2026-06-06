# Harness-Aware Agent Prompt + Precise-Selection Guidance — Design

- **Date:** 2026-06-05
- **Workstream:** #4b of 5 (the prompt sub-project of #4)
- **Branch:** `harden/assistant-harness-prompt`
- **Scope:** Targeted additions to the agent system prompt (`buildDefaultInstructions`). Selection data-flow (4c) is a separate deferred sub-project.
- **Grounding:** Deterministic prompt-content tests now; real model behavior validated live later (per the offline-now decision).
- **Decision:** Precise-by-default selection guidance.
- **Status:** Approved approach + decision; pending spec review.

## Problem

The agent system prompt ([default-instructions.ts](../../../packages/agent/src/mastra/default-instructions.ts)) already
guides precise selection inside a `curationInstruction`, but with two gaps the user hit:

1. **Precise selection is gated** behind "When the user asks you to curate ideal reusable
   context," so a plain request like "select the database files and pick specific chunks"
   may never trigger the Tapestry-range workflow → the model selects whole files.
2. **No harness/visual framing.** The prompt never tells the model it runs inside an
   interactive IDE where the user *watches* a context explorer, that the selection tools
   *drive that visible UI*, and that selections become context the user forwards to an LLM —
   the motivation for precise boundaries.
3. **Tapestry mechanics aren't explicit** (1-based inclusive `{startLine,endLine}` ranges,
   mapped directly from query-result source line ranges).

## Goal

The prompt makes precise Tapestry line-range selection the **default** for any
context-selection request (whole files only when genuinely needed), frames the harness +
visual selection workflow, and states the tapestry mechanics — while preserving the existing
graceful tool-availability fallbacks.

## Non-Goals

- 4c selection data-flow (per-chunk line ranges / `skippedForMissingSourceRange`).
- Changing the selection tools or their schemas.
- A from-scratch prompt rewrite (we keep the existing structure and tuned fallbacks).
- Reasoning persistence (#4a, shipped) and toolbar polish (#5).

## Design

All changes are in `buildDefaultInstructions(toolNameMap)` in
`packages/agent/src/mastra/default-instructions.ts`. Keep the existing per-tool availability
gating (each instruction fragment still degrades to its "unavailable" string when a tool
isn't registered).

### Unit 1 — Harness / visual framing (new lines, always present)

Add framing near the top of the returned prompt (after the "helpful assistant" line),
independent of tool availability:

> You run inside the Brainstrike IDE. The user is interactively curating context in a visual
> Context Explorer alongside this chat; the selections you make with the context tools appear
> in that UI and become the context the user feeds to an LLM. Be precise: prefer selecting
> the specific lines that matter over whole files.

### Unit 2 — Ungate precise selection (precise-by-default)

Today the precise-selection guidance lives only in `curationInstruction` (gated on "curate"
requests). Add a **selection-default instruction** that applies whenever the selection tools
are registered, regardless of the word "curate":

> When the user asks you to select, add, or curate context, default to precise Tapestry line
> ranges with `${updateWorkspaceTapestrySelections}`: select only the lines that matter, not
> whole files. Use `${updateWorkspaceContextSelection}` for whole-file selection only when
> the entire file is genuinely needed.

Keep the existing `curationInstruction` (it adds the query→select workflow detail); the new
sentence generalizes the *default*. Both gate on the same tool availability.

### Unit 3 — Explicit Tapestry mechanics

Add a one-line mechanics statement (gated on `queryEmbeddingSpace` +
`updateWorkspaceTapestrySelections`):

> `${queryEmbeddingSpace}` results include 1-based source line ranges per chunk; pass those
> directly as `ranges: [{ startLine, endLine }]` (1-based, inclusive) to
> `${updateWorkspaceTapestrySelections}`.

### Tool-name interpolation

Reuse the existing `getModelFacingToolNames` / model-facing name resolution so the new
sentences reference the same model-facing tool names and degrade gracefully (omit or replace
with the existing "unavailable" fallbacks when a tool is missing). Do not hardcode raw
`brainstrike.*` IDs in the model-facing text; use the resolved names like the current code.

## Testing (deterministic, offline)

New test `packages/agent/src/__tests__/default-instructions.spec.ts` exercising the exported
`buildDefaultInstructions`:

1. **Full toolset:** with a `toolNameMap` mapping all seven context tools to model-facing
   names, the output contains: the harness/visual framing ("Context Explorer" / "visual"),
   the precise-by-default guidance (mentions selecting line ranges over whole files and both
   selection tool names), and the 1-based Tapestry mechanics ("1-based", "startLine",
   "endLine"). Assert via substring/regex on the returned string.
2. **No selection tools:** with a `toolNameMap` lacking the selection tools, the output does
   NOT promise tapestry/selection behavior and instead includes the existing "unavailable"
   fallback wording (no dangling `undefined`/empty tool names; no raw `brainstrike.` IDs
   leaking into model-facing guidance lines).
3. **Empty map:** `buildDefaultInstructions(new Map())` returns a non-empty string with the
   harness framing and "none" available tools (regression of the existing default behavior).

These prove the prompt *content* deterministically. Whether the model then selects precise
chunks is the live-later validation.

CI-parity gate (AGENTS.md): build + lint + type-check + unit/integration green together.

## Risks & mitigations

- **Prompt bloat / regressing tuned guidance:** keep additions to ~3 short sentences; do not
  remove or reword the existing fallbacks beyond adding the new lines. Covered by test #2/#3
  (fallbacks still present).
- **Tool-name leakage:** model-facing lines must use resolved model-facing names, not raw
  IDs — asserted in test #2.
- **Content test ≠ behavior:** explicitly a content contract; behavior is live-later. Stated.

## Files (anticipated)

- Edit: `packages/agent/src/mastra/default-instructions.ts` (3 targeted additions; reuse
  existing name resolution + gating).
- New: `packages/agent/src/__tests__/default-instructions.spec.ts`.

## Out of scope (later)

4c selection data-flow; live behavior validation; any tool/schema change.
