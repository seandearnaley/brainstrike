# Embedding Provider Architecture

**Date:** 2025-10-22 (Updated 2026-01-06)
**Status:** Partially Implemented (Local + hosted OpenAI/Google supported in worker; Cohere/Voyage pending; dual-process split not implemented)
**Related Issues:** brainstrike-28, brainstrike-30, brainstrike-29, brainstrike-47

## Overview

Multi-provider embedding model selection supporting both local (transformers.js) and hosted (OpenAI, Google, Cohere, Voyage) models. Mirrors LLM provider selection while supporting flexible dimensions (validated per embedding set, max 2000 in worker).

## ⚠️ CRITICAL: Renderer-Only Architecture (January 2025)

**The embedding worker MUST run in the renderer process (browser context), NOT in Electron's main process.**

### Why Renderer-Only?
- **Local models** (transformers.js) require Web Workers for async WASM/WebGPU execution
- Web Workers don't exist in Node.js/Electron main process
- If TransformersBackend runs in main process, it falls back to **synchronous execution** → app beachballs/freezes
- Discovered during brainstrike-47: worker was incorrectly running in main process, causing UI to freeze during backfill

### Current Implementation (brainstrike-47)
- **Renderer**: `apps/desktop/src/renderer/components/embedding-worker-provider.tsx`
  - Auto-starts worker when DB is ready
  - Polls job queue from PGlite database
  - Processes jobs using Web Workers (workerpool + p-queue fallback)
  - Supports local models (WASM/WebGPU) and hosted providers (OpenAI, Google)
- **Main Process**: `apps/desktop/src/main.ts`
  - Does NOT start embedding worker (removed)
  - Only handles IPC, database initialization, app lifecycle

### Future Work: Dual-Process Architecture
To support both local and hosted models optimally:

1. **Renderer Process** (local models only):
   - Local transformers.js models (Jina, BGE, etc.)
   - Requires Web Workers for WASM/WebGPU
   - User-facing with progress UI

2. **Main Process** (hosted providers only - NOT YET IMPLEMENTED):
   - OpenAI, Google, Cohere, Voyage API calls
   - No Web Worker dependency
   - Background processing survives renderer restarts
   - **Requires architecture changes**: IPC for job status, worker selection logic, renderer-main coordination

**For now**: All embedding work (local AND hosted) runs in renderer process.

## Current State

### What Works
- ✅ DB-backed model registry (`providers` + `models` tables) with settings UI
- ✅ Local embedding via transformers.js (`@brainstrike/embeddings`)
- ✅ Worker-based embedding queue (durable JobQueue)
- ✅ Hosted providers in worker for OpenAI + Google
- ✅ Per-set dimension validation (max 2000 enforced in worker)
- ✅ Provider metadata + embedding set validation helpers

### What's Missing
- ❌ Cohere/Voyage providers exist but are not wired into the worker
- ❌ Hosted providers still run in renderer (no main-process split)
- ❌ Collection creation uses registry defaults; no per-collection dimension override UI
- ❌ Static registry (`model-registry.ts`) vs DB models table still need unification

## Architecture Design

### 1. Type System (Discriminated Unions)

```typescript
// packages/embeddings/src/provider-types.ts

export type EmbeddingProviderType =
  | 'local'
  | 'transformers'
  | 'openai'
  | 'google'
  | 'cohere'
  | 'voyage';

export type LocalProviderType = 'local' | 'transformers';
export type HostedProviderType = Exclude<EmbeddingProviderType, LocalProviderType>;

export type EmbeddingRuntime = 'browser' | 'hosted';

export type EmbeddingProviderConfig =
  | {
      runtime: 'browser';
      provider: 'local';
      modelId: string;
      quantization?: 'q4' | 'q8' | 'fp16';
    }
  | {
      runtime: 'hosted';
      provider: 'openai';
      modelId: string;
      dimensions: number;
    }
  | {
      runtime: 'hosted';
      provider: 'google';
      modelId: string;
      outputDimensionality?: number;
    }
  | {
      runtime: 'hosted';
      provider: 'cohere';
      modelId: string;
      inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
    }
  | {
      runtime: 'hosted';
      provider: 'voyage';
      modelId: string;
      inputType?: 'document' | 'query';
    };

export type Result<T, E = EmbeddingProviderError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type EmbeddingProviderError =
  | { type: 'dimension_mismatch'; expected: number; received: number; modelId: string }
  | { type: 'api_error'; provider: HostedProviderType; statusCode: number; message: string }
  | { type: 'model_load_failed'; provider: LocalProviderType; modelId: string; reason: string }
  | { type: 'missing_api_key'; provider: HostedProviderType }
  | { type: 'network_error'; provider: HostedProviderType; originalError: Error }
  | { type: 'rate_limit_exceeded'; provider: HostedProviderType; retryAfter?: number }
  | { type: 'validation_error'; field: string; message: string };
```

### 2. Provider Interface (Strategy Pattern)

```typescript
// packages/embeddings/src/interfaces/provider.ts

export interface EmbeddingInput {
  text: string | string[];
  modelId: string;
}

export interface EmbeddingOutput {
  embedding: number[];
  dimensions: number;
  modelId: string;
  provider: EmbeddingProviderType;
  usage?: {
    inputTokens: number;
  };
}

export interface IEmbeddingProvider {
  /**
   * Generate embedding for given text
   */
  embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput>>;

  /**
   * Check if provider is available (API reachable, model loaded, etc.)
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get model metadata from registry
   */
  getModelInfo(modelId: string): ModelConfig | null;

  /**
   * Unified provider metadata for embedding-set creation
   */
  getMetadata(modelId: string): ProviderMetadata | null;

  /**
   * Validate dimensions match expected
   */
  validateDimensions(embedding: number[], expectedDimensions: number): Result<void>;
}
```

### 3. Concrete Providers

Implementations live in `packages/embeddings/src/providers/*`. The worker currently supports OpenAI and Google hosted providers; Cohere and Voyage providers are defined but not wired into the worker yet.

#### Local Provider (Browser)
 - Implementation: `packages/embeddings/src/providers/local/transformers-provider.ts`
 - Wraps `SimpleEmbeddingService` + `TransformersBackend`
 - Supports device override (`webgpu`/`wasm`) and array inputs
 - Returns `Result` errors instead of throwing

#### Hosted Providers
- OpenAI: `packages/embeddings/src/providers/hosted/openai-provider.ts` (configurable dimensions)
- Google: `packages/embeddings/src/providers/hosted/google-provider.ts` (outputDimensionality)
- Cohere/Voyage: provider classes exist but are not wired into the worker yet

### 4. Provider Factory
- Implementation: `packages/embeddings/src/factory.ts`
- Caches provider instances and resolves API keys via `providers/hosted/api-key-resolver.ts`
- Creates local or hosted providers from `EmbeddingProviderConfig`

### 5. Preferences Store

The preferences store tracks which models are enabled per provider and a small set of runtime preferences.

```typescript
// packages/preferences/src/stores/embedding-preferences-store.ts

export interface EmbeddingPreferencesData {
  // Enabled models per provider
  enabledModelsByProvider: Record<EmbeddingProviderType, string[]>;
  // Runtime preference (local first vs hosted first)
  preferredRuntime: 'browser' | 'hosted';
}

// The store exposes actions to enable/disable models per provider and to set runtime preference.
// Model *selection* is not stored globally; selection happens per-collection/embedding-set and is
// persisted as part of the embedding_sets metadata in the database.
```

### 6. Settings UI

- Implementation: `packages/preferences/src/embedding/embedding-settings-section.tsx`
- Loads the DB-backed model registry (`useModelRegistryStore`)
- Uses `enabledModelsByProvider` to filter models shown in Collections
- Model selection happens per-collection, not globally


### 7. Worker Integration

- Worker entrypoint: `packages/embeddings/src/worker/embedding-worker.ts`
- Reads model metadata from the DB `models` table; job payloads supply `embeddingSetId` + `modelKey`
- Embedding sets are created via the Collections dialog; the worker no longer auto-creates sets
- Hosted providers supported in worker: OpenAI + Google (Cohere/Voyage pending)


## Phased Implementation

**Note:** The phase checklist below reflects the original 768D rollout plan. The current system supports flexible dimensions via `embedding_sets`; treat 768D references as legacy context.

### Phase 1: Preferences & Type System
**PR #1: Embedding preferences foundation**

**Scope:**
- Create `EmbeddingProviderConfig` discriminated union
- Create `EmbeddingError` discriminated union
- Create `Result<T, E>` type
- Implement `useEmbeddingPreferences` Zustand store
- Add persistence with localStorage/electron-store adapter
- Unit tests for store

**Files:**
- `packages/embeddings/src/types.ts` (new)
- `packages/preferences/src/embedding-preferences-store.ts` (new)
- `packages/preferences/src/embedding-preferences-store.test.ts` (new)

**Acceptance:**
- Store persists selected model across sessions
- Can enable/disable models per provider
- Composite key format (`provider::model`) works correctly
- Migration from old `selectedModel` string if exists

---

### Phase 2: Provider Interface & Local Implementation
**PR #2: Extract provider interface from existing code**

**Scope:**
- Define `IEmbeddingProvider` interface
- Create `TransformersEmbeddingProvider` wrapping existing `SimpleEmbeddingService`
- Implement `EmbeddingProviderFactory` with local provider only
- Add Result-based error handling
- Unit tests for provider interface

**Files:**
- `packages/embeddings/src/interfaces/provider.ts` (new)
- `packages/embeddings/src/providers/local/transformers-provider.ts` (new)
- `packages/embeddings/src/factory.ts` (new)
- `packages/embeddings/src/factory.test.ts` (new)

**Acceptance:**
- Factory can create local provider instances
- Local provider wraps transformers.js correctly
- Dimension validation works for 768D models
- All existing local embedding tests pass

---

### Phase 3: Settings UI
**PR #3: Add embedding model settings panel**

**Scope:**
- Create `EmbeddingSettings` component in web/desktop
- Use provider registry to list available models
- Show runtime badges (browser vs hosted)
- Enable/disable models via switches
- Select active model via dropdown
- Show 768D compatibility badges
- Desktop: mirror in preferences window

**Files:**
- `apps/web/src/components/settings/embedding-settings.tsx` (new)
- `apps/desktop/src/renderer/preferences/embedding-panel.tsx` (new)
- Integration with existing settings UI

**Acceptance:**
- Settings panel shows all providers from registry
- Can enable/disable individual models
- Can select active model
- Selected model persists via preferences store
- UI shows which models support 768D
- Desktop and web UIs have parity

---

### Phase 4: Hosted Providers (OpenAI + Google)
**PR #4: Implement hosted embedding providers**

**Scope:**
- Implement `OpenAIEmbeddingProvider`
- Implement `GoogleEmbeddingProvider`
- Update factory to support hosted providers
- Integrate with secrets/API key management
- Add dimension parameter negotiation (OpenAI `dimensions=768`, Google `output_dimensionality=768`)
- API error handling with Result types
- Integration tests with mocked APIs

**Files:**
- `packages/embeddings/src/providers/openai/openai-provider.ts` (new)
- `packages/embeddings/src/providers/google/google-provider.ts` (new)
- `packages/embeddings/src/providers/openai/__tests__/openai-provider.test.ts` (new)
- `packages/embeddings/src/providers/google/__tests__/google-provider.test.ts` (new)
- Update `factory.ts` to handle hosted providers

**Acceptance:**
- OpenAI provider calls API with `dimensions=768`
- Google provider calls API with `output_dimensionality=768`
- API key fetching works in web and desktop
- Missing API key returns typed error
- API errors return typed Result with status codes
- All providers validate 768D output

---

### Phase 5: Worker Integration & Import Flow
**PR #5: Connect preferences to worker and import UI**

**Scope:**
- Update embedding worker to read from preferences store
- Update worker to use provider factory
- Remove hardcoded model list from import settings UI
- Import settings reads from embedding preferences
- Show only enabled models in import dropdown
- Validate 768D before queueing jobs
- Update queue telemetry with provider info

**Files:**
- `packages/embeddings/src/worker/embedding-worker.ts` (update)
- `packages/db-explorer/src/components/settings-panel.tsx` (update)
- `packages/db-explorer/src/use-import-flow.ts` (update)

**Acceptance:**
- Worker uses selected model from preferences
- Worker can call both local and hosted providers
- Import UI shows only enabled models
- Selecting hosted model without API key shows error
- Queue rejects non-768D models
- Telemetry captures provider type (local vs hosted)

---

## Testing Strategy

### Unit Tests
- ✅ Preferences store (Phase 1)
- ✅ Provider factory (Phase 2)
- ✅ Each provider implementation (Phases 2, 4)
- ✅ Dimension validation (all phases)
- ✅ Error type discrimination (all phases)

### Integration Tests
- ✅ Factory creates correct provider based on config (Phase 2, 4)
- ✅ Preferences persist across page reload (Phase 1)
- ✅ Worker reads preferences and routes to correct provider (Phase 5)
- ✅ API providers call correct endpoints with correct params (Phase 4)

### E2E Tests
- ✅ Select embedding model in settings (Phase 3)
- ✅ Import files with local embedding model (Phase 5)
- ✅ Import files with hosted embedding model (Phase 5)
- ✅ Error when API key missing for hosted model (Phase 5)
- ✅ Dimension validation rejects non-768D embeddings (Phase 5)

---

## Migration Path

### Backward Compatibility
1. **Phase 1**: Migrate existing `selectedModel` (string) to composite key format
2. **Phase 2**: Wrap existing `SimpleEmbeddingService` - no breaking changes
3. **Phase 5**: Import settings reads from preferences - defaults to current model if not set

### Data Migration
- Existing embedding data in DB: No changes needed (already 768D enforced)
- Existing preferences: Auto-migrate string model ID to `local::model-id` format
- Secrets: Use existing OpenAI key management, extend to other providers

---

## Future Extensibility

### Adding New Providers (Cohere, Voyage, Jina API)

**Step 1**: Add to discriminated union
```typescript
type EmbeddingProviderConfig =
  | // ...existing
  | {
      runtime: 'hosted';
      provider: 'cohere';
      modelId: string;
      inputType?: 'search_document' | 'search_query';
    };
```

**Step 2**: Implement provider class
```typescript
export class CohereEmbeddingProvider implements IEmbeddingProvider {
  // ... implementation
}
```

**Step 3**: Update factory
```typescript
case 'cohere': {
  provider = new CohereEmbeddingProvider(apiKey);
  break;
}
```

**Step 4**: Add models to registry (`@brainstrike/agent/providers/registry.ts`)

**Step 5**: Settings UI automatically picks up new provider via registry

**No changes needed to:**
- Preferences store
- Worker logic
- Import UI
- Database layer

---

## Success Metrics

### Technical
- ✅ All providers implement `IEmbeddingProvider` interface
- ✅ 100% type safety (no `any` types)
- ✅ All embeddings validated to 768D before storage
- ✅ API errors return typed Result (not thrown exceptions)
- ✅ Provider selection survives page reload

### User Experience
- ✅ Settings UI mirrors LLM provider selection (familiar UX)
- ✅ Clear visual distinction between local vs hosted models
- ✅ Helpful errors when API key missing
- ✅ Import flow uses selected model without additional config

### Maintainability
- ✅ Adding new provider requires <100 LOC
- ✅ Each provider fully isolated (can be tested independently)
- ✅ Type system catches provider mismatches at compile time
- ✅ No runtime reflection or dynamic imports needed
