import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';

export * from './embedding-input-hash.ts';

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
    adaptiveRouting: true,
    bestFor: ['mixed repos', 'teams starting out', 'general retrieval'],
    chunkOverlap: 50,
    chunkSize: 256,
    description: 'General-purpose defaults that auto-detect the best splitter for most files.',
    id: 'balanced',
    isDefault: true,
    label: 'Balanced',
    strategy: 'auto',
    tokenLimit: 4096,
    tradeoff: 'Not as aggressive as specialist presets for code-only or schema-heavy corpora.',
  },
  {
    adaptiveRouting: true,
    bestFor: ['monorepos', 'product docs + code', 'engineering assistants'],
    chunkOverlap: 40,
    chunkSize: 224,
    description:
      'Adaptive mixed-repo preset: code stays tight while docs and data keep their own structure.',
    id: 'codebase',
    label: 'Codebase',
    strategy: 'auto',
    tokenLimit: 3072,
    tradeoff: 'More conservative chunk sizing can increase chunk count on very large repos.',
  },
  {
    adaptiveRouting: false,
    bestFor: ['source-only repos', 'symbol retrieval', 'diff-aware assistants'],
    chunkOverlap: 40,
    chunkSize: 192,
    description:
      'Forces recursive code-centric chunking for source-only corpora where locality matters most.',
    id: 'strict-code',
    label: 'Strict Code',
    strategy: 'recursive',
    tokenLimit: 3072,
    tradeoff: 'Will over-treat docs and schemas as code if you point it at a mixed corpus.',
  },
  {
    adaptiveRouting: false,
    bestFor: ['handbooks', 'runbooks', 'README sets'],
    chunkOverlap: 56,
    chunkSize: 320,
    description: 'Prefers semantic markdown grouping for guides, notes, and README-heavy content.',
    id: 'docs',
    label: 'Docs',
    strategy: 'semantic-markdown',
    tokenLimit: 4096,
    tradeoff: 'Non-markdown files won’t benefit from the heading-family bias.',
  },
  {
    adaptiveRouting: false,
    bestFor: ['API docs', 'SDK references', 'parameter lookups'],
    chunkOverlap: 32,
    chunkSize: 192,
    description: 'Smaller, denser chunks for reference docs where precision matters.',
    id: 'api-reference',
    label: 'API Reference',
    strategy: 'markdown',
    tokenLimit: 3072,
    tradeoff: 'Can fragment long-form guides more than general-purpose presets.',
  },
  {
    adaptiveRouting: false,
    bestFor: ['JSON payloads', 'schemas', 'machine-readable docs'],
    chunkOverlap: 64,
    chunkSize: 384,
    description: 'Structure-aware splitting for JSON-like payloads and schema-heavy content.',
    id: 'structured-data',
    label: 'Structured Data',
    strategy: 'json',
    tokenLimit: 6144,
    tradeoff: 'Less effective for prose-heavy files that only happen to live near structured data.',
  },
  {
    adaptiveRouting: false,
    bestFor: ['large-context models', 'broad semantic recall', 'fewer chunk boundaries'],
    chunkOverlap: 64,
    chunkSize: 512,
    description: 'Fewer, larger chunks when downstream models can tolerate bigger payloads.',
    id: 'large-context',
    label: 'Large Context',
    strategy: 'token',
    tokenLimit: 8192,
    tradeoff: 'Bigger chunks can reduce precision for exact retrieval and reranking.',
  },
] as const;

const ROUTE_PREVIEW_CANDIDATES: readonly Omit<ChunkingRoutePreview, 'resolvedStrategy'>[] = [
  {
    fileName: 'src/assistant/retrieval.ts',
    label: 'Code module',
    reason: 'Keeps symbols and local control flow together for code retrieval.',
  },
  {
    fileName: 'docs/getting-started.md',
    label: 'Guide / handbook',
    reason: 'Preserves heading families so sections stay coherent in retrieval.',
  },
  {
    fileName: 'schemas/search-response.json',
    label: 'Structured payload',
    reason: 'Favors object and array boundaries instead of sentence splits.',
  },
  {
    fileName: 'public/reference/index.html',
    label: 'Markup page',
    reason: 'Uses block and tag boundaries so markup stays readable in context.',
  },
  {
    fileName: 'notes/retrieval-paper.tex',
    label: 'Research paper',
    reason: 'Prefers section and environment boundaries for long technical writing.',
  },
  {
    fileName: 'notes/retro.txt',
    label: 'Plain notes',
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

export type EmbeddingProviderType = 'openai' | 'google' | 'cohere' | 'voyage';

export type DistanceMetric = 'cosine' | 'l2' | 'ip';

export type EmbeddingDimensionParameter =
  | 'dimensions'
  | 'output_dimensionality'
  | 'output_dimension';

export interface EmbeddingModelConfig {
  contextWindow?: number;
  description: string;
  dimensions: number;
  id: string;
  name: string;
  origin?: string;
  pricePer1MTokens?: number;
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
}

export interface ParsedEmbeddingProviderModel {
  modelId: string;
  provider: EmbeddingProviderType;
}

const PROVIDER_SEPARATOR = '::';
const LEGACY_PROVIDER_SEPARATOR = ':';

const EMBEDDING_PROVIDER_DEFINITIONS: readonly EmbeddingProviderDefinition[] = [
  {
    displayName: 'OpenAI',
    // MIRROR-CONTRACT-TESTED (BST-1361): every envKeys list below must equal
    // the assistant-contract provider registry's canonical two names
    // (BRAINSTRIKE_* override first, vendor-standard second) — pinned by
    // scripts/__tests__/provider-env-keys-mirror-contract.test.mjs because
    // this package's dependency floor forbids importing the registry.
    envKeys: ['BRAINSTRIKE_OPENAI_API_KEY', 'OPENAI_API_KEY'],
    id: 'openai',
    models: [
      {
        default: true,
        defaultDimension: 1536,
        dimensionParameter: 'dimensions',
        id: 'text-embedding-3-small',
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        type: 'embedding',
      },
      {
        defaultDimension: 3072,
        dimensionParameter: 'dimensions',
        id: 'text-embedding-3-large',
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        type: 'embedding',
      },
    ],
  },
  {
    displayName: 'Google AI Studio',
    envKeys: ['BRAINSTRIKE_GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    id: 'google',
    models: [
      {
        default: true,
        defaultDimension: 3072,
        dimensionParameter: 'output_dimensionality',
        id: 'gemini-embedding-001',
        supportsCustomDimensions: true,
        supportsStandardDimension: true,
        type: 'embedding',
      },
    ],
  },
  {
    displayName: 'Cohere',
    envKeys: ['BRAINSTRIKE_COHERE_API_KEY', 'COHERE_API_KEY'],
    id: 'cohere',
    models: [
      {
        availableDimensions: [1024],
        default: true,
        defaultDimension: 1024,
        id: 'embed-english-v3.0',
        supportsStandardDimension: true,
        type: 'embedding',
      },
      {
        availableDimensions: [1024],
        defaultDimension: 1024,
        id: 'embed-multilingual-v3.0',
        supportsStandardDimension: true,
        type: 'embedding',
      },
    ],
  },
  {
    displayName: 'Voyage AI',
    envKeys: ['BRAINSTRIKE_VOYAGE_API_KEY', 'VOYAGE_API_KEY'],
    id: 'voyage',
    models: [
      {
        availableDimensions: [1024],
        default: true,
        defaultDimension: 1024,
        id: 'voyage-3',
        supportsStandardDimension: true,
        type: 'embedding',
      },
      {
        availableDimensions: [512],
        defaultDimension: 512,
        id: 'voyage-3-lite',
        supportsStandardDimension: false,
        type: 'embedding',
      },
    ],
  },
];

const EMBEDDING_PROVIDER_BY_ID = Object.fromEntries(
  EMBEDDING_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
) as Record<EmbeddingProviderType, EmbeddingProviderDefinition>;

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
      modelId,
      provider: provider as EmbeddingProviderType,
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
      modelId,
      provider: provider as EmbeddingProviderType,
    };
  }

  return null;
}

export function canonicalizeEmbeddingProviderModelKey(
  modelKey: string | null | undefined,
  providerHint?: EmbeddingProviderType
): { provider: EmbeddingProviderType; modelId: string; composite: string } | null {
  const parsed = parseEmbeddingProviderModelKey(modelKey);
  const provider = parsed?.provider ?? providerHint;
  if (!provider) {
    return null;
  }
  const rawModelId = parsed?.modelId ?? modelKey?.trim() ?? '';
  if (!rawModelId) {
    return null;
  }
  return {
    composite: formatEmbeddingProviderModelKey(provider, rawModelId),
    modelId: rawModelId,
    provider,
  };
}
