# Device-Calibrated Local Input Budget — Design

**Status:** proposed (not implemented)
**Date:** 2026-06-12
**Problem:** The built-in local Gemma model registers its architectural context
window (131,072 tokens), so the Mastra `TokenLimiter` happily builds prompts far
beyond what a given machine's WebGPU stack can actually survive. Real prompts
above a device-specific ceiling fault deterministically
(`unaligned accesses`, `Invalid Buffer … due to a previous error`), survive the
automatic one-shot retry, and fail the user's turn. The ceiling varies per
device and is invisible until it is hit. Today the only mitigation is the
manual "Input tokens" override (`agentInputTokenLimit`).

## Goal

Derive the local provider's effective input budget automatically from the
device, so prompts stop crossing into the fault zone — while preserving the
repo's standing invariants:

- **One derivation, three consumers** (CONTEXT USAGE METER): the same number
  must feed the Mastra `TokenLimiter`, the meter denominator, and the
  instruction budget note via `buildAgentLoopSettings`.
- **No silent fallbacks**: every cap is visible and attributable.
- **Renderer-only inference**: nothing here moves model work out of the hidden
  llm-host.

## Core idea

Two signals combine into ONE ceiling, resolved by a pure function:

1. **Physics prior (estimate)** — before any observations, estimate the
   ceiling from WebGPU adapter limits + the model's KV-cache geometry.
2. **Learned calibration (authoritative)** — every local generation already
   flows through one main-process chokepoint with measured prompt token
   counts (successes via `usage.promptTokens`; faults via the
   `(prompt: N tokens)` measurement added in `b75b4dcca`, to be carried as a
   structured field). Outcomes move two watermarks, AIMD-style:
   - success at N tokens → `maxKnownGoodPromptTokens = max(current, N)`
   - engine fault at N tokens → `minFaultPromptTokens = min(current, N)`

Effective input budget reuses the existing reserve semantics by treating the
device ceiling as a *synthetic context window*:

```
inputTokenLimit = deriveEffectiveInputBudget(
  min(registryContextWindow, deviceCeiling),
  maxOutputTokens
)
```

This is semantically right: the KV/buffer ceiling constrains input + output
tokens together, exactly like a context window.

## Components

### 1. Pure resolver — `packages/assistant-contract/src/local-device-budget.ts` (NEW)

```ts
interface LocalGpuSignature {
  architecture: string;
  device: string;
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  vendor: string;
}

interface LocalDeviceCalibration {
  faultCount: number;
  gpuKey: string;                      // stable hash of LocalGpuSignature
  maxKnownGoodPromptTokens?: number;
  minFaultPromptTokens?: number;
  modelId: string;
  updatedAt: string;                   // ISO
}

function estimateDeviceTokenCeiling(
  signature: LocalGpuSignature,
  spec: LocalLlmModelSpec
): number;

function resolveDeviceTokenCeiling(args: {
  calibration?: LocalDeviceCalibration;
  registryContextWindow: number;
  signature: LocalGpuSignature;
  spec: LocalLlmModelSpec;
}): { ceiling: number; source: 'estimate' | 'learned-fault' | 'learned-good' };
```

**Estimate formula** (a conservative prior, not an oracle):

```
kvBytesPerToken = 2 (K+V) × num_hidden_layers × num_key_value_heads × head_dim × 2 (f16 bytes)
usableBytes     = max(0, min(maxBufferSize, maxStorageBufferBindingSize × LAYER_FANOUT) − spec.totalSizeBytes)
estimate        = clamp(floor(SAFETY × usableBytes / kvBytesPerToken), FLOOR, registryContextWindow)

SAFETY = 0.5    FLOOR = 4096    LAYER_FANOUT: number of per-layer KV buffers (bindings are per-buffer)
```

`kvBytesPerToken` becomes a new required field on `LocalLlmModelSpec`
(packages/assistant-contract/src/local-llm-model-specs.ts), filled at
spec-authoring time from the model's published `config.json` — never guessed
at runtime. Invalid inputs THROW (no silent fallback).

**Resolution precedence:**

- `minFaultPromptTokens` exists →
  `ceiling = clamp(floor(minFaultPromptTokens × BACKOFF), max(maxKnownGoodPromptTokens ?? 0, FLOOR), estimate)`
  with `BACKOFF = 0.85`, source `'learned-fault'`.
- else `maxKnownGoodPromptTokens > estimate` → success evidence raises a
  too-conservative prior: `ceiling = min(maxKnownGoodPromptTokens, registryContextWindow)`,
  source `'learned-good'`.
- else → `ceiling = estimate`, source `'estimate'`.

### 2. Calibration observer + store (Electron MAIN)

- **Store** — `apps/desktop/src/local-device-profile-store.ts` (NEW): JSON at
  `app.getPath('userData')/local-llm-device-profile.json`, keyed
  `${modelId}::${gpuKey}`, LRU-pruned to ≤8 entries (driver updates / eGPU
  changes start a fresh key). Debounced writes. A corrupt file logs
  `logger.error` and starts fresh — visible, never silent.
- **Observer** — `LlmHostManager.acceptResponseReport` is the single
  chokepoint every local generation outcome passes through (desktop chat via
  the assistant server, local observational memory, and the legacy
  renderer-initiated path). Hook it:
  - `type: 'result'` with `payload.result.usage.promptTokens` → raise the
    known-good watermark.
  - `type: 'error'` whose payload diagnostics carry
    `{ engineFault: true, promptTokenCount }` → record a fault sample.
    Aborts and non-engine errors are ignored.
- **Structured fault size**: the engine currently appends
  `(prompt: N tokens)` to the message only. Add a structured field: the
  engine sets `promptTokenCount` on the thrown error object; the llm-host
  runtime copies it (plus `engineFault: true`) into the error report's
  existing `diagnostics`. The manager reads diagnostics — no message parsing.

### 3. Device signature acquisition

`navigator.gpu` is renderer-only. The llm-host already computes
`LocalLlmBackend.getWebGpuInfo()`; include it once in the host's first
`running` STATUS report (no new request kind). Main caches it alongside host
status. If WebGPU info is unavailable, there is no estimate — resolution falls
back to the registry derivation and SAYS so (`source` is absent).

### 4. Renderer exposure — the single derivation seam

- Preload bridge: `window.llmHost.getDeviceBudget(modelId)` → IPC → main
  resolves `{ ceiling, source, gpuLabel }` from cached signature + profile.
- `buildAgentLoopSettings(prefs, selectedModelDef, deviceBudget?)` gains an
  optional third argument. Precedence:
  1. explicit user pref (`agentInputTokenLimit`) — always wins,
  2. device ceiling (only when the selected provider is `'local'`),
  3. registry `deriveEffectiveInputBudget(contextWindow, maxOutputTokens)`.
- The returned `agentLoop.inputTokenLimit` is unchanged in shape, so the
  TokenLimiter, the meter denominator, and the budget note all follow
  automatically. The wrapper also exposes `inputBudgetSource` for UI
  provenance.

### 5. Visibility (never silent)

- Context meter tooltip: *"Input budget 6,400 tokens — auto-capped for
  Apple M2 Pro (learned from a GPU fault at 7,842 tokens). Override in
  provider settings."*
- Provider settings "Input tokens" placeholder shows the derived value and
  source instead of a generic default.
- Main logs a `warn` whenever a fault lowers the ceiling; the chat error block
  already showed the fault itself.

### 6. Factory reset

Delete `local-llm-device-profile.json` in the desktop reset pipeline
(`desktop-factory-reset.ts`) and document it next to
`clearPersistentUiState()` per the FACTORY RESET CONTRACT.

### 7. Web (explicit known gap, v1 is desktop-only)

Web local chat uses the in-renderer `LocalRuntimeChat` with no Mastra
TokenLimiter, so there is nothing for the budget to feed yet. The pure
resolver is contract-level and reusable; a later pass can persist calibration
in `localStorage` and apply it in the web prompt builder. Document the gap in
AGENTS.md.

## Failure modes considered

- **State ownership:** main is the single calibration writer; renderers only
  read. One JSON file, one store class.
- **Timing:** the budget is fetched per request alongside the existing async
  settings build; stale-by-one-turn is acceptable (a fault this turn caps the
  next turn). No mid-stream mutation.
- **Blast radius:** hosted providers never consult the device path (gated on
  provider `'local'`); the explicit user pref always wins; removing the
  feature reverts to today's registry derivation.
- **Shared model, multiple consumers:** chat and local observational memory
  share the engine and therefore the ceiling; OM prompts are small, so chat
  dominates calibration. Correct, since the fault is per-device+model, not
  per-consumer.
- **Estimate wrong in either direction:** too low → success watermarks raise
  it; too high → the first fault (already survivable via the one-shot retry)
  caps it below the observed fault size permanently.

## Test plan (red-green)

1. Pure resolver: estimate math, fault backoff, known-good raise, clamps,
   throw-on-invalid.
2. Profile store: round-trip, LRU prune, corrupt-file recovery logs an error
   and starts fresh, debounced write.
3. Manager observer (real envelope validators, mocked window like existing
   tests): result raises watermark; fault diagnostics lower it; aborts and
   non-engine errors ignored.
4. Wrapper runtime: pref wins; local + device budget → capped limit and
   source; hosted provider ignores device budget; missing WebGPU info falls
   through to registry derivation.
5. Live-loop: extend `mastra-local-host-execution.spec.ts` to assert the
   capped `inputTokenLimit` reaches the loop options.

## Implementation order (~6 commits)

1. `kvBytesPerToken` on the spec + pure resolver with tests.
2. Structured fault diagnostics (engine field → host report diagnostics).
3. Profile store + manager observer.
4. Host status carries WebGPU info; preload `getDeviceBudget`.
5. `buildAgentLoopSettings` third arg + wrapper wiring + meter/settings
   provenance.
6. Factory reset wiring + AGENTS.md updates (CONTEXT USAGE METER, LOCAL LLM
   ARCHITECTURE, FACTORY RESET CONTRACT).
