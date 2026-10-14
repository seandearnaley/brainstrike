# Assistant Reasoning Persistence (Restore on Reload) — Design

- **Date:** 2026-06-05
- **Workstream:** #4a of 5 (reasoning + prompting / selection) — the reasoning-persistence sub-project
- **Branch:** `harden/assistant-reasoning-persistence`
- **Scope:** Restore persisted reasoning parts when a thread is rehydrated (offline-testable). 4b (harness-aware prompt) and 4c (selection data-flow) are separate, deferred sub-projects (offline-now / live-later per decision).
- **Status:** Approved sub-project + grounding; pending spec review.

## Problem

The assistant streams `reasoning-delta` chunks and renders them live (`LocalReasoningPart` /
`LocalChainOfThought` in [assistant-ui-panel.tsx](https://github.com/seandearnaley/brainstrike/blob/b0b960a2bd36cb7f86f2150cfc8572739032b72a/packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx)),
but **reasoning disappears on reload**. Thread history is rehydrated by
`toAssistantHistoryContentParts` in
[assistant-memory-repository.ts:598-627](https://github.com/seandearnaley/brainstrike/blob/b0b960a2bd36cb7f86f2150cfc8572739032b72a/packages/app-shell/src/assistant-memory-repository.ts),
which reconstructs only `text` and `tool-call` parts from the persisted message
`content`. Any `reasoning` part present in `content` is silently dropped, and the hydrated
part union (`AssistantHydratedContentPart`, line 495) doesn't include reasoning.

Assistant messages are persisted by **Mastra memory** into `mastra_messages.content` (this
repository only *reads* that content and writes run-events/threads/runs). Mastra persists
structured parts — `tool-call` parts survive and are reconstructed — so reasoning parts are
expected to be present in `content` too; only the hydration step discards them.

## Goal

When a thread is reloaded, previously-generated reasoning is reconstructed from the persisted
message content and rendered (collapsed, via the existing `LocalReasoningPart`), so reasoning
is "recorded like everything else."

## Non-Goals (separate sub-projects / follow-ups)

- 4b: harness-aware system prompt + precise tapestry-selection guidance.
- 4c: selection data-flow (ensuring chunks carry line ranges; `skippedForMissingSourceRange`).
- Reasoning *clarity* restyling (the renderer already exists and collapses by default).
- Re-sending prior reasoning back to the model as input (`convertMessagesToMastra` stays
  text-only — you don't resend reasoning as context; that's correct).
- Any DB schema migration: reasoning rides in the existing `mastra_messages.content` JSONB
  (no new column).

## Design

Single change point: `toAssistantHistoryContentParts` + the hydrated part union in
`packages/app-shell/src/assistant-memory-repository.ts`.

### Unit 1 — reconstruct reasoning parts on hydration

1. Widen the hydrated part union to include reasoning:

```ts
type AssistantHistoryReasoningPart = Extract<AssistantHistoryMessagePart, { type: 'reasoning' }>;
type AssistantHydratedContentPart =
  | AssistantHistoryTextPart
  | AssistantHistoryToolCallPart
  | AssistantHistoryReasoningPart;
```

`AssistantHistoryMessagePart` is derived from the assistant-ui history adapter's message
content part union (`AssistantHistoryLoadResult['messages'][number]['message']['content'][number]`),
which includes a `reasoning` variant. The implementer confirms the exact reasoning part
shape from the assistant-ui types (expected `{ type: 'reasoning'; text: string }`); if the
adapter's content type does not expose `reasoning`, that is reported as a blocker (it would
mean the renderer can't accept hydrated reasoning, changing the approach).

2. Add a reconstruction branch in `toAssistantHistoryContentParts`, alongside the existing
`text` and `tool-call` branches:

```ts
if (record['type'] === 'reasoning') {
  const reasoningText =
    typeof record['text'] === 'string'
      ? record['text']
      : typeof record['reasoning'] === 'string'
        ? record['reasoning']
        : '';
  const trimmed = reasoningText.trim();
  if (trimmed) {
    parts.push({ type: 'reasoning', text: trimmed });
  }
  continue;
}
```

Handle both `text` and `reasoning` string fields defensively (AI-SDK/Mastra reasoning parts
have used both shapes); emit the assistant-ui reasoning part shape. Empty reasoning is
dropped (no empty "Thinking" panels).

3. No renderer change: `LocalReasoningPart` already renders reasoning content and
`LocalChainOfThought` collapses it by default, so a hydrated reasoning part renders
identically to a live one.

## Testing (deterministic, offline)

In a new test for the repository's hydration (or the existing repo test file if present):

1. **Round-trip (RED first):** given a persisted assistant message whose `content` is a
   parts array containing `{ type: 'reasoning', text: 'because X' }` (plus a `text` part),
   `toAssistantHistoryContentParts` returns a `reasoning` part with `text: 'because X'`
   *and* the text part. Fails today (reasoning dropped).
2. **Field fallback:** a reasoning part shaped `{ type: 'reasoning', reasoning: 'alt' }`
   reconstructs to `{ type: 'reasoning', text: 'alt' }`.
3. **Empty reasoning dropped:** `{ type: 'reasoning', text: '   ' }` produces no part.
4. **Regression:** existing text + tool-call reconstruction still works (run the existing
   repo tests).

The test exercises the pure hydration function (the function may need to be exported, or the
test drives it via the public load path with a fixture). End-to-end confirmation that Mastra
actually persists reasoning into `content` is a **live-later** step (per the offline-now
decision); the offline round-trip test proves the hydration contract, and the fix is a no-op
(not a regression) if a given turn has no persisted reasoning.

CI-parity gate (AGENTS.md): build + lint + type-check + unit/integration green together
before opening the PR.

## Risks & mitigations

- **assistant-ui history content type lacks a `reasoning` variant** → `Extract<...>` is
  `never` and the push won't type-check. Mitigation: the implementer confirms the type first
  (Unit 1 step 1); if absent, report a blocker rather than forcing a cast.
- **Mastra doesn't persist reasoning into `content`** → the hydration fix is correct but a
  no-op until a capture step exists. Mitigation: documented as a live-later confirmation; the
  offline round-trip test still proves the hydration contract; a capture follow-up is a
  noted next step if live shows reasoning isn't persisted.
- **Reasoning shape variance** (`text` vs `reasoning` field) → handled by the dual-field
  read.

## Files (anticipated)

- Edit: `packages/app-shell/src/assistant-memory-repository.ts` (part union + reasoning
  reconstruction; possibly export the function for testing).
- New/Edit: a unit test for `toAssistantHistoryContentParts` reasoning reconstruction.

## Out of scope (later)

4b prompt rewrite, 4c selection data-flow, reasoning restyling, reasoning capture if live
shows Mastra doesn't persist it.
