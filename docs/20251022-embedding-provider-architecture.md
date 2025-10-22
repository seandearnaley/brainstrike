# Embedding Provider Architecture

**Date:** 2025-10-22
**Status:** Design Proposal
**Related Issues:** brainstrike-28, brainstrike-30, brainstrike-29

## Overview

Implement settings-based multi-provider embedding model selection that supports both local (transformers.js) and hosted (OpenAI, Google, Cohere, Voyage) embedding models. This mirrors the successful pattern used for LLM provider selection while maintaining 768D dimension standards.

## Current State

### What Works
- ✅ Provider registry with embedding models (`@brainstrike/agent/providers/registry.ts`)
- ✅ Local embedding via transformers.js (`@brainstrike/embeddings`)
- ✅ Worker-based embedding queue
- ✅ 768D dimension enforcement in database
- ✅ Model metadata with dimension support flags

### What's Missing
- ❌ UI only shows local models (Jina, BGE)
- ❌ No settings UI for embedding model selection
- ❌ No preferences store for embedding configuration
- ❌ Worker can't call hosted APIs (OpenAI, Google)
- ❌ No runtime abstraction (local vs API backends)
- ❌ No dimension negotiation for hosted providers

## Architecture Design

### 1. Type System (Discriminated Unions)

```typescript
// packages/embeddings/src/types.ts

export type EmbeddingProviderType = 'local' | 'openai' | 'google' | 'cohere' | 'voyage';

export type EmbeddingRuntime = 'browser' | 'hosted';

// Discriminated union for provider configs
export type EmbeddingProviderConfig =
  | {
      runtime: 'browser';
      provider: 'local';
      modelId: string; // e.g., 'jina-code'
      quantization?: 'q4' | 'q8' | 'fp16';
    }
  | {
      runtime: 'hosted';
      provider: 'openai';
      modelId: string; // e.g., 'text-embedding-3-small'
      dimensions: number; // Always 768 for our use case
    }
  | {
      runtime: 'hosted';
      provider: 'google';
      modelId: string; // e.g., 'text-embedding-004'
      outputDimensionality?: number; // Optional, defaults to 768
    };

// Result type for error handling
export type Result<T, E = EmbeddingError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type EmbeddingError =
  | {
      type: 'dimension_mismatch';
      expected: number;
      received: number;
      modelId: string;
    }
  | {
      type: 'api_error';
      provider: Exclude<EmbeddingProviderType, 'local'>;
      statusCode: number;
      message: string;
    }
  | {
      type: 'model_load_failed';
      provider: 'local';
      modelId: string;
      reason: string;
    }
  | {
      type: 'missing_api_key';
      provider: Exclude<EmbeddingProviderType, 'local'>;
    };
```

### 2. Provider Interface (Strategy Pattern)

```typescript
// packages/embeddings/src/interfaces/provider.ts

export interface EmbeddingInput {
  text: string;
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
  getModelInfo(modelId: string): EmbeddingModelDefinition | null;

  /**
   * Validate dimensions match expected (768D standard)
   */
  validateDimensions(embedding: number[], expectedDimensions: number): Result<void>;
}
```

### 3. Concrete Providers

#### Local Provider (Browser)
```typescript
// packages/embeddings/src/providers/local/transformers-provider.ts

export class TransformersEmbeddingProvider implements IEmbeddingProvider {
  private service: SimpleEmbeddingService;

  constructor(private modelId: string) {
    this.service = new SimpleEmbeddingService(modelId);
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput>> {
    try {
      const embedding = await this.service.embed(input.text);

      return {
        ok: true,
        value: {
          embedding,
          dimensions: embedding.length,
          modelId: input.modelId,
          provider: 'local',
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'model_load_failed',
          provider: 'local',
          modelId: input.modelId,
          reason: error.message,
        },
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    // Check if transformers.js can load
    try {
      await this.service.initialize();
      return true;
    } catch {
      return false;
    }
  }

  // ... other methods
}
```

#### OpenAI Provider (Hosted)
```typescript
// packages/embeddings/src/providers/openai/openai-provider.ts

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  constructor(
    private apiKey: string,
    private dimensions: number = DEFAULT_EMBEDDING_DIMENSION
  ) {}

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput>> {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.modelId,
          input: input.text,
          dimensions: this.dimensions, // 768 for our use case
        }),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: {
            type: 'api_error',
            provider: 'openai',
            statusCode: response.status,
            message: await response.text(),
          },
        };
      }

      const data = await response.json();
      const embedding = data.data[0].embedding;

      return {
        ok: true,
        value: {
          embedding,
          dimensions: embedding.length,
          modelId: input.modelId,
          provider: 'openai',
          usage: {
            inputTokens: data.usage.prompt_tokens,
          },
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          provider: 'openai',
          statusCode: 500,
          message: error.message,
        },
      };
    }
  }

  // ... other methods
}
```

### 4. Provider Factory

```typescript
// packages/embeddings/src/factory.ts

export class EmbeddingProviderFactory {
  private static instances = new Map<string, IEmbeddingProvider>();

  static async createProvider(
    config: EmbeddingProviderConfig
  ): Promise<Result<IEmbeddingProvider>> {
    const key = `${config.provider}:${config.modelId}`;

    // Return cached instance
    if (this.instances.has(key)) {
      return { ok: true, value: this.instances.get(key)! };
    }

    try {
      let provider: IEmbeddingProvider;

      switch (config.runtime) {
        case 'browser': {
          provider = new TransformersEmbeddingProvider(config.modelId);
          break;
        }

        case 'hosted': {
          if (config.provider === 'openai') {
            const apiKey = await this.getAPIKey('openai');
            if (!apiKey) {
              return {
                ok: false,
                error: { type: 'missing_api_key', provider: 'openai' },
              };
            }
            provider = new OpenAIEmbeddingProvider(apiKey, config.dimensions);
          } else if (config.provider === 'google') {
            const apiKey = await this.getAPIKey('google');
            if (!apiKey) {
              return {
                ok: false,
                error: { type: 'missing_api_key', provider: 'google' },
              };
            }
            provider = new GoogleEmbeddingProvider(apiKey, config.outputDimensionality);
          } else {
            throw new Error(`Unsupported provider: ${config.provider}`);
          }
          break;
        }
      }

      this.instances.set(key, provider);
      return { ok: true, value: provider };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'model_load_failed',
          provider: config.provider,
          modelId: config.modelId,
          reason: error.message,
        },
      };
    }
  }

  private static async getAPIKey(provider: string): Promise<string | null> {
    // In web: read from environment or storage
    // In desktop: read from secrets IPC
    if (typeof window !== 'undefined' && 'secrets' in window) {
      // Electron
      return window.secrets.get(provider);
    }

    // Web - check environment
    const envKey = `${provider.toUpperCase()}_API_KEY`;
    return import.meta.env[envKey] || null;
  }
}
```

### 5. Preferences Store

```typescript
// packages/preferences/src/embedding-preferences-store.ts

export interface EmbeddingPreferencesState {
  // Selected model (composite key: provider::model)
  selectedModel: string | null; // e.g., "openai::text-embedding-3-small"

  // Enabled models per provider
  enabledModels: {
    local: Set<string>;
    openai: Set<string>;
    google: Set<string>;
  };

  // Runtime preference (local first vs hosted first)
  preferredRuntime: 'browser' | 'hosted';

  // Actions
  setSelectedModel: (compositeKey: string) => void;
  enableModel: (provider: EmbeddingProviderType, modelId: string) => void;
  disableModel: (provider: EmbeddingProviderType, modelId: string) => void;
  getSelectedProvider: () => EmbeddingProviderType | null;
  getSelectedModelId: () => string | null;
}

export const useEmbeddingPreferences = create<EmbeddingPreferencesState>(
  persist(
    (set, get) => ({
      selectedModel: 'local::jina-code', // Default
      enabledModels: {
        local: new Set(['jina-code']),
        openai: new Set(),
        google: new Set(),
      },
      preferredRuntime: 'browser',

      setSelectedModel: (compositeKey) => {
        set({ selectedModel: compositeKey });
      },

      enableModel: (provider, modelId) => {
        set((state) => ({
          enabledModels: {
            ...state.enabledModels,
            [provider]: new Set([...state.enabledModels[provider], modelId]),
          },
        }));
      },

      disableModel: (provider, modelId) => {
        set((state) => {
          const updated = new Set(state.enabledModels[provider]);
          updated.delete(modelId);
          return {
            enabledModels: {
              ...state.enabledModels,
              [provider]: updated,
            },
          };
        });
      },

      getSelectedProvider: () => {
        const selected = get().selectedModel;
        if (!selected) return null;
        return selected.split('::')[0] as EmbeddingProviderType;
      },

      getSelectedModelId: () => {
        const selected = get().selectedModel;
        if (!selected) return null;
        return selected.split('::')[1];
      },
    }),
    {
      name: 'embedding-preferences',
    }
  )
);
```

### 6. Settings UI

```typescript
// apps/web/src/components/settings/embedding-settings.tsx

export function EmbeddingSettings() {
  const { selectedModel, enabledModels, setSelectedModel, enableModel, disableModel } =
    useEmbeddingPreferences();

  const providers = listProviders().filter((p) => p.capabilities.embeddings);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Embedding Models</CardTitle>
        <CardDescription>
          Configure embedding models for semantic search and vector storage.
          All models are configured to output 768 dimensions.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Selected Model */}
        <div>
          <Label>Active Model</Label>
          <Select value={selectedModel || ''} onValueChange={setSelectedModel}>
            <SelectTrigger>
              <SelectValue placeholder="Select embedding model" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => {
                const embeddingModels = listEmbeddingModels(provider.id);
                return (
                  <SelectGroup key={provider.id}>
                    <SelectLabel>{provider.displayName}</SelectLabel>
                    {embeddingModels.map((model) => (
                      <SelectItem
                        key={`${provider.id}::${model.id}`}
                        value={`${provider.id}::${model.id}`}
                      >
                        {model.label || model.id}
                        {model.supportsStandardDimension && (
                          <Badge variant="secondary" className="ml-2">
                            768D
                          </Badge>
                        )}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        {/* Model Availability */}
        {providers.map((provider) => (
          <Collapsible key={provider.id}>
            <CollapsibleTrigger className="flex items-center justify-between w-full">
              <span className="font-medium">{provider.displayName}</span>
              <Badge variant={provider.runtime === 'hosted' ? 'default' : 'secondary'}>
                {provider.runtime}
              </Badge>
            </CollapsibleTrigger>

            <CollapsibleContent className="space-y-2 mt-2">
              {listEmbeddingModels(provider.id).map((model) => {
                const compositeKey = `${provider.id}::${model.id}`;
                const isEnabled = enabledModels[provider.id]?.has(model.id) ?? false;

                return (
                  <div key={compositeKey} className="flex items-center justify-between">
                    <div className="flex-1">
                      <p className="text-sm font-medium">{model.label || model.id}</p>
                      <p className="text-xs text-muted-foreground">
                        {model.defaultDimension}D
                        {model.supportsCustomDimensions && ' (configurable)'}
                      </p>
                    </div>

                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          enableModel(provider.id, model.id);
                        } else {
                          disableModel(provider.id, model.id);
                        }
                      }}
                    />
                  </div>
                );
              })}
            </CollapsibleContent>
          </Collapsible>
        ))}
      </CardContent>
    </Card>
  );
}
```

### 7. Worker Integration

```typescript
// packages/embeddings/src/worker/embedding-worker.ts

// Update worker to use factory pattern
async function handleEmbedRequest(request: EmbedRequest): Promise<EmbedResponse> {
  const preferences = getEmbeddingPreferences(); // Read from storage
  const provider = preferences.getSelectedProvider();
  const modelId = preferences.getSelectedModelId();

  if (!provider || !modelId) {
    return {
      success: false,
      error: 'No embedding model selected',
    };
  }

  const config: EmbeddingProviderConfig = buildConfigFromPreferences(provider, modelId);

  const providerResult = await EmbeddingProviderFactory.createProvider(config);

  if (!providerResult.ok) {
    return {
      success: false,
      error: providerResult.error.type,
    };
  }

  const embeddingResult = await providerResult.value.embed({
    text: request.text,
    modelId,
  });

  if (!embeddingResult.ok) {
    return {
      success: false,
      error: embeddingResult.error.type,
    };
  }

  // Validate 768D
  const validation = providerResult.value.validateDimensions(
    embeddingResult.value.embedding,
    DEFAULT_EMBEDDING_DIMENSION
  );

  if (!validation.ok) {
    return {
      success: false,
      error: validation.error.type,
    };
  }

  return {
    success: true,
    embedding: embeddingResult.value.embedding,
    dimensions: embeddingResult.value.dimensions,
  };
}
```

## Phased Implementation

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
