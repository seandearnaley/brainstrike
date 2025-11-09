# BrainStrike Embedding Model Implementation Overview

## Executive Summary

BrainStrike implements a sophisticated embedding system with **local (browser-based) and hosted (API) support**. The system uses **Jina Code (768D)** as the default embedding model and is designed to be provider-agnostic with support for multiple embedding backends.

---

## 1. EMBEDDING MODEL SETTINGS CONFIGURATION

### 1.1 Model Registry (`packages/embeddings/model-registry.json`)
**File:** `packages/embeddings/model-registry.json`

The registry defines all available local embedding models:

```json
{
  "default": "jina-code",
  "models": {
    "jina-code": {
      "id": "jinaai/jina-embeddings-v2-base-code",
      "name": "Jina Code (default)",
      "dimensions": 768,
      "quantized": false,
      "description": "Code-aware embeddings (30+ languages, 8k ctx)",
      "tags": ["code", "multilingual", "open-source"],
      "origin": "Code-aware",
      "size": "~300MB"
    },
    "all-MiniLM-L6-v2": {
      "id": "Xenova/all-MiniLM-L6-v2",
      "dimensions": 384,
      "quantized": false,
      "description": "Fast and efficient English embeddings",
      "tags": ["english", "fast", "general"],
      "size": "~23MB"
    },
    "bge-small-en-v1.5": {
      "id": "Xenova/bge-small-en-v1.5",
      "dimensions": 384,
      "quantized": false,
      "description": "Balanced English embeddings",
      "tags": ["english", "balanced", "bge"],
      "size": "~67MB"
    },
    "bge-base-en-v1.5": {
      "id": "Xenova/bge-base-en-v1.5",
      "dimensions": 768,
      "quantized": false,
      "description": "High-quality English embeddings",
      "tags": ["english", "high-quality", "bge"],
      "size": "~130MB"
    },
    "bge-large-en-v1.5": {
      "id": "Xenova/bge-large-en-v1.5",
      "dimensions": 1024,
      "quantized": false,
      "description": "SOTA English text embeddings",
      "tags": ["english", "sota", "bge"],
      "size": "~330MB"
    }
  }
}
```

**Key Features:**
- Default model: `jina-code` (768D)
- Each model has: id, name, dimensions, quantization flag, description, tags, origin, size
- Models can have 384D, 768D, or 1024D dimensions
- Non-default models are treated as alternatives

### 1.2 Model Registry Manager (`packages/embeddings/src/model-registry.ts`)
**File:** `packages/embeddings/src/model-registry.ts` (Lines 1-96)

Provides programmatic access to the model registry:

```typescript
// Key functions:
export function getRegistry(): ModelRegistry
export function listModels(): Record<string, ModelConfig>
export function getModel(key: string): ModelConfig | null
export function getDefaultModelKey(): string  // Returns "jina-code"
export function getDefaultModel(): ModelConfig
export function hasModel(key: string): boolean
export function getModelsByTag(tag: string): Record<string, ModelConfig>
export function shouldQuantize(model: ModelConfig): boolean
```

---

## 2. UI/UX FOR EMBEDDING MODEL SETTINGS

### 2.1 Embedding Settings Section (`packages/preferences/src/embedding/embedding-settings-section.tsx`)
**File:** `packages/preferences/src/embedding/embedding-settings-section.tsx` (Lines 1-603)

**Main Component: `EmbeddingSettings()`**

#### Layout Structure:
1. **Active Embedding Model Card** (Lines 296-374)
   - Dropdown to select active model
   - Shows selected model with dimension badge
   - "Reset to recommended default" button
   - "Clear selection" button
   - Only shows enabled models in dropdown

2. **Model Availability Card** (Lines 376-501)
   - Search box to filter models
   - Per-provider sections showing all available models
   - Enable/Disable toggles for each model
   - "Enable all" / "Disable all" buttons per provider
   - Shows dimension compatibility badges:
     - Secondary badge: `{STANDARD_EMBEDDING_DIMENSION}D` (768D) ready
     - Destructive badge: Dimension mismatch (non-768D)
   - Runtime badges (Browser vs Hosted)

#### Key UI Features:
- **Composite Key Format:** `"provider::modelId"` (e.g., `"local::jina-code"`)
- **Dimension Badge System:**
  - 768D models: Secondary badge (compatible)
  - Non-768D models: Destructive badge (incompatible)
- **Search:** Full-text search across model names and IDs
- **Provider Grouping:** Models grouped by provider (Local, OpenAI, Google, Cohere, Voyage)

#### Normalized Model Type (Lines 36-44):
```typescript
type NormalizedEmbeddingModel = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly dimensions: number;
  readonly supportsStandardDimension: boolean;  // Is it 768D?
  readonly supportsCustomDimensions: boolean;
  readonly availableDimensions?: readonly number[];
  readonly isDefault: boolean;
};
```

---

## 3. EMBEDDING MODEL PROVIDERS & INTEGRATION

### 3.1 Provider Types (`packages/embeddings/src/provider-types.ts`)
**File:** `packages/embeddings/src/provider-types.ts` (Lines 1-125)

#### Supported Providers:
```typescript
export type EmbeddingProviderType = 'local' | 'openai' | 'google' | 'cohere' | 'voyage';
export type EmbeddingRuntime = 'browser' | 'hosted';
```

#### Discriminated Union Config:
```typescript
export type EmbeddingProviderConfig =
  | {
      runtime: 'browser';
      provider: 'local';
      modelId: string;  // e.g., 'jina-code'
      quantization?: 'q4' | 'q8' | 'fp16';
    }
  | {
      runtime: 'hosted';
      provider: 'openai';
      modelId: string;  // e.g., 'text-embedding-3-small'
      dimensions: number;  // Always 768 for our use case
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
      inputType?: 'search_document' | 'search_query';
    }
  | {
      runtime: 'hosted';
      provider: 'voyage';
      modelId: string;
      inputType?: 'document' | 'query';
    };
```

#### Error Types (Lines 58-95):
```typescript
export type EmbeddingProviderError =
  | { type: 'dimension_mismatch'; expected: number; received: number; modelId: string; }
  | { type: 'api_error'; provider: ...; statusCode: number; message: string; }
  | { type: 'model_load_failed'; provider: 'local'; modelId: string; reason: string; }
  | { type: 'missing_api_key'; provider: ...; }
  | { type: 'network_error'; provider: ...; originalError: Error; }
  | { type: 'rate_limit_exceeded'; provider: ...; retryAfter?: number; }
  | { type: 'validation_error'; field: string; message: string; };
```

Uses **Result pattern** (not exceptions):
```typescript
export type Result<T, E = EmbeddingProviderError> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

### 3.2 Provider Factory (`packages/embeddings/src/factory.ts`)
**File:** `packages/embeddings/src/factory.ts` (Lines 1-288)

**Purpose:** Implements Factory pattern with caching for provider instances

#### Key Methods:
```typescript
static async createProvider(
  config: EmbeddingProviderConfig
): Promise<Result<IEmbeddingProvider, EmbeddingProviderError>>

static getCachedProvider(
  provider: string,
  modelId: string,
  variant?: string
): IEmbeddingProvider | undefined

static async removeProvider(provider: string, modelId: string, variant?: string): Promise<boolean>

static async clearCache(): Promise<void>

static getCacheStats(): { size: number; providers: Array<...> }
```

#### Provider Creation Logic (Lines 52-152):
- **Local Providers:** Creates `TransformersEmbeddingProvider`
  - Quantization determines backend: q4/q8 → WASM, others → WebGPU
- **Hosted Providers:** Resolves API key first, then creates provider
  - OpenAI: Uses `OpenAIEmbeddingProvider`
  - Google: Uses `GoogleEmbeddingProvider`
  - Others: Not yet implemented (Phase 4)

#### Cache Key Format:
```
provider:modelId:variant
// Examples:
// local:jina-code:default
// openai:text-embedding-3-small:768
// google:text-embedding-004:768
```

### 3.3 Local Provider Implementation (`packages/embeddings/src/providers/local/transformers-provider.ts`)
**File:** `packages/embeddings/src/providers/local/transformers-provider.ts` (Lines 1-188)

**Class:** `TransformersEmbeddingProvider implements ILocalEmbeddingProvider`

#### Key Methods:
```typescript
constructor(modelKey: string, deviceOverride?: 'webgpu' | 'wasm' | 'cpu')

async initialize(onProgress?: (progress: {...}) => void): Promise<void>
async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, ...>>
async isAvailable(): Promise<boolean>
getModelInfo(modelId: string): ModelConfig | null
validateDimensions(embedding: number[], expectedDimensions: number): Result<void, ...>
getStatus(): 'idle' | 'initializing' | 'ready' | 'error'
async dispose(): Promise<void>
getCurrentModelKey(): string | null
```

#### Wraps SimpleEmbeddingService (Lines 17-30):
- Uses underlying `SimpleEmbeddingService` for model management
- Validates dimensions against `DEFAULT_EMBEDDING_DIMENSION` (768)
- Implements Result pattern error handling

### 3.4 Hosted Provider API Key Resolution (`packages/embeddings/src/providers/hosted/api-key-resolver.ts`)
**File:** `packages/embeddings/src/providers/hosted/api-key-resolver.ts` (Lines 1-132)

#### Key Resolution Order:
1. **Secrets API** (Lines 59-76): `window.secrets.getKey(provider)`
2. **Process Environment** (Lines 78-100):
   - Provider-specific keys (e.g., `BRAINSTRIKE_OPENAI_API_KEY`, `OPENAI_API_KEY`)
   - VITE_ prefixed variants for SSR builds
3. **Import Meta Environment** (Lines 102-123): `import.meta.env`

#### Supported Env Keys:
```typescript
const ENV_KEYS: Record<HostedProvider, readonly string[]> = {
  openai: [
    'BRAINSTRIKE_OPENAI_API_KEY',
    'BS_OPENAI_API_KEY',
    'OPENAI_API_KEY',
    'AI_OPENAI_API_KEY',
    'OPENAI_API_KEY_V1',
    'OPENAI_API_KEY_V2',
  ],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
  cohere: ['COHERE_API_KEY', 'AI_COHERE_API_KEY'],
  voyage: ['VOYAGE_API_KEY', 'AI_VOYAGE_API_KEY'],
};
```

#### Caching:
- API keys are cached after first resolution
- `clearHostedProviderApiKeyCache(provider?)` to clear cache

---

## 4. TEXT CHUNKING IMPLEMENTATION

### 4.1 Chunking Configuration (`packages/db/src/config/chunking-config.ts`)
**File:** `packages/db/src/config/chunking-config.ts` (Lines 1-45)

```typescript
export const CHUNKING_CONFIG = {
  // File size limits
  maxChunkableSize: 500 * 1024,  // 500KB max for chunking

  // Default chunk parameters
  defaultMaxTokens: 500,
  defaultOverlap: 50,

  // Code-specific defaults
  codeMaxTokens: 384,  // Smaller for better code retrieval
  codeOverlap: 48,

  // Large structured files
  largeStructuredMaxTokens: 1500,
  largeStructuredOverlap: 150,

  // Very large content (100KB+)
  veryLargeMaxTokens: 1000,
  veryLargeOverlap: 100,

  // Safety caps
  maxTokensSafetyCap: 4096,
  overlapSafetyCap: 1024,

  // Token estimation
  averageCharsPerToken: 4,

  // Timing
  embeddingInitializationDelay: 500,
  embeddingProcessingDelay: 10,
};
```

### 4.2 Chunking Service (`packages/db/src/services/chunking-service.ts`)
**File:** `packages/db/src/services/chunking-service.ts` (Lines 1-150+)

#### Chunking Strategies:
```typescript
export type ChunkingStrategy = 'sentence' | 'token' | 'recursive';
```

#### Strategy Selection Logic (Lines 15-44 in `packages/file-import/src/chunking.ts`):
```typescript
function getChunkingStrategy(filePath: string, defaultStrategy?: ChunkingStrategy): ChunkingStrategy {
  const extension = fileExplorer.getFileExtension(filePath);
  const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', ...];
  
  if (codeExtensions.includes(extension)) {
    return 'recursive';  // Better for code structure
  }
  return 'sentence';  // Default for text
}
```

#### Chunking Options:
```typescript
export interface ChunkingOptions {
  strategy: ChunkingStrategy;
  maxTokens?: number;
  overlap?: number;
  separators?: string[];
  fileName?: string;
  filePath?: string;
  allowLargeFiles?: boolean;
  forceStrategy?: boolean;
  tokenCounter?: (text: string) => Promise<number>;
  tokenTrueSizing?: boolean;
  maxTokensCap?: number;
  onStrategyResolved?: (strategy: ChunkingStrategy) => void;
  ignoreFileTypeRecommendations?: boolean;
}
```

#### Skip Patterns (Lines 47-68):
- Lock files: `package-lock.json`, `pnpm-lock.yaml`, etc.
- Minified/build artifacts: `.min.js`, `.map`, `.wasm`
- Large directories: `node_modules`, `dist`, `build`, `coverage`

#### Large Structured Files (Lines 71-78):
- JSON, XML, CSV, TSV, SQL, LOG files
- Use more aggressive chunking (smaller chunks)

### 4.3 File Chunk Model (`packages/db/src/models/file-chunk.ts`)
**File:** `packages/db/src/models/file-chunk.ts` (Lines 1-62)

```typescript
export interface FileChunk {
  id: string;
  fileRecordId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize: number;
  embedding?: number[];  // 768D vector
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  embeddingHash?: string;
  createdAt: string;
  updatedAt: string;
}
```

---

## 5. PREFERENCE STORES & STATE MANAGEMENT

### 5.1 Embedding Preferences Store (`packages/preferences/src/stores/embedding-preferences-store.ts`)
**File:** `packages/preferences/src/stores/embedding-preferences-store.ts` (Lines 1-449)

**Store Name:** `embedding-preferences.v1`
**Version:** 1

#### State Shape:
```typescript
interface EmbeddingPreferencesData {
  selectedModel: string | null;  // "local::jina-code"
  enabledModelsByProvider: Record<EmbeddingProviderType, string[]>;
  preferredRuntime: 'browser' | 'hosted';
}
```

#### Default Values (Lines 100-111):
```typescript
const DEFAULT_ENABLED_MODELS = {
  local: ['jina-code'],      // Default local model enabled
  openai: [],                // Disabled by default (needs API key)
  google: [],
  cohere: [],
  voyage: [],
};

const DEFAULT_SELECTED_MODEL = 'local::jina-code';
```

#### Key Methods (Lines 255-382):
```typescript
// Model selection
setModel(compositeKey: string): void
clearModel(): void
getSelectedModel(): string | null
getSelectedProvider(): EmbeddingProviderType | null
getSelectedModelId(): string | null

// Model availability
setModelEnabled(provider: EmbeddingProviderType, model: string, enabled: boolean): void
setProviderModelsEnabled(provider: EmbeddingProviderType, models: string[], enabled: boolean): void
getEnabledModels(provider: EmbeddingProviderType): string[]

// Runtime preference
setPreferredRuntime(runtime: 'browser' | 'hosted'): void
```

#### State Validation (Lines 262-303):
- Validates composite key format: `"provider::model"`
- Warns if model not enabled for provider
- Prevents selection of disabled models

#### Migration Logic (Lines 392-421):
- Handles legacy string-based selectedModel
- Migrates to composite key format: `"local::modelId"`
- Preserves backwards compatibility

#### Storage (Lines 116-136):
- Uses `localStorage` with fallback to in-memory Map
- Handles SSR/test environments safely

### 5.2 Vector Preferences Store (`packages/preferences/src/stores/vector-preferences-store.ts`)
**File:** `packages/preferences/src/stores/vector-preferences-store.ts` (Lines 1-72)

**Store Name:** `vector-preferences.v1`
**Version:** 1

#### State Shape:
```typescript
interface VectorPreferencesData {
  devicePref: 'auto' | 'webgpu' | 'wasm' | 'cpu';
  reinitEveryN: number;  // Default: 200
  forceCpuAfterFailures: number;  // Default: 3
  verboseOrtLogs: boolean;  // Default: false
}
```

#### Methods:
```typescript
setDevicePref(v: 'auto' | 'webgpu' | 'wasm' | 'cpu'): void
setReinitEveryN(n: number): void
setForceCpuAfterFailures(n: number): void
setVerboseOrtLogs(v: boolean): void
```

---

## 6. EMBEDDING DIMENSIONS & CONSTANTS

### 6.1 Standard Embedding Dimension (`packages/types/src/embedding-constants.ts`)
**File:** `packages/types/src/embedding-constants.ts` (Lines 1-2)

```typescript
export const DEFAULT_EMBEDDING_DIMENSION = 768;
export const MAX_EMBEDDING_DIMENSION = 16_000;
```

**Used throughout the codebase:**
- Validation in `TransformersEmbeddingProvider.validateDimensions()`
- UI badges showing dimension compatibility
- Database schema compatibility checks
- Queue dimension validation in embedding worker

### 6.2 Standard Embedding Dimension Usage
- **Default model (jina-code):** 768D
- **Other 768D models:** bge-base-en-v1.5
- **Non-compatible models:** 384D (all-MiniLM-L6-v2, bge-small-en-v1.5), 1024D (bge-large-en-v1.5)

---

## 7. EMBEDDING WORKER (`packages/embedding-worker`)

### 7.1 Worker Index (`packages/embedding-worker/src/index.ts`)
**File:** `packages/embedding-worker/src/index.ts` (Lines 1-32)

```typescript
export type {
  EmbeddingDevice,
  EmbeddingDeviceHint,
  EmbeddingDType,
  EmbedWorkerError,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerSuccess,
} from './shared';

export {
  computeInitialBatchSize,
  l2Normalize,
  truncateVector,
  vectorsFromPipelineOutput,
} from './shared';

export function resolveEmbeddingWorkerUrl(): URL
```

### 7.2 Worker Implementation (`packages/embedding-worker/src/embedding.worker.ts`)
**File:** `packages/embedding-worker/src/embedding.worker.ts`

#### Device Inference (Lines 37-49):
```typescript
function hasWebGPU(): boolean
function inferDevice(hint: EmbeddingDeviceHint = 'auto'): EmbeddingDevice {
  if (hint === 'auto') {
    return hasWebGPU() ? 'webgpu' : 'wasm';
  }
  return hint === 'webgpu' && hasWebGPU() ? 'webgpu' : 'wasm';
}
```

#### Pipeline Loading & Caching (Lines 51-77):
- Caches loaded pipelines by: `model|device|dtype`
- Fallback from WebGPU to WASM on error
- Uses transformers.js `pipeline('feature-extraction', model, {...})`

#### Dimension Validation (Lines 79-100):
- Validates `targetDimension` is positive finite integer
- Checks against `DEFAULT_EMBEDDING_DIMENSION` (768)
- Prevents dimension mismatch errors

---

## 8. PROVIDER UTILITIES & HELPERS

### 8.1 Provider Model Parsing (`packages/embeddings/src/provider-utils.ts`)
**File:** `packages/embeddings/src/provider-utils.ts` (Lines 1-65)

```typescript
export function formatProviderModelKey(provider: EmbeddingProviderType, modelId: string): string
  // Returns: "provider::modelId"

export function parseProviderModelKey(composite: string | null): ParsedProviderModel | null
  // Parses both "provider::modelId" (new) and "provider:modelId" (legacy)

export function isHostedProvider(provider: EmbeddingProviderType): boolean

export function canonicalizeProviderModelKey(
  modelKey: string | null,
  providerHint?: EmbeddingProviderType
): { provider: EmbeddingProviderType; modelId: string; composite: string } | null
```

---

## 9. SERVICE INTERFACES

### 9.1 Embedding Provider Interface (`packages/embeddings/src/interfaces/provider.ts`)
**File:** `packages/embeddings/src/interfaces/provider.ts` (Lines 1-117)

#### IEmbeddingProvider (Lines 20-60):
```typescript
export interface IEmbeddingProvider {
  embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>>;
  isAvailable(): Promise<boolean>;
  getModelInfo(modelId: string): ModelConfig | null;
  validateDimensions(embedding: number[], expectedDimensions: number): Result<void, ...>;
}
```

#### ILocalEmbeddingProvider (Lines 66-91):
```typescript
export interface ILocalEmbeddingProvider extends IEmbeddingProvider {
  readonly runtime: 'browser';
  readonly provider: 'local';
  
  initialize(onProgress?: (progress: {...}) => void): Promise<void>;
  dispose(): Promise<void>;
  getStatus(): 'idle' | 'initializing' | 'ready' | 'error';
}
```

#### IHostedEmbeddingProvider (Lines 97-116):
```typescript
export interface IHostedEmbeddingProvider extends IEmbeddingProvider {
  readonly runtime: 'hosted';
  readonly provider: Exclude<EmbeddingProviderType, 'local'>;
  
  setApiKey(apiKey: string): void;
  hasApiKey(): boolean;
}
```

---

## 10. EMBEDDING TYPES & DATA STRUCTURES

### 10.1 Core Types (`packages/embeddings/src/types.ts`)
**File:** `packages/embeddings/src/types.ts` (Lines 1-182)

```typescript
export interface EmbeddingConfig {
  modelId: string;
  device?: 'webgpu' | 'wasm' | 'cpu';
  quantized?: boolean;
  revision?: string;
  cacheDir?: string;
}

export interface ModelConfig {
  id: string;
  name: string;
  dimensions: number;
  quantized: boolean;
  description: string;
  tags: string[];
  origin: string;
  size: string;
}

export interface ModelRegistry {
  default: string;
  models: Record<string, ModelConfig>;
}

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
  model: string;
}

export interface SimilarityResult {
  similarity: number;
  distance: number;
  method: 'cosine' | 'euclidean' | 'manhattan' | 'l2' | 'dot_product';
}

export type EmbeddingStatus = 'idle' | 'initializing' | 'downloading' | 'ready' | 'processing' | 'error' | 'disposed';

export interface EmbeddingProgress {
  stage: 'initializing' | 'downloading' | 'processing' | 'ready' | 'error';
  progress?: number;
  message?: string;
  file?: string;
  loaded?: number;
  total?: number;
}
```

### 10.2 BGE-M3 Configuration (Lines 152-163):
```typescript
export const BGE_M3_CONFIG = {
  modelId: 'Xenova/bge-m3',
  dimensions: 1024,
  maxLength: 8192,
  supportedLanguages: ['en', 'zh', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko'],
  retrievalModes: ['dense', 'sparse', 'colbert'] as const,
};
```

### 10.3 Fallback Model Configuration (Lines 168-179):
```typescript
export const FALLBACK_MODEL_CONFIG = {
  modelId: 'Xenova/all-MiniLM-L6-v2',
  dimensions: 384,
  maxLength: 512,
  supportedLanguages: ['en'],
  retrievalModes: ['dense'] as const,
};
```

---

## 11. SIMPLE EMBEDDING SERVICE (`packages/embeddings/src/bge-m3-service.ts`)

**File:** `packages/embeddings/src/bge-m3-service.ts` (Lines 1-250+)

### Class: SimpleEmbeddingService implements EmbeddingService

#### Key Methods:
```typescript
constructor()
  // Initializes with default model from registry

async initializeWithModel(
  modelKey?: string,
  onProgress?: (progress: EmbeddingProgress) => void,
  deviceOverride?: 'webgpu' | 'wasm' | 'cpu'
): Promise<void>

async initialize(
  config?: Partial<EmbeddingConfig>,
  onProgress?: (progress: EmbeddingProgress) => void
): Promise<void>

async generateEmbedding(text: string): Promise<EmbeddingResult>
async generateDocEmbedding(text: string): Promise<EmbeddingResult>
async generateQueryEmbedding(text: string): Promise<EmbeddingResult>

calculateSimilarity(embedding1: number[], embedding2: number[]): SimilarityResult

getStatus(): EmbeddingStatus
getConfig(): EmbeddingConfig
getCurrentModelKey(): string | null
getCurrentModelConfig(): ModelConfig | null

async dispose(): Promise<void>
```

#### Device Preferences (Uses VectorPreferencesStore):
- `devicePref`: auto | webgpu | wasm | cpu
- `reinitEveryN`: Reinitialize after N embeddings
- `forceCpuAfterFailures`: Force CPU after N failures
- `verboseOrtLogs`: Enable ONNX Runtime logs

---

## 12. CONFIGURATION FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│                  EmbeddingSettings Component                     │
│                 (packages/preferences/src/...)                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│            useEmbeddingPreferencesStore (Zustand)                │
│         (embedding-preferences-store.ts: Lines 255-424)          │
│                                                                   │
│  State:                                                          │
│  - selectedModel: "local::jina-code"                             │
│  - enabledModelsByProvider: { local: ['jina-code'], ... }       │
│  - preferredRuntime: 'browser'                                   │
│                                                                   │
│  Actions:                                                        │
│  - setModel(compositeKey)                                        │
│  - setModelEnabled(provider, model, enabled)                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              EmbeddingProviderFactory.createProvider             │
│                  (factory.ts: Lines 52-152)                      │
│                                                                   │
│  Input: EmbeddingProviderConfig                                  │
│  Output: Result<IEmbeddingProvider, EmbeddingProviderError>     │
│                                                                   │
│  Creates:                                                        │
│  - Local: TransformersEmbeddingProvider                          │
│  - Hosted: OpenAI/Google/etc. Provider                           │
│                                                                   │
│  Caches by: "provider:modelId:variant"                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│          Provider Implementation (Interface: IEmbeddingProvider) │
│                                                                   │
│  TransformersEmbeddingProvider (local):                          │
│  ├─ Uses SimpleEmbeddingService                                  │
│  ├─ Wraps with TransformersBackend                              │
│  └─ Validates dimensions: 768D or fails                          │
│                                                                   │
│  OpenAIEmbeddingProvider (hosted):                               │
│  ├─ Resolves API key from environment                            │
│  └─ Calls OpenAI API                                             │
│                                                                   │
│  GoogleEmbeddingProvider (hosted):                               │
│  ├─ Resolves API key from environment                            │
│  └─ Calls Google API                                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              Model Registry (model-registry.json)                │
│                 (Lines 1-55)                                     │
│                                                                   │
│  Models:                                                         │
│  ├─ jina-code (768D) ◄─ DEFAULT                                 │
│  ├─ all-MiniLM-L6-v2 (384D)                                      │
│  ├─ bge-small-en-v1.5 (384D)                                     │
│  ├─ bge-base-en-v1.5 (768D)                                      │
│  └─ bge-large-en-v1.5 (1024D)                                    │
│                                                                   │
│  Key: models have dimensions checked against:                    │
│  DEFAULT_EMBEDDING_DIMENSION = 768                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 13. KEY FILE REFERENCES

| Component | File Path | Lines | Purpose |
|-----------|-----------|-------|---------|
| **Model Registry** | `packages/embeddings/model-registry.json` | - | Available models definition |
| **Registry Manager** | `packages/embeddings/src/model-registry.ts` | 1-96 | Registry access functions |
| **Types** | `packages/embeddings/src/types.ts` | 1-182 | Core type definitions |
| **Provider Types** | `packages/embeddings/src/provider-types.ts` | 1-125 | Provider discriminated unions |
| **Provider Factory** | `packages/embeddings/src/factory.ts` | 1-288 | Provider instance factory |
| **Local Provider** | `packages/embeddings/src/providers/local/transformers-provider.ts` | 1-188 | Local embedding provider |
| **API Key Resolver** | `packages/embeddings/src/providers/hosted/api-key-resolver.ts` | 1-132 | Environment/secrets API key resolution |
| **Provider Interface** | `packages/embeddings/src/interfaces/provider.ts` | 1-117 | Provider interface contracts |
| **Simple Service** | `packages/embeddings/src/bge-m3-service.ts` | 1-250+ | Main embedding service |
| **Transformers Backend** | `packages/embeddings/src/transformers-backend.ts` | 1-100+ | Transformers.js wrapper |
| **Embedding Settings UI** | `packages/preferences/src/embedding/embedding-settings-section.tsx` | 1-603 | Settings UI component |
| **Embedding Prefs Store** | `packages/preferences/src/stores/embedding-preferences-store.ts` | 1-449 | Model selection state |
| **Vector Prefs Store** | `packages/preferences/src/stores/vector-preferences-store.ts` | 1-72 | Device/vector settings |
| **Chunking Config** | `packages/db/src/config/chunking-config.ts` | 1-45 | Text chunking parameters |
| **Chunking Service** | `packages/db/src/services/chunking-service.ts` | 1-150+ | Text chunking implementation |
| **File Chunk Model** | `packages/db/src/models/file-chunk.ts` | 1-62 | Chunk storage structure |
| **Embedding Constants** | `packages/types/src/embedding-constants.ts` | 1-2 | 768D dimension constant |
| **Embedding Worker** | `packages/embedding-worker/src/embedding.worker.ts` | 1-100+ | Web worker implementation |
| **Provider Utils** | `packages/embeddings/src/provider-utils.ts` | 1-65 | Provider key parsing |

---

## 14. SUMMARY

**BrainStrike's embedding system is:**

1. **Modular & Provider-Agnostic:**
   - Local models (Transformers.js) for browser
   - Hosted providers (OpenAI, Google, Cohere, Voyage) for cloud
   - Factory pattern for flexible provider creation

2. **Default: Jina Code (768D)**
   - Code-aware model from Jina AI
   - 30+ language support
   - 8K context window
   - Uses transformers.js for local inference

3. **Dimension-First Design:**
   - 768D (DEFAULT_EMBEDDING_DIMENSION) is the standard
   - UI enforces compatibility checks
   - Non-768D models flagged as incompatible
   - Database schema expects 768D vectors

4. **Smart Configuration:**
   - Composite keys: `"provider::modelId"`
   - Per-provider enable/disable
   - Device preferences (WebGPU/WASM/CPU)
   - API key resolution from multiple sources

5. **Text Processing:**
   - Recursive chunking for code
   - Sentence-level chunking for text
   - Token-based sizing with overflow protection
   - Skips lock files and build artifacts

6. **State Management:**
   - Zustand stores for model selection
   - Persisted preferences (localStorage/in-memory)
   - Result pattern for error handling (no exceptions)
   - Type-safe discriminated unions
