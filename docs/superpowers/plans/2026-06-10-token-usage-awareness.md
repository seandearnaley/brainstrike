# Token Usage Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every model declares its context window, a thread context meter shows tokens used vs available (estimated→exact provenance), and the agent loop auto-derives its input token budget — per the approved spec `docs/superpowers/specs/2026-06-09-token-usage-awareness-design.md`.

**Architecture:** Static-registry metadata (`contextWindow` required on `LlmModelDefinition`, no DB migration) feeds three consumers: a budget-derivation helper (`contextWindow − maxOutput − margin`) that app-shell uses to auto-fill `agentLoop.inputTokenLimit` (activating the already-wired Mastra `TokenLimiter`), a renderer usage store fed by the data-stream `FinishMessage` usage that already crosses the wire (code `'d'`, `{usage:{inputTokens,outputTokens}}`), and a meter component in the assistant panel that falls back to a `countTokensHeuristic` estimate over thread messages until exact usage lands. Mastra-native windowing (`lastMessages`) is already active via `buildMastraMemoryOptions` defaults — verified, not rebuilt.

**Tech Stack:** TypeScript strict (`exactOptionalPropertyTypes`), zustand (non-persisted store), assistant-stream DataStream chunks, Mastra `TokenLimiter`, Vitest.

**Branch:** `feat/token-usage-awareness` (already created off main `b546142fc`).

**Conventions for every task:** run commands from the package dir given; Biome auto-formats on commit (`pnpm dlx ultracite fix` if a hook fails); never assign `undefined` to optional props — spread conditionally; never `any`.

**Plan-time deviations from the spec (deliberate):**
1. **Budget derivation lives in app-shell, not `buildToolLoopOptions`**: the agent package never learns the selected model id (RuntimeData has no model field — verified), but app-shell already joins the registry and builds `agentLoop`. The spec's intent ("auto-derive when the caller hasn't overridden") is preserved; the derivation function + constants live in assistant-contract as named exports per the spec.
2. **No "seed estimate" store action**: the meter computes the heuristic estimate directly from thread messages (`useThread` selector) when no exact usage exists for the thread — same observable behavior (estimated→exact flip), less state.
3. **Memory windowing is a verification task, not a build task**: `buildMastraMemoryOptions` already defaults `lastMessages` (`DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES`) — found during planning.

---

### Task 1: `contextWindow` + `maxOutputTokens` on every LLM model definition

**Files:**
- Modify: `packages/assistant-contract/src/provider-registry.ts`
- Test: extend the existing provider-registry test in `packages/assistant-contract` (find it: `grep -rln "PROVIDER_DEFINITIONS\|getProviderModelDefinitions" packages/assistant-contract/__tests__ packages/assistant-contract/src/__tests__`)

- [ ] **Step 1: Extend the interface**

In `provider-registry.ts`, change `LlmModelDefinition` (lines ~30–36):

```typescript
export interface LlmModelDefinition extends BaseModelDefinition {
  /**
   * Total context window in tokens (input + output). REQUIRED: adding a model
   * without it is a compile error — this drives the thread context meter and
   * the auto-derived agent input token budget. Use the provider's documented
   * standard tier (not beta/extended tiers).
   */
  contextWindow: number;
  /**
   * Provider's documented maximum output tokens, when known. Used to reserve
   * output headroom in the input-budget derivation.
   */
  maxOutputTokens?: number;
  /**
   * Some providers restrict streaming; surface this so the UI can badge support.
   */
  supportsStreaming?: boolean;
  type: 'llm';
}
```

- [ ] **Step 2: Populate every `type: 'llm'` entry**

The build now fails listing every missing entry — that's the enforcement working. Add to each (values are the providers' documented standard tiers; verify against the doc URLs already cited in the file's comments and adjust if the docs say otherwise):

| Models | contextWindow | maxOutputTokens |
| --- | --- | --- |
| All OpenAI `gpt-5.*` (and OpenRouter `openai/*` mirrors) | `400_000` | `128_000` |
| All Anthropic `claude-*` (and OpenRouter `anthropic/*` mirrors) | `200_000` | `64_000` |
| All Google `gemini-*` (and OpenRouter `google/*` mirrors) | `1_048_576` | `65_536` |
| Local `gemma` entry (the `local` provider's LLM entry, id from `GEMMA4_E2B_MODEL_ID`) | `32_768` | `8_192` |
| Any `ollama`/`lmstudio` LLM entries (user-supplied models, window unknowable) | `32_768` (conservative floor; add a comment saying so) | omit |

Entry shape example:

```typescript
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        type: 'llm',
        supportsStreaming: true,
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
      },
```

- [ ] **Step 3: Add a lookup helper**

At the bottom of `provider-registry.ts`, next to the existing exported helpers (find `getProviderModelDefinitions` and mirror its style):

```typescript
/**
 * Resolve a single LLM model definition. Throws on unknown provider/model —
 * token budgeting must never silently guess a context window.
 */
export function getLlmModelDefinition(
  providerId: ProviderId,
  modelId: string
): LlmModelDefinition {
  const provider = PROVIDER_DEFINITIONS.find((definition) => definition.id === providerId);
  if (!provider) {
    throw new Error(`Unknown provider id for LLM model lookup: ${providerId}`);
  }
  const model = provider.models.find(
    (definition) => definition.type === 'llm' && definition.id === modelId
  );
  if (!model || model.type !== 'llm') {
    throw new Error(`Unknown LLM model id for provider ${providerId}: ${modelId}`);
  }
  return model;
}
```

(Adapt to the file's actual internal structures — if `PROVIDER_DEFINITIONS` is not in scope where helpers live, use whatever accessor the existing helpers use.)

- [ ] **Step 4: Tests**

In the existing provider-registry test file, add:

```typescript
describe('contextWindow metadata', () => {
  it('every LLM model declares a positive contextWindow', () => {
    for (const provider of getAllProviders()) {
      for (const model of provider.models) {
        if (model.type === 'llm') {
          expect(model.contextWindow, `${provider.id}/${model.id}`).toBeGreaterThan(0);
          if (model.maxOutputTokens !== undefined) {
            expect(model.maxOutputTokens).toBeLessThan(model.contextWindow);
          }
        }
      }
    }
  });

  it('getLlmModelDefinition resolves a known model and throws on unknown ids', () => {
    expect(getLlmModelDefinition('anthropic', 'claude-sonnet-4-6').contextWindow).toBe(200_000);
    expect(() => getLlmModelDefinition('anthropic', 'no-such-model')).toThrow(/Unknown LLM model/);
    expect(() => getLlmModelDefinition('openai', 'claude-sonnet-4-6')).toThrow(
      /Unknown LLM model/
    );
  });
});
```

(Use the file's actual provider-enumeration helper — `getAllProviders` or equivalent; check what the existing tests import.)

- [ ] **Step 5: Run + fix ripple type errors**

Run from repo root: `pnpm --filter @brainstrike/assistant-contract test && pnpm --filter @brainstrike/assistant-contract type-check`, then `pnpm type-check` repo-wide (other packages may construct `LlmModelDefinition` literals in tests/fixtures — each missing `contextWindow` is exactly the enforcement the spec wants; fill them with a sensible value, e.g. `200_000`).

- [ ] **Step 6: Commit**

```bash
git add packages/assistant-contract
git commit -m "feat(contract): require contextWindow on every LLM model definition"
```

---

### Task 2: Budget-derivation module (TDD)

**Files:**
- Create: `packages/assistant-contract/src/context-budget.ts`
- Modify: `packages/assistant-contract/src/index.ts` (or however `provider-registry` exports reach the package root — mirror it)
- Test: `packages/assistant-contract/src/__tests__/context-budget.test.ts` (place beside the package's existing tests; match their directory)

- [ ] **Step 1: Failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS,
  CONTEXT_BUDGET_SAFETY_MARGIN_MIN,
  CONTEXT_BUDGET_SAFETY_MARGIN_RATIO,
  deriveEffectiveInputBudget,
} from '../context-budget.js';

describe('deriveEffectiveInputBudget', () => {
  it('subtracts maxOutputTokens and the safety margin from the window', () => {
    // 200k window, 64k output, margin = max(1024, 5% of 200k = 10k) = 10k
    expect(deriveEffectiveInputBudget(200_000, 64_000)).toBe(126_000);
  });

  it('defaults maxOutputTokens to 4096 when not provided', () => {
    // 32_768 window: margin = max(1024, 1638.4→1639) ... ratio*window rounded up
    expect(deriveEffectiveInputBudget(32_768)).toBe(32_768 - 4096 - 1639);
  });

  it('enforces the 1024-token minimum margin on small windows', () => {
    // 8k window: 5% = 410 < 1024 → margin 1024
    expect(deriveEffectiveInputBudget(8192, 1024)).toBe(8192 - 1024 - 1024);
  });

  it('throws when the window cannot fit output + margin (no silent floor)', () => {
    expect(() => deriveEffectiveInputBudget(4096, 4096)).toThrow(/cannot fit/);
  });

  it('throws on non-positive windows', () => {
    expect(() => deriveEffectiveInputBudget(0)).toThrow(/positive/);
  });

  it('exposes the constants used by the derivation', () => {
    expect(CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(CONTEXT_BUDGET_SAFETY_MARGIN_MIN).toBe(1024);
    expect(CONTEXT_BUDGET_SAFETY_MARGIN_RATIO).toBe(0.05);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run context-budget` from `packages/assistant-contract`: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
/**
 * Effective input-budget derivation for the agent loop and context meter.
 *
 * effectiveInputBudget = contextWindow − (maxOutputTokens ?? DEFAULT) − margin,
 * margin = max(MIN, ceil(RATIO × contextWindow)).
 *
 * Spec: docs/superpowers/specs/2026-06-09-token-usage-awareness-design.md §4.
 * Throws (never clamps) when the window cannot fit output + margin — a model
 * misconfiguration must surface loudly, not produce a nonsense budget.
 */

export const CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const CONTEXT_BUDGET_SAFETY_MARGIN_MIN = 1024;
export const CONTEXT_BUDGET_SAFETY_MARGIN_RATIO = 0.05;

export function deriveEffectiveInputBudget(
  contextWindow: number,
  maxOutputTokens?: number
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`contextWindow must be a positive number, got ${contextWindow}`);
  }
  const output = maxOutputTokens ?? CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS;
  const margin = Math.max(
    CONTEXT_BUDGET_SAFETY_MARGIN_MIN,
    Math.ceil(contextWindow * CONTEXT_BUDGET_SAFETY_MARGIN_RATIO)
  );
  const budget = contextWindow - output - margin;
  if (budget <= 0) {
    throw new Error(
      `contextWindow ${contextWindow} cannot fit maxOutputTokens ${output} plus safety margin ${margin}`
    );
  }
  return budget;
}
```

- [ ] **Step 4: Export from the package root** the same way provider-registry symbols are exported. Run tests: PASS. `pnpm type-check` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/assistant-contract
git commit -m "feat(contract): effective input-budget derivation with pinned constants"
```

---

### Task 3: App-shell — auto-derive `agentLoop.inputTokenLimit` + populate picker `contextWindow`

**Files:**
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts` (`buildAgentLoopSettings`, lines ~740–752)
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` (`pickerModels` memo, lines ~1355–1381; pass meter props later in Task 7)
- Test: `packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts`

- [ ] **Step 1: Read the current `buildAgentLoopSettings`** (it reads `agentMaxSteps` and `agentInputTokenLimit` from preferences). Extend its signature to also take the selected provider + model id (the wrapper has both — `resolveProviderFromComposite(currentModel)` at wrapper.tsx ~line 295).

- [ ] **Step 2: Failing tests** in the wrapper-runtime test file (mirror its existing harness for `buildAgentLoopSettings`):

```typescript
describe('buildAgentLoopSettings input-token budget', () => {
  it('auto-derives inputTokenLimit from the model contextWindow when the pref is unset', () => {
    const settings = buildAgentLoopSettings(
      { agentMaxSteps: 8 }, // no agentInputTokenLimit
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' }
    );
    // 200k − 64k output − 10k margin
    expect(settings.inputTokenLimit).toBe(126_000);
  });

  it('keeps an explicit user pref over the derived value', () => {
    const settings = buildAgentLoopSettings(
      { agentMaxSteps: 8, agentInputTokenLimit: 50_000 },
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' }
    );
    expect(settings.inputTokenLimit).toBe(50_000);
  });

  it('throws on an unknown model id instead of guessing', () => {
    expect(() =>
      buildAgentLoopSettings({ agentMaxSteps: 8 }, { providerId: 'anthropic', modelId: 'nope' })
    ).toThrow(/Unknown LLM model/);
  });

  it('omits the derived limit when no model is selected', () => {
    const settings = buildAgentLoopSettings({ agentMaxSteps: 8 }, undefined);
    expect(settings.inputTokenLimit).toBeUndefined();
  });
});
```

(Adapt the first parameter's shape to whatever `buildAgentLoopSettings` actually takes today — preserve its existing tests unchanged except where the signature gains the second parameter.)

- [ ] **Step 3: Implement**

```typescript
import {
  deriveEffectiveInputBudget,
  getLlmModelDefinition,
  type ProviderId,
} from '@brainstrike/assistant-contract';

export interface SelectedLlmModelRef {
  modelId: string;
  providerId: ProviderId;
}

// inside buildAgentLoopSettings(selectedProviderSettings, selectedModel?: SelectedLlmModelRef)
const explicitLimit = /* existing agentInputTokenLimit resolution */;
let inputTokenLimit = explicitLimit;
if (inputTokenLimit === undefined && selectedModel) {
  const definition = getLlmModelDefinition(selectedModel.providerId, selectedModel.modelId);
  inputTokenLimit = deriveEffectiveInputBudget(
    definition.contextWindow,
    definition.maxOutputTokens
  );
}
return {
  ...(maxSteps === undefined ? {} : { maxSteps }),
  ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
};
```

Update the wrapper.tsx call site (~line 356) to pass `{ providerId, modelId }` from the already-resolved selection. IMPORTANT: the wrapper renders during onboarding when no model is selected — pass `undefined` then; never throw for "no selection", only for a selection that fails registry lookup.

- [ ] **Step 4: Populate picker contextWindow** — in the `pickerModels` memo (wrapper.tsx ~1367):

```typescript
        models.push({
          id: model.id,
          providerId,
          name: model.label ?? model.id,
          description: null,
          contextWindow: model.contextWindow,
          capabilities: {
            type: 'llm',
            streaming: model.supportsStreaming ?? false,
          },
        });
```

(No picker UI change — display is deferred per the spec's non-goals; this just stops the field being dead.)

- [ ] **Step 5: Run** `pnpm vitest run assistant-ui-panel-wrapper-runtime` then the package's full test + type-check. Green/clean.

- [ ] **Step 6: Commit**

```bash
git add packages/app-shell/src
git commit -m "feat(app-shell): auto-derive agent input token budget from model contextWindow"
```

---

### Task 4: Per-thread usage store in packages/ui (TDD)

**Files:**
- Create: `packages/ui/src/assistant-ui-panel/context-usage-store.ts`
- Test: `packages/ui/src/__tests__/context-usage-store.test.ts` (beside data-stream-runtime.test.ts)

- [ ] **Step 1: Failing tests**

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import {
  resetContextUsageStore,
  useContextUsageStore,
} from '../assistant-ui-panel/context-usage-store.js';

describe('context usage store', () => {
  beforeEach(() => {
    resetContextUsageStore();
  });

  it('records exact usage per thread', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 1200, outputTokens: 300 });
    expect(useContextUsageStore.getState().usageByThread['t1']).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
    });
  });

  it('overwrites with the latest turn (meter shows last-turn totals, not a sum)', () => {
    const { recordUsage } = useContextUsageStore.getState();
    recordUsage('t1', { inputTokens: 1000, outputTokens: 100 });
    recordUsage('t1', { inputTokens: 1400, outputTokens: 200 });
    expect(useContextUsageStore.getState().usageByThread['t1']).toEqual({
      inputTokens: 1400,
      outputTokens: 200,
    });
  });

  it('ignores zero/zero usage reports (providers that omit usage must not flip provenance)', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 0, outputTokens: 0 });
    expect(useContextUsageStore.getState().usageByThread['t1']).toBeUndefined();
  });

  it('clears a single thread', () => {
    const { recordUsage, clearThread } = useContextUsageStore.getState();
    recordUsage('t1', { inputTokens: 10, outputTokens: 10 });
    recordUsage('t2', { inputTokens: 20, outputTokens: 20 });
    clearThread('t1');
    expect(useContextUsageStore.getState().usageByThread['t1']).toBeUndefined();
    expect(useContextUsageStore.getState().usageByThread['t2']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — FAIL.** Then implement:

```typescript
/**
 * Per-thread exact token usage from provider finish chunks (session-lived,
 * deliberately NOT persisted — after reload the meter falls back to the
 * heuristic estimate until the next turn reports exact usage).
 *
 * The stored value is the LAST turn's usage: the next prompt's size ≈ previous
 * prompt + previous output, so inputTokens + outputTokens is the standard
 * context-meter baseline (one-turn-lag estimate; see spec §2).
 */
import { create } from 'zustand';

export interface ThreadTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface ContextUsageState {
  clearThread: (threadId: string) => void;
  recordUsage: (threadId: string, usage: ThreadTokenUsage) => void;
  usageByThread: Record<string, ThreadTokenUsage>;
}

export const useContextUsageStore = create<ContextUsageState>((set) => ({
  usageByThread: {},
  recordUsage: (threadId, usage) => {
    if (usage.inputTokens <= 0 && usage.outputTokens <= 0) {
      return; // provider omitted usage — keep prior value/provenance
    }
    set((state) => ({
      usageByThread: { ...state.usageByThread, [threadId]: usage },
    }));
  },
  clearThread: (threadId) =>
    set((state) => {
      const { [threadId]: _removed, ...rest } = state.usageByThread;
      return { usageByThread: rest };
    }),
}));

/** Test-only helper. */
export function resetContextUsageStore(): void {
  useContextUsageStore.setState({ usageByThread: {} });
}
```

(Match the package's zustand import style — check an existing store in packages/ui or packages/preferences; if the codebase uses `zustand/traditional` `createWithEqualityFn`, mirror that.)

- [ ] **Step 3: Run — PASS. Type-check clean. Export** from the assistant-ui-panel barrel if one exists (check `packages/ui/src/assistant-ui-panel/index.ts`); app-shell imports it in Tasks 5–7.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src
git commit -m "feat(ui): per-thread context usage store"
```

---

### Task 5: Surface FinishMessage usage from the data-stream runtime

**Files:**
- Modify: `packages/ui/src/assistant-ui-panel/data-stream-runtime.ts` (options type ~line 50; pipeline ~lines 423–435)
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` (pass the new callback, write to the store)
- Test: `packages/ui/src/__tests__/data-stream-runtime.test.ts`

The wire fact (verified during planning): the server emits `DataStreamCode.finishMessage` (`'d'`) with value `{finishReason, usage: {inputTokens, outputTokens}, path}` (`packages/agent/src/stream/data-stream-mapper.ts:550-559`). assistant-stream's decoder (`DataStreamDecoder`) yields chunks whose `type` is the code enum (`DataStreamStreamChunkType.FinishMessage = "d"` — `node_modules/assistant-stream/dist/core/serialization/data-stream/chunk-types.d.ts:23`).

- [ ] **Step 1: Failing test** — in `data-stream-runtime.test.ts`, find how existing tests feed an encoded stream through the adapter (the file already exercises decode paths). Add:

```typescript
it('reports finish-message usage through onUsage', async () => {
  const usageEvents: Array<{ inputTokens: number; outputTokens: number }> = [];
  // build the adapter/run with the harness's existing helpers, passing:
  //   onUsage: (usage) => usageEvents.push(usage)
  // and a stream whose encoded body includes:
  //   d:{"finishReason":"stop","usage":{"inputTokens":123,"outputTokens":45},"path":[]}
  // (mirror how the file's other tests encode chunks — reuse their encoder helper)
  // ... run to completion ...
  expect(usageEvents).toEqual([{ inputTokens: 123, outputTokens: 45 }]);
});
```

Write it concretely against the file's actual harness (read the existing tests first); the assertion above is the contract.

- [ ] **Step 2: Implement the tap.** Add to the adapter options (~line 50):

```typescript
  /** Called when a finish-message chunk reports provider token usage. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
```

In the pipeline (between `DataStreamDecoder` and `AssistantMessageAccumulator`, ~line 423–429), insert a pass-through TransformStream:

```typescript
const usageTap = new TransformStream<DataStreamChunk, DataStreamChunk>({
  transform: (chunk, controller) => {
    if (chunk.type === DataStreamStreamChunkType.FinishMessage) {
      const usage = (chunk.value as { usage?: { inputTokens?: number; outputTokens?: number } })
        .usage;
      if (usage && (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number')) {
        onUsage?.({
          inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
          outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
        });
      }
    }
    controller.enqueue(chunk);
  },
});
// pipeline: body → DataStreamDecoder → usageTap → AssistantMessageAccumulator
```

Import `DataStreamStreamChunkType` (and the chunk type) from `assistant-stream` — verify the export path (`assistant-stream` root or a subpath; check `node_modules/assistant-stream/package.json` exports). If the enum is not exported publicly, compare against the literal `'d'` with a comment citing `DataStreamCode.finishMessage` in `packages/agent/src/stream/data-stream-codes.ts:11`.

- [ ] **Step 3: Wire to the store in app-shell.** In `assistant-ui-panel-wrapper.tsx`, where the data-stream adapter options are constructed, add:

```typescript
onUsage: (usage) => {
  const threadId = /* the harness's current thread id — find how onFinish/thread context
                      resolves the active thread in this file (e.g. the runtime's
                      thread list state or the existing onFinish handler's scope) */;
  useContextUsageStore.getState().recordUsage(threadId, usage);
},
```

Resolving the thread id is the one genuinely open integration detail: find how the wrapper identifies the active thread (search the file for `threadId`/`threadListItem`); if no id is reachable at adapter-construction time, key the store by a wrapper-stable id (e.g. the assistant-ui `threadId` from `useThreadListItem` in a small bridge component) — implement whichever the code supports, and document the choice in the commit message.

- [ ] **Step 4: Run** `pnpm vitest run data-stream-runtime` (packages/ui) + app-shell tests + type-checks. Green.

- [ ] **Step 5 (spec testing note):** check the desktop e2e assistant mock (`setupAssistantMock` — see project docs/memory) — if its canned finish chunks omit `usage`, add `"usage":{"inputTokens":…,"outputTokens":…}` to the success fixture so e2e paths exercise the meter data flow. Fixture-only change; skip if usage is already present.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src packages/app-shell/src
git commit -m "feat(ui,app-shell): surface provider token usage from the data stream"
```

---

### Task 6: Local-LLM usage forwarding

**Files:**
- Modify: `packages/ui/src/assistant-ui-panel/local-runtime-adapter.ts` (final-result handling, ~lines 1061–1245)
- Test: the local adapter's existing test file (find: `grep -rln "local-runtime-adapter" packages/ui/src/__tests__`)

- [ ] **Step 1:** Read how `LocalLlmGenerationResult` reaches the adapter (lines ~1061, 1113) — the Gemma engine returns `usage: { promptTokens, completionTokens, totalTokens }` (tokenizer-true). Add the same `onUsage?` option to the local adapter's options type, and where the final result is consumed (~line 1142–1145), call:

```typescript
if (result.usage) {
  onUsage?.({
    inputTokens: result.usage.promptTokens,
    outputTokens: result.usage.completionTokens,
  });
}
```

- [ ] **Step 2: Failing test first** in the adapter's existing harness: feed a canned generation result with `usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }` and assert `onUsage` received `{inputTokens: 50, outputTokens: 20}`.

- [ ] **Step 3:** Wire in `assistant-ui-panel-wrapper.tsx` to the same store write as Task 5 (the wrapper constructs the local adapter too — search for where `local-runtime-adapter` is instantiated).

- [ ] **Step 4:** Run adapter tests + type-check; commit:

```bash
git add packages/ui/src packages/app-shell/src
git commit -m "feat(ui): forward tokenizer-true local LLM usage to the context usage store"
```

---

### Task 7: Thread context meter component + mount

**Files:**
- Create: `packages/ui/src/assistant-ui-panel/context-usage-meter.tsx`
- Modify: the assistant panel component that renders the thread + composer (find the composer/footer region: `grep -rn "ComposerPrimitive\|Composer" packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` — mount the meter adjacent to the composer, top edge)
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` (pass `contextWindow`/`effectiveInputBudget` props from the registry join)
- Test: `packages/ui/src/__tests__/context-usage-meter.test.tsx`

- [ ] **Step 1: Failing component tests** (use the package's existing React test setup — happy-dom; mirror a neighboring `.test.tsx`):

```typescript
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContextUsageMeter } from '../assistant-ui-panel/context-usage-meter.js';
import {
  resetContextUsageStore,
  useContextUsageStore,
} from '../assistant-ui-panel/context-usage-store.js';

describe('ContextUsageMeter', () => {
  beforeEach(() => resetContextUsageStore());

  const props = {
    threadId: 't1',
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    estimatedTokens: 4000, // heuristic over thread messages, computed by the parent
  };

  it('shows the heuristic estimate (flagged) before any exact usage', () => {
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByText(/4\.0K/)).toBeInTheDocument();
    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
  });

  it('flips to exact once usage is recorded', () => {
    useContextUsageStore
      .getState()
      .recordUsage('t1', { inputTokens: 100_000, outputTokens: 8_000 });
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByText(/108\.0K/)).toBeInTheDocument();
    expect(screen.queryByText(/estimated/i)).not.toBeInTheDocument();
  });

  it('applies warning state at >=75% of the effective budget and critical at >=90%', () => {
    useContextUsageStore
      .getState()
      .recordUsage('t1', { inputTokens: 100_000, outputTokens: 0 }); // 79%
    const { rerender } = render(<ContextUsageMeter {...props} />);
    expect(screen.getByTestId('context-usage-meter')).toHaveAttribute('data-state', 'warning');
    useContextUsageStore
      .getState()
      .recordUsage('t1', { inputTokens: 120_000, outputTokens: 0 }); // 95%
    rerender(<ContextUsageMeter {...props} />);
    expect(screen.getByTestId('context-usage-meter')).toHaveAttribute('data-state', 'critical');
  });

  it('renders nothing when no context window is known', () => {
    const { container } = render(
      <ContextUsageMeter {...props} contextWindow={undefined} effectiveInputBudget={undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Implement** `context-usage-meter.tsx` (Tailwind classes per the panel's neighbors; `data-testid` + `data-state` as asserted; `formatTokenCount` from `@brainstrike/utils` for the numbers — note its output is "108.0K tokens", so render `value / window` as e.g. `108.0K / 200.0K tokens` using the helper twice and stripping the first " tokens" suffix, or add a `formatTokenCountShort` local helper):

Component contract:
- Props: `{ threadId: string; contextWindow?: number | undefined; effectiveInputBudget?: number | undefined; estimatedTokens?: number | undefined }` — the explicit `| undefined` is required because the tests (and the wrapper, when no model is selected) pass `undefined` explicitly, which `exactOptionalPropertyTypes` rejects on a plain optional.
- Value = store exact usage for `threadId` (`inputTokens + outputTokens`) if present, else `estimatedTokens` (provenance "estimated"), else render nothing if also no window.
- `data-state`: `ok` < 75% of `effectiveInputBudget`, `warning` ≥ 75%, `critical` ≥ 90%.
- At `critical`, show the windowing hint text: `Older messages are summarized out of context.` in the tooltip/subtext (per spec §3 — informational, no destructive action).
- Subscribe with `useContextUsageStore((s) => s.usageByThread[threadId])`.

- [ ] **Step 3: Mount + estimate.** In the panel component (where `threadId` and thread messages are reachable — assistant-ui's `useThread`/`useThreadListItem` hooks are available inside `AssistantRuntimeProvider`):

```tsx
const messages = useThread((t) => t.messages);
const estimatedTokens = useMemo(
  () =>
    messages.reduce(
      (sum, message) =>
        sum +
        message.content.reduce(
          (inner, part) => inner + ('text' in part ? countTokensHeuristic(part.text) : 0),
          0
        ),
      0
    ),
  [messages]
);
```

Pass `contextWindow`/`effectiveInputBudget` down from app-shell (wrapper computes them once from `getLlmModelDefinition` + `deriveEffectiveInputBudget` for the selected model — reuse the Task 3 lookup, tolerating "no model selected" as undefined). Verify the exact assistant-ui hook names against the installed `@assistant-ui/react` version and the panel's existing imports.

- [ ] **Step 4:** Run packages/ui + app-shell tests, type-checks. Green. Commit:

```bash
git add packages/ui/src packages/app-shell/src
git commit -m "feat(ui,app-shell): thread context meter with estimated/exact provenance"
```

---

### Task 8: Context-budget note in the agent instructions

**Files:**
- Modify: `packages/agent/src/mastra/default-instructions.ts` (add `buildContextBudgetNote`)
- Modify: `packages/agent/src/mastra/agent-runtime.ts` (instructions resolution, line ~223: `instructions: instructions ?? buildDefaultInstructions(toolNameMap)`)
- Test: `packages/agent/src/mastra/__tests__/default-instructions.spec.ts` + the agent-runtime spec

- [ ] **Step 1: Failing tests** (default-instructions.spec.ts):

```typescript
describe('buildContextBudgetNote', () => {
  it('renders a one-line budget note', () => {
    expect(buildContextBudgetNote(126_000)).toBe(
      'Context budget: about 126.0K tokens of input context are available this run; be concise and suggest starting a new thread if context runs low.'
    );
  });

  it('returns null without a budget', () => {
    expect(buildContextBudgetNote(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement** in default-instructions.ts (export `buildContextBudgetNote(budgetTokens: number | undefined): string | null` using `formatTokenCount`-style rendering — packages/agent can depend on `@brainstrike/utils`; check it already does, else inline the small format). In agent-runtime, where instructions resolve (~line 223), append the note when `runtimeData?.agentLoop?.inputTokenLimit` is set:

```typescript
const budgetNote = buildContextBudgetNote(runtimeData?.agentLoop?.inputTokenLimit);
const resolvedInstructions = instructions ?? buildDefaultInstructions(toolNameMap);
// ...
instructions: budgetNote ? `${resolvedInstructions}\n${budgetNote}` : resolvedInstructions,
```

Verify `runtimeData` is in scope at that construction site (it is passed into the same function that receives `instructions` — confirm by reading the enclosing function ~lines 160–230; if the agent is constructed before runtimeData exists, append at stream-options build time instead, where `buildToolLoopOptions(runtimeData)` already runs — pick whichever site actually has both values and note it in the commit).

- [ ] **Step 3:** Run `pnpm vitest run default-instructions agent-runtime` (packages/agent) — green, updating any instruction-snapshot assertions that legitimately changed. Type-check clean. Commit:

```bash
git add packages/agent/src
git commit -m "feat(agent): append context-budget note to instructions when a budget is set"
```

---

### Task 9: Windowing verification + docs

**Files:**
- Verify (no code change expected): `packages/agent/src/pglite-mastra-memory/memory-factory.ts` (lines ~77–102: `lastMessages: memoryOptions?.lastMessages ?? DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES`)
- Modify: `AGENTS.md` (Model Catalog Migrations section + new short section)
- Modify: `docs/superpowers/specs/2026-06-09-token-usage-awareness-design.md` (status line)

- [ ] **Step 1:** Confirm `DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES` exists and is a positive number; confirm the memory factory test (find it next to memory-factory.ts) covers the default. If covered: no code change — windowing was already Mastra-native. If NOT covered, add one assertion to the existing factory test proving `lastMessages` defaults on.

- [ ] **Step 2: AGENTS.md** — in the "MODEL CATALOG MIGRATIONS" section, add a numbered point:

```
6. Every LLM model entry MUST declare `contextWindow` (and `maxOutputTokens` when documented) in
   packages/assistant-contract/src/provider-registry.ts — compile-enforced, static-registry-only
   (no DB migration). It drives the thread context meter and the auto-derived
   `agentLoop.inputTokenLimit` (see packages/assistant-contract/src/context-budget.ts).
```

- [ ] **Step 3:** Update the spec's `**Status:**` line to `Implemented (PR 2)`. Commit:

```bash
git add AGENTS.md docs packages/agent
git commit -m "docs: contextWindow registry requirement + windowing verification"
```

---

### Task 10: Full verification

- [ ] **Step 1:** From repo root: `pnpm dlx ultracite fix` (commit if files change), then `pnpm build && pnpm lint && pnpm type-check && pnpm test` (use the root package.json's actual script names) — ALL green in one run. Known flake: re-run `@brainstrike/db` in isolation if it fails under turbo concurrency.
- [ ] **Step 2:** From packages/db (untouched by this PR, but the guard is cheap): `node scripts/test-lanes.mjs check && node scripts/coverage-lanes.mjs check`.
- [ ] **Step 3:** `git status` clean; final commit if formatting changed anything.

---

## Out of Scope (spec non-goals — do not implement)

Per-message usage footers; composer live estimate; model-picker context display (the data is populated, the UI is deferred); explicit `/compact` summarization; persisting usage to the DB.
