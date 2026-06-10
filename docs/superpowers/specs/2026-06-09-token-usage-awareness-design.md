# Token Usage Awareness — Design

**Date:** 2026-06-09
**Status:** Approved (brainstorm spec)
**Scope:** One PR (after the grep-search PR). Context-window model metadata + thread context meter
+ Mastra-native windowing so the agent and the user both know tokens used/available.

## Problem

Token usage is captured end-to-end today but surfaced nowhere, and nothing knows any model's
context window:

- Mastra finish parts carry usage; `makeFinishChunk`
  (`packages/agent/src/mastra/agent-runtime.ts`) extracts `promptTokens`/`completionTokens`;
  `packages/agent/src/stream/data-stream-mapper.ts` normalizes to `{inputTokens, outputTokens}`
  on the wire. The renderer discards it.
- `LlmModelDefinition` (`packages/assistant-contract/src/provider-registry.ts`) has no
  `contextWindow`. The UI's `ModelPickerModel.contextWindow?` exists but is never populated. Only
  `LocalLlmModelCapabilities.contextWindow` is real.
- Mastra's `TokenLimiter` input processor is wired via `agentLoop.inputTokenLimit`
  (`buildToolLoopOptions`) but nothing ever sets the limit — it is dormant.
- No compaction story: long threads silently degrade when they exceed the provider window.

## Goals

- Every model declares its context window; the build fails if a new model omits it.
- A thread context meter: tokens used vs available, warning states, estimated-vs-exact provenance.
- The agent loop derives its input token budget from the active model automatically.
- Long threads age out of the prompt via Mastra-native windowing while staying recallable.

## Non-Goals (user-selected, clean follow-ups)

- Per-message usage footers.
- Composer live draft estimate.
- Model-picker context-window display (metadata will exist; display deferred).
- Explicit `/compact` summarize-and-replace (Claude-Code-style). Mastra has no built-in
  summarize-compaction; windowing was chosen instead.
- Persisting usage counters to the DB (no schema change in this PR).

## Decision Record

- **Compaction = Mastra-native windowing** (`lastMessages` + semantic recall + existing
  observational memory), not history rewriting.
- **UI surface = thread context meter only.**
- **`contextWindow` lives in the static registry only** — it is an intrinsic model property, not a
  user preference, so no DB model-catalog migration (sidesteps the dual-ledger rule entirely).
  Consumers join the static registry by model id at read time.

## Architecture

### 1. Model metadata — `packages/assistant-contract/src/provider-registry.ts`

- Add to `LlmModelDefinition`: `contextWindow: number` (**required**) and
  `maxOutputTokens?: number`.
- Required-ness is the enforcement point: any future catalog addition without a context window is
  a compile error, not a production surprise.
- Local models derive from `LocalLlmModelCapabilities.contextWindow` (already real, reported by
  the Gemma engine).
- Populate `ModelPickerModel.contextWindow` from the registry join (field exists, unpopulated).

### 2. Usage accounting store (renderer)

Per-thread context accounting, fed by data already on the wire:

- **Exact:** on each `message-finish`, meter value = that turn's `inputTokens + outputTokens`
  (the next prompt's baseline ≈ previous prompt + new content; this one-turn-lag estimate is the
  industry-standard meter construction).
- **Estimated:** on thread load before any turn completes, seed from `countTokensHeuristic`
  (`@brainstrike/utils`, len/4) over stored messages; flag provenance `estimated`. Flip to `exact`
  when real usage lands.
- Local-LLM path: the llm-host adapter (`packages/ui/src/assistant-ui-panel/local-runtime-adapter.ts`)
  forwards Gemma's tokenizer-true usage into the same store.
- Store shape: small zustand store keyed by threadId (session-lived; no persistence in v1).
- Wiring: `data-stream-runtime.ts` already decodes finish chunks — expose usage via the existing
  runtime adapter seam to `packages/app-shell`.

### 3. Thread context meter (UI)

In the assistant panel toolbar (`packages/ui/src/assistant-ui-panel/`):

- Compact gauge + text (`12.4K / 200K`), `formatTokenCount` for display.
- Thresholds: amber ≥75%, red ≥90% of the *effective input budget* (see §4), not the raw window.
- Tooltip: explains the number, shows estimated-vs-exact provenance.
- At red: informational state — "older messages are summarized out of context" (windowing), no
  destructive action.

### 4. Agent-side budget derivation

In `buildToolLoopOptions` (`packages/agent/src/mastra/agent-runtime.ts`):

- When the caller does not override `agentLoop.inputTokenLimit`, derive it:
  `effectiveInputBudget = contextWindow − (maxOutputTokens ?? 4096) − safetyMargin`, where
  `safetyMargin = max(1024, 5% of contextWindow)`. Both constants live beside the derivation as
  named exports (tunable, single definition site).
- This activates the already-wired `TokenLimiter` (truncate, contiguous), including per-step
  pruning during multi-step tool loops — the place context actually explodes.
- Explicit caller override still wins (existing strict parse rules unchanged).
- Malformed/missing metadata for the active model → throw (no-silent-fallback), which the
  required field makes impossible for registry models anyway.

### 5. Mastra memory windowing

- Configure `lastMessages` on the existing Memory instance (PGlite-backed store) alongside the
  observational memory already in use, so aged-out turns remain recallable via
  recall/observational paths rather than lost.
- Inject a one-line context-budget note into instructions at request-build time
  ("~N tokens of context remain") so the model can adapt verbosity and suggest a new thread.

## Error Handling

- Unknown model id at budget-derivation time → throw with the model id (strict).
- Usage chunks absent for a provider/turn → meter keeps prior value and provenance stays
  `estimated`; never fabricate exact numbers.
- Heuristic seed is clearly flagged; UI never displays an estimated number as exact.

## Testing

- Unit: budget math (window − output − margin), provenance flip estimated→exact, threshold states,
  `formatTokenCount` rendering.
- Agent: `buildToolLoopOptions` derives `inputTokenLimit` from model metadata; override
  precedence; strict throw on unknown model.
- UI: meter component states; data-stream finish-chunk → store update via existing
  `setupAssistantMock` harness (add a usage-bearing mock variant if missing).
- Contract: type-level requirement means registry compiles only with `contextWindow` present on
  every model.
- Full suite green in one run before completion.

## Documentation

- Update AGENTS.md "MODEL CATALOG MIGRATIONS" section: adding a model now also requires
  `contextWindow` (compile-enforced) — note that this field is static-registry-only and needs no
  DB migration.
