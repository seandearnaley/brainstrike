import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';

export const STANDARD_EMBEDDING_DIMENSION = DEFAULT_EMBEDDING_DIMENSION;

export type ResolvedChunkingStrategy =
  | 'character'
  | 'recursive'
  | 'token'
  | 'markdown'
  | 'semantic-markdown'
  | 'html'
  | 'json'
  | 'latex'
  | 'sentence';

export type ChunkingStrategy = 'auto' | ResolvedChunkingStrategy;

export type ChunkingPresetId =
  | 'balanced'
  | 'codebase'
  | 'strict-code'
  | 'docs'
  | 'api-reference'
  | 'structured-data'
  | 'large-context';

export type ChunkingPresetSelection = ChunkingPresetId | 'custom';

export interface ChunkingPresetDefinition {
  readonly adaptiveRouting: boolean;
  readonly bestFor: readonly string[];
  readonly chunkOverlap: number;
  readonly chunkSize: number;
  readonly description: string;
  readonly id: ChunkingPresetId;
  readonly isDefault?: boolean;
  readonly label: string;
  readonly strategy: ChunkingStrategy;
  readonly tokenLimit: number;
  readonly tradeoff: string;
}

export interface ChunkingRoutePreview {
  readonly fileName: string;
  readonly label: string;
  readonly reason: string;
  readonly resolvedStrategy: ResolvedChunkingStrategy;
}

const CODE_EXTENSIONS = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'java',
  'cpp',
  'c',
  'h',
  'hpp',
  'cs',
  'php',
  'rb',
  'go',
  'rs',
  'swift',
  'kt',
  'kts',
  'scala',
  'vue',
  'svelte',
]);

const RESOLVED_CHUNKING_STRATEGIES = new Set<ResolvedChunkingStrategy>([
  'character',
  'recursive',
  'token',
  'markdown',
  'semantic-markdown',
  'html',
  'json',
  'latex',
  'sentence',
]);

const CHUNKING_PRESETS: readonly ChunkingPresetDefinition[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'General-purpose defaults that auto-detect the best splitter for most files.',
    adaptiveRouting: true,
    bestFor: ['mixed repos', 'teams starting out', 'general retrieval'],
    strategy: 'auto',
    chunkSize: 256,
    chunkOverlap: 50,
    tokenLimit: 4096,
    isDefault: true,
    tradeoff: 'Not as aggressive as specialist presets for code-only or schema-heavy corpora.',
  },
  {
    id: 'codebase',
    label: 'Codebase',
    description:
      'Adaptive mixed-repo preset: code stays tight while docs and data keep their own structure.',
    adaptiveRouting: true,
    bestFor: ['monorepos', 'product docs + code', 'engineering assistants'],
    strategy: 'auto',
    chunkSize: 224,
    chunkOverlap: 40,
    tokenLimit: 3072,
    tradeoff: 'More conservative chunk sizing can increase chunk count on very large repos.',
  },
  {
    id: 'strict-code',
    label: 'Strict Code',
    description:
      'Forces recursive code-centric chunking for source-only corpora where locality matters most.',
    adaptiveRouting: false,
    bestFor: ['source-only repos', 'symbol retrieval', 'diff-aware assistants'],
    strategy: 'recursive',
    chunkSize: 192,
    chunkOverlap: 40,
    tokenLimit: 3072,
    tradeoff: 'Will over-treat docs and schemas as code if you point it at a mixed corpus.',
  },
  {
    id: 'docs',
    label: 'Docs',
    description: 'Prefers semantic markdown grouping for guides, notes, and README-heavy content.',
    adaptiveRouting: false,
    bestFor: ['handbooks', 'runbooks', 'README sets'],
    strategy: 'semantic-markdown',
    chunkSize: 320,
    chunkOverlap: 56,
    tokenLimit: 4096,
    tradeoff: "Non-markdown files won't benefit from the heading-family bias.",
  },
  {
    id: 'api-reference',
    label: 'API Reference',
    description: 'Smaller, denser chunks for reference docs where precision matters.',
    adaptiveRouting: false,
    bestFor: ['API docs', 'SDK references', 'parameter lookups'],
    strategy: 'markdown',
    chunkSize: 192,
    chunkOverlap: 32,
    tokenLimit: 3072,
    tradeoff: 'Can fragment long-form guides more than general-purpose presets.',
  },
  {
    id: 'structured-data',
    label: 'Structured Data',
    description: 'Structure-aware splitting for JSON-like payloads and schema-heavy content.',
    adaptiveRouting: false,
    bestFor: ['JSON payloads', 'schemas', 'machine-readable docs'],
    strategy: 'json',
    chunkSize: 384,
    chunkOverlap: 64,
    tokenLimit: 6144,
    tradeoff: 'Less effective for prose-heavy files that only happen to live near structured data.',
  },
  {
    id: 'large-context',
    label: 'Large Context',
    description: 'Fewer, larger chunks when downstream models can tolerate bigger payloads.',
    adaptiveRouting: false,
    bestFor: ['large-context models', 'broad semantic recall', 'fewer chunk boundaries'],
    strategy: 'token',
    chunkSize: 512,
    chunkOverlap: 64,
    tokenLimit: 8192,
    tradeoff: 'Bigger chunks can reduce precision for exact retrieval and reranking.',
  },
] as const;

const ROUTE_PREVIEW_CANDIDATES: readonly Omit<ChunkingRoutePreview, 'resolvedStrategy'>[] = [
  {
    label: 'Code module',
    fileName: 'src/assistant/retrieval.ts',
    reason: 'Keeps symbols and local control flow together for code retrieval.',
  },
  {
    label: 'Guide / handbook',
    fileName: 'docs/getting-started.md',
    reason: 'Preserves heading families so sections stay coherent in retrieval.',
  },
  {
    label: 'Structured payload',
    fileName: 'schemas/search-response.json',
    reason: 'Favors object and array boundaries instead of sentence splits.',
  },
  {
    label: 'Markup page',
    fileName: 'public/reference/index.html',
    reason: 'Uses block and tag boundaries so markup stays readable in context.',
  },
  {
    label: 'Research paper',
    fileName: 'notes/retrieval-paper.tex',
    reason: 'Prefers section and environment boundaries for long technical writing.',
  },
  {
    label: 'Plain notes',
    fileName: 'notes/retro.txt',
    reason: 'Falls back to natural sentence boundaries for general prose.',
  },
] as const;

const EXTENSION_STRATEGY_MAP = new Map<string, ResolvedChunkingStrategy>([
  ['md', 'semantic-markdown'],
  ['mdx', 'semantic-markdown'],
  ['markdown', 'semantic-markdown'],
  ['rst', 'semantic-markdown'],
  ['adoc', 'semantic-markdown'],
  ['asciidoc', 'semantic-markdown'],
  ['html', 'html'],
  ['htm', 'html'],
  ['xhtml', 'html'],
  ['xml', 'html'],
  ['svg', 'html'],
  ['json', 'json'],
  ['jsonl', 'json'],
  ['ndjson', 'json'],
  ['geojson', 'json'],
  ['ipynb', 'json'],
  ['tex', 'latex'],
  ['latex', 'latex'],
  ['bib', 'latex'],
]);

function getChunkingFileExtension(filePath: string): string {
  const normalized = filePath.toLowerCase();
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1 || lastDot < lastSlash) {
    return '';
  }
  return normalized.slice(lastDot + 1);
}

export function isResolvedChunkingStrategy(value: unknown): value is ResolvedChunkingStrategy {
  return (
    typeof value === 'string' && RESOLVED_CHUNKING_STRATEGIES.has(value as ResolvedChunkingStrategy)
  );
}

export function isChunkingStrategy(value: unknown): value is ChunkingStrategy {
  return value === 'auto' || isResolvedChunkingStrategy(value);
}

export function getChunkingPresetDefinitions(): readonly ChunkingPresetDefinition[] {
  return CHUNKING_PRESETS;
}

export function getChunkingPreset(id: ChunkingPresetId): ChunkingPresetDefinition {
  const preset = CHUNKING_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error(`Unknown chunking preset: ${id}`);
  }
  return preset;
}

export function resolveChunkingStrategyForFile(
  filePath: string,
  requested: ChunkingStrategy = 'auto'
): ResolvedChunkingStrategy {
  if (requested !== 'auto') {
    return requested;
  }

  const extension = getChunkingFileExtension(filePath);
  if (CODE_EXTENSIONS.has(extension)) {
    return 'recursive';
  }
  return EXTENSION_STRATEGY_MAP.get(extension) ?? 'sentence';
}

export function resolveEffectiveChunkingStrategy({
  requested,
  resolvedAutoStrategy,
  isCode,
}: {
  requested: ChunkingStrategy;
  resolvedAutoStrategy: ResolvedChunkingStrategy;
  isCode: boolean;
}): ResolvedChunkingStrategy {
  if (requested !== 'auto') {
    return requested;
  }
  if (resolvedAutoStrategy === 'recursive' && !isCode) {
    return 'sentence';
  }
  return resolvedAutoStrategy;
}

export function getChunkingRoutePreview(
  requested: ChunkingStrategy = 'auto'
): readonly ChunkingRoutePreview[] {
  return ROUTE_PREVIEW_CANDIDATES.map((candidate) => ({
    ...candidate,
    resolvedStrategy: resolveChunkingStrategyForFile(candidate.fileName, requested),
  }));
}

export type EmbeddingDevice = 'webgpu' | 'wasm';

export type EmbeddingDeviceHint = EmbeddingDevice;

export type EmbeddingDType = 'fp16' | 'q4' | 'fp32';

export type EmbeddingDimensionParameter =
  | 'dimensions'
  | 'output_dimensionality'
  | 'output_dimension';

export type EmbeddingProviderType =
  | 'local'
  | 'transformers'
  | 'openai'
  | 'google'
  | 'cohere'
  | 'voyage'
  | 'ollama'
  | 'lmstudio';

export type LocalProviderType = 'local' | 'transformers';

export type HostedProviderType = Exclude<EmbeddingProviderType, LocalProviderType>;

export type EmbeddingRuntime = 'browser' | 'hosted';

export type DistanceMetric = 'cosine' | 'l2' | 'ip';

export type ProviderDimensionParameter = EmbeddingDimensionParameter;

export interface IndexingEmbeddingJobChunk {
  readonly content?: string | null;
  readonly contentHash?: string | null;
  readonly embeddingSetId?: string | null;
  readonly id: string;
}

export interface IndexingEmbeddingJobQueueBatchOptions<TTransaction = unknown> {
  readonly dimensionParameter?: ProviderDimensionParameter | null;
  readonly model?: string | null;
  readonly provider?: EmbeddingProviderType | null;
  readonly signal?: AbortSignal | null;
  readonly targetDimension?: number | null;
  readonly targetEmbeddingSetId?: string | null;
  readonly transaction?: TTransaction | null;
}

export interface IndexingEmbeddingJobQueuePort<TTransaction = unknown> {
  enqueueBatch(
    chunks: readonly IndexingEmbeddingJobChunk[],
    fileRecordId: string,
    options?: IndexingEmbeddingJobQueueBatchOptions<TTransaction>
  ): Promise<void>;
  resetProgress?: () => void;
}

export interface EmbeddingModelConfig {
  contextWindow?: number;
  description: string;
  dimensions: number;
  id: string;
  name: string;
  origin?: string;
  pricePer1MTokens?: number;
  quantized?: boolean;
  size?: string;
  supportedDimensions?: number[] | string;
  tags: string[];
}

export interface ProviderMetadata {
  contextWindow?: number;
  dimensions: number;
  displayName?: string;
  distance: DistanceMetric;
  modelKey: string;
  providerId: EmbeddingProviderType;
}

interface BaseEmbeddingModelDefinition {
  default?: boolean;
  id: string;
  label?: string;
  type: 'embedding';
}

export interface EmbeddingModelDefinition extends BaseEmbeddingModelDefinition {
  availableDimensions?: readonly number[];
  defaultDimension: number;
  dimensionParameter?: EmbeddingDimensionParameter;
  supportsCustomDimensions?: boolean;
  supportsStandardDimension: boolean;
}

export interface EmbeddingProviderDefinition {
  displayName: string;
  envKeys?: readonly string[];
  id: EmbeddingProviderType;
  models: readonly EmbeddingModelDefinition[];
  runtime: EmbeddingRuntime;
}

export interface ParsedEmbeddingProviderModel {
  modelId: string;
  provider: EmbeddingProviderType;
}

const PROVIDER_SEPARATOR = '::';
const LEGACY_PROVIDER_SEPARATOR = ':';

const NO_API_KEY_HOSTED_PROVIDERS: ReadonlySet<HostedProviderType> = new Set([
  'ollama',
  'lmstudio',
]);

const EMBEDDING_PROVIDER_DEFINITIONS: readonly EmbeddingProviderDefinition[] = [
  {
    id: 'local',
    displayName: 'Local (Browser)',
    runtime: 'browser',
    models: [],
  },
  {
    id: 'transformers',
    displayName: 'Transformers.js',
    runtime: 'browser',
    models: [],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    runtime: 'hosted',
    envKeys: [
      'BRAINSTRIKE_OPENAI_API_KEY',
      'BS_OPENAI_API_KEY',
      'OPENAI_API_KEY',
      'AI_OPENAI_API_KEY',
      'OPENAI_API_KEY_V1',
      'OPENAI_API_KEY_V2',
    ],
    models: [
      {
        id: 'text-embedding-3-small',
        type: 'embedding',
        default: true,
        defaultDimension: 1536,
        supportsCustomDimensions: true,
        dimensionParameter: 'dimensions',
        supportsStandardDimension: true,
      },
      {
        id: 'text-embedding-3-large',
        type: 'embedding',
        defaultDimension: 3072,
        supportsCustomDimensions: true,
        dimensionParameter: 'dimensions',
        supportsStandardDimension: true,
      },
    ],
  },
  {
    id: 'google',
    displayName: 'Google AI Studio',
    runtime: 'hosted',
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
    models: [
      {
        id: 'gemini-embedding-001',
        type: 'embedding',
        default: true,
        defaultDimension: 3072,
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        dimensionParameter: 'output_dimensionality',
      },
    ],
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    runtime: 'hosted',
    envKeys: ['COHERE_API_KEY', 'AI_COHERE_API_KEY'],
    models: [
      {
        id: 'embed-english-v3.0',
        type: 'embedding',
        default: true,
        defaultDimension: 1024,
        availableDimensions: [1024],
        supportsStandardDimension: true,
      },
      {
        id: 'embed-multilingual-v3.0',
        type: 'embedding',
        defaultDimension: 1024,
        availableDimensions: [1024],
        supportsStandardDimension: true,
      },
    ],
  },
  {
    id: 'voyage',
    displayName: 'Voyage AI',
    runtime: 'hosted',
    envKeys: ['VOYAGE_API_KEY', 'AI_VOYAGE_API_KEY'],
    models: [
      {
        id: 'voyage-3',
        type: 'embedding',
        default: true,
        defaultDimension: 1024,
        availableDimensions: [1024],
        supportsStandardDimension: true,
      },
      {
        id: 'voyage-3-lite',
        type: 'embedding',
        defaultDimension: 512,
        availableDimensions: [512],
        supportsStandardDimension: false,
      },
    ],
  },
  {
    id: 'ollama',
    displayName: 'Ollama (Local Runtime)',
    runtime: 'hosted',
    models: [],
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio (Local Runtime)',
    runtime: 'hosted',
    models: [],
  },
];

const EMBEDDING_PROVIDER_BY_ID = Object.fromEntries(
  EMBEDDING_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
) as Record<EmbeddingProviderType, EmbeddingProviderDefinition>;

export function listEmbeddingProviderDefinitions(): readonly EmbeddingProviderDefinition[] {
  return EMBEDDING_PROVIDER_DEFINITIONS;
}

export function getEmbeddingProviderDefinition(
  provider: EmbeddingProviderType
): EmbeddingProviderDefinition {
  return EMBEDDING_PROVIDER_BY_ID[provider];
}

export function isLocalProviderType(
  provider: EmbeddingProviderType
): provider is LocalProviderType {
  return provider === 'local' || provider === 'transformers';
}

export function isHostedProvider(provider: EmbeddingProviderType): provider is HostedProviderType {
  return !isLocalProviderType(provider);
}

export function hostedProviderRequiresApiKey(provider: HostedProviderType): boolean {
  return !NO_API_KEY_HOSTED_PROVIDERS.has(provider);
}

export function formatEmbeddingProviderModelKey(
  provider: EmbeddingProviderType,
  modelId: string
): string {
  return `${provider}${PROVIDER_SEPARATOR}${modelId}`;
}

export function parseEmbeddingProviderModelKey(
  composite: string | null | undefined
): ParsedEmbeddingProviderModel | null {
  if (!composite) {
    return null;
  }

  if (composite.includes(PROVIDER_SEPARATOR)) {
    const separatorIndex = composite.indexOf(PROVIDER_SEPARATOR);
    const provider = composite.slice(0, separatorIndex).trim();
    const modelId = composite.slice(separatorIndex + PROVIDER_SEPARATOR.length).trim();
    if (!(provider && modelId && provider in EMBEDDING_PROVIDER_BY_ID)) {
      return null;
    }
    return {
      provider: provider as EmbeddingProviderType,
      modelId,
    };
  }

  const legacyIndex = composite.indexOf(LEGACY_PROVIDER_SEPARATOR);
  if (legacyIndex > 0 && legacyIndex < composite.length - 1) {
    const provider = composite.slice(0, legacyIndex).trim();
    const modelId = composite.slice(legacyIndex + LEGACY_PROVIDER_SEPARATOR.length).trim();
    if (!(provider && modelId && provider in EMBEDDING_PROVIDER_BY_ID)) {
      return null;
    }
    return {
      provider: provider as EmbeddingProviderType,
      modelId,
    };
  }

  return null;
}

export function canonicalizeEmbeddingProviderModelKey(
  modelKey: string | null | undefined,
  providerHint?: EmbeddingProviderType
): { provider: EmbeddingProviderType; modelId: string; composite: string } | null {
  const parsed = parseEmbeddingProviderModelKey(modelKey);
  const provider = parsed?.provider ?? providerHint ?? 'local';
  const rawModelId = parsed?.modelId ?? modelKey?.trim() ?? '';
  if (!rawModelId) {
    return null;
  }
  return {
    provider,
    modelId: rawModelId,
    composite: formatEmbeddingProviderModelKey(provider, rawModelId),
  };
}

export interface EmbedWorkerRequest {
  readonly deviceHint: EmbeddingDeviceHint;
  readonly dimensionParameter?: EmbeddingDimensionParameter;
  readonly dtype?: EmbeddingDType;
  readonly id: string;
  readonly maxBatchSize?: number;
  readonly model: string;
  readonly provider?: string;
  readonly targetDimension?: number;
  readonly texts: readonly string[];
  readonly truncateDim?: number;
  readonly type: 'embed';
}

export interface EmbedWorkerProgress {
  readonly id: string;
  readonly phase: 'initializing' | 'embedding' | 'complete';
  readonly progress: number;
  readonly type: 'progress';
}

export interface EmbedWorkerPipelineCacheMemoryDiagnostic {
  readonly gpuBytes: number | null;
  readonly heapBytes: number | null;
  readonly reason: 'browser-runtime-unavailable' | 'measured';
}

export interface EmbedWorkerPipelineCacheEntryDiagnostic {
  readonly cacheKey: string;
  readonly createdAt: number;
  readonly device: EmbeddingDevice;
  readonly dtype: EmbeddingDType;
  readonly lastUsedAt: number;
  readonly memory: EmbedWorkerPipelineCacheMemoryDiagnostic;
  readonly model: string;
  readonly residencyMs: number;
}

export interface EmbedWorkerPipelineCacheDiagnostic {
  readonly cacheSize: number;
  readonly diagnostic: 'pipeline-cache';
  readonly emittedAt: number;
  /** Full cache snapshot for non-hot-path events. */
  readonly entries?: readonly EmbedWorkerPipelineCacheEntryDiagnostic[];
  /** Subject pipeline for this diagnostic event. */
  readonly entry?: EmbedWorkerPipelineCacheEntryDiagnostic;
  readonly event: 'disposed' | 'evicted' | 'hit' | 'invalidated' | 'load-failed' | 'loaded';
  readonly id?: string;
  /** Event-specific reason emitted by the worker; invalid pairs are rejected at emit call sites. */
  readonly reason?:
    | 'device-lost'
    | 'idle-timeout'
    | 'load-failure'
    | 'manual-dispose'
    | 'resident-limit';
  readonly type: 'diagnostic';
}

export interface EmbedWorkerBatch {
  readonly batchIndex: number;
  readonly endIndex: number;
  readonly id: string;
  readonly startIndex: number;
  readonly type: 'batch';
  readonly vectors: readonly Float32Array[];
}

export interface EmbedWorkerSuccess {
  readonly id: string;
  readonly metadata: {
    readonly model: string;
    readonly device: EmbeddingDevice;
    readonly dtype: EmbeddingDType;
    readonly batchSize: number;
    readonly elapsedMs: number;
    readonly fallbackApplied: boolean;
    readonly dimensions: number;
  };
  readonly type: 'result';
  readonly vectors: readonly Float32Array[];
}

export interface EmbedWorkerError {
  readonly cause?: string | undefined;
  readonly id: string;
  readonly message: string;
  readonly type: 'error';
}

export interface EmbedWorkerComplete {
  readonly id: string;
  readonly metadata: EmbedWorkerSuccess['metadata'];
  readonly type: 'complete';
}

export type EmbedWorkerStreamEvent =
  | EmbedWorkerBatch
  | EmbedWorkerComplete
  | EmbedWorkerPipelineCacheDiagnostic
  | EmbedWorkerError
  | EmbedWorkerProgress;
