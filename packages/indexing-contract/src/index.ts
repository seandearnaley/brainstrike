import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import type { EmbeddingPrompts } from './catalog-embedding-model.js';
import { buildEmbeddingInputHash } from './embedding-input-hash.js';
import type { EmbeddingDimensionParameter, EmbeddingPooling } from './embedding-worker-protocol.js';

export * from './catalog-embedding-model.js';
export * from './embedding-input-hash.js';
export * from './embedding-worker-protocol.js';

export type * from './local-execution.js';
export * from './onnx-wasm-paths.js';

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

/**
 * BST-423 — canonical chunking-settings invariants.
 *
 * These live here, in the contract package, because BOTH sides of the settings
 * flow already depend on it: the persisted store (`@brainstrike/app-state`)
 * and the settings UI (`@brainstrike/db-explorer`). They previously each
 * carried their own copy of the rules, and the copies disagreed — the store
 * turned a non-finite token limit into 512 via `Math.floor(n) || 512` (so a
 * literal 0 became 512 as well), while the UI used a separate
 * `Number.isFinite(n) ? clamp(n) : 512` expression. Neither enforced the
 * cross-field rule at all.
 *
 * NO SILENT NORMALIZATION: an impossible value is rejected and named. Clamping
 * an out-of-range value is what let a user's typed 5000 become a silent 2048,
 * and a pasted "abc" become a silent default.
 */
export interface ChunkingSettingBounds {
  readonly max: number;
  readonly min: number;
}

/** Matches the `min`/`max` the settings inputs advertise. */
export const CHUNK_SIZE_BOUNDS: ChunkingSettingBounds = { max: 2048, min: 128 };
export const CHUNK_OVERLAP_BOUNDS: ChunkingSettingBounds = { max: 256, min: 0 };
export const CHUNK_TOKEN_LIMIT_BOUNDS: ChunkingSettingBounds = { max: 16_384, min: 512 };

export type ChunkingSettingsField = 'chunkOverlap' | 'chunkSize' | 'chunkTokenLimit';

export type ChunkingSettingsIssueCode =
  | 'above-maximum'
  | 'below-minimum'
  | 'not-a-number'
  | 'not-an-integer'
  | 'overlap-not-less-than-size';

export interface ChunkingSettingsIssue {
  readonly code: ChunkingSettingsIssueCode;
  readonly field: ChunkingSettingsField;
  /** User-facing: rendered inline beneath the offending input. */
  readonly message: string;
}

export type ChunkingSettingFieldResult =
  | { readonly issue: ChunkingSettingsIssue; readonly ok: false }
  | { readonly ok: true; readonly value: number };

export interface ChunkingSettingsValues {
  readonly chunkOverlap: number;
  readonly chunkSize: number;
  readonly chunkTokenLimit: number;
}

export type ChunkingSettingsResult =
  | { readonly issues: readonly ChunkingSettingsIssue[]; readonly ok: false }
  | { readonly ok: true; readonly value: ChunkingSettingsValues };

const CHUNKING_FIELD_LABELS: Record<ChunkingSettingsField, string> = {
  chunkOverlap: 'Overlap',
  chunkSize: 'Chunk size',
  chunkTokenLimit: 'Token cap',
};

function validateChunkingField(
  field: ChunkingSettingsField,
  value: number,
  bounds: ChunkingSettingBounds
): ChunkingSettingFieldResult {
  const label = CHUNKING_FIELD_LABELS[field];
  const range = `between ${bounds.min} and ${bounds.max}`;
  const issue = (code: ChunkingSettingsIssueCode, message: string): ChunkingSettingFieldResult => ({
    issue: { code, field, message },
    ok: false,
  });

  // Number.isFinite rejects NaN and both infinities. `Number('')` is 0 and
  // `Number('abc')` is NaN, and both are reachable from a number input.
  if (!Number.isFinite(value)) {
    return issue('not-a-number', `${label} must be a number ${range}.`);
  }
  if (!Number.isInteger(value)) {
    return issue('not-an-integer', `${label} must be a whole number ${range}.`);
  }
  if (value < bounds.min) {
    return issue('below-minimum', `${label} must be at least ${bounds.min}.`);
  }
  if (value > bounds.max) {
    return issue('above-maximum', `${label} must be at most ${bounds.max}.`);
  }
  return { ok: true, value };
}

export function validateChunkSize(value: number): ChunkingSettingFieldResult {
  return validateChunkingField('chunkSize', value, CHUNK_SIZE_BOUNDS);
}

export function validateChunkOverlap(value: number): ChunkingSettingFieldResult {
  return validateChunkingField('chunkOverlap', value, CHUNK_OVERLAP_BOUNDS);
}

export function validateChunkTokenLimit(value: number): ChunkingSettingFieldResult {
  return validateChunkingField('chunkTokenLimit', value, CHUNK_TOKEN_LIMIT_BOUNDS);
}

/**
 * Whole-object validation. Reports EVERY failing field rather than short-
 * circuiting, so the settings form can mark all offending inputs in one pass.
 *
 * The cross-field rule (`chunkOverlap < chunkSize`) runs only when both fields
 * independently parsed: comparing against NaN would emit a nonsense second
 * issue and bury the real one.
 */
/**
 * The cross-field rule, owned here so every caller renders the SAME sentence.
 *
 * Review follow-up on #2086: this previously existed in three places — this
 * package, two hand-rolled literals in the settings panel, and a bare `Error`
 * in the store — which is the same drift-prone shape the field rules had just
 * escaped. The drift was already visible: the size-direction message said
 * "Overlap must be smaller than chunk size (64)" while the user was editing
 * the Chunk size input.
 *
 * `field` names the input the user is actually editing, so the message can
 * point at the other side of the pair.
 */
export function validateChunkOverlapAgainstSize(
  chunkOverlap: number,
  chunkSize: number,
  field: 'chunkOverlap' | 'chunkSize'
): ChunkingSettingFieldResult {
  if (chunkOverlap < chunkSize) {
    return { ok: true, value: field === 'chunkSize' ? chunkSize : chunkOverlap };
  }
  return {
    issue: {
      code: 'overlap-not-less-than-size',
      field,
      message:
        field === 'chunkSize'
          ? `Chunk size must be larger than the overlap (${chunkOverlap}).`
          : `Overlap must be smaller than chunk size (${chunkSize}).`,
    },
    ok: false,
  };
}

export function validateChunkingSettings(values: ChunkingSettingsValues): ChunkingSettingsResult {
  const size = validateChunkSize(values.chunkSize);
  const overlap = validateChunkOverlap(values.chunkOverlap);
  const tokenLimit = validateChunkTokenLimit(values.chunkTokenLimit);

  const issues = [size, overlap, tokenLimit].flatMap((result) => (result.ok ? [] : [result.issue]));

  if (size.ok && overlap.ok) {
    const pair = validateChunkOverlapAgainstSize(overlap.value, size.value, 'chunkOverlap');
    if (!pair.ok) {
      issues.push(pair.issue);
    }
  }

  if (issues.length > 0) {
    return { issues, ok: false };
  }
  return {
    ok: true,
    value: {
      chunkOverlap: values.chunkOverlap,
      chunkSize: values.chunkSize,
      chunkTokenLimit: values.chunkTokenLimit,
    },
  };
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
  enqueueBatch: (
    chunks: readonly IndexingEmbeddingJobChunk[],
    fileRecordId: string,
    options?: IndexingEmbeddingJobQueueBatchOptions<TTransaction>
  ) => Promise<void>;
  resetProgress?: () => void;
}

/** Stand-in segment for an embedding job that targets no specific set. */
const EMBED_JOB_DEDUPE_KEY_NO_SET = 'none';

/**
 * Build the dedupe key for an `embed_chunk` job.
 *
 * This is the ONE supported producer of `job_queue.dedupe_key` for embedding
 * jobs. It lives here, rather than in `@brainstrike/db` or
 * `@brainstrike/pipeline`, because both of those enqueue embedding jobs and the
 * key must be byte-identical across them — a second format silently defeats the
 * `idx_job_queue_dedupe_active` unique index and re-enqueues duplicates.
 *
 * Format: `{chunkId}:{embeddingSetId ?? 'none'}:{contentHash}`
 *
 * Content hash rather than model key is deliberate: re-embedding is driven by
 * chunk content changing, so a chunk whose content is unchanged dedupes against
 * its in-flight job. The corollary is that the model key does NOT separate jobs:
 * while a job for `chunk+set` is queued or running, re-enqueuing that chunk under
 * a different model dedupes into the existing job and the chunk is embedded with
 * the original model — `enqueue`/`enqueueBatch` only lower `run_at` and COALESCE
 * the identity columns, never rewriting the payload that carries `modelKey`. In
 * practice a model change means a new embedding set, so `embeddingSetId` differs
 * and the keys diverge anyway.
 *
 * The absence of a leading type tag is deliberate, not an oversight. All dedupe
 * keys — `file:`, `chunk:`, and these — share one namespace under the unique
 * partial index `idx_job_queue_dedupe_active(dedupe_key) WHERE state IN
 * ('queued','running')`. An untagged key can only collide with a tagged one if a
 * chunk id is literally `'file'` or `'chunk'`, which UUID chunk ids rule out.
 * The tag was dropped because the two live producers had already shipped this
 * shape, so adding one would have rewritten keys for every queued job.
 *
 * **Do not parse this key.** Splitting it positionally is not a supported way to
 * recover chunk or embedding-set identity — the segment layout is an internal
 * detail and a content hash is opaque. Read the first-class indexed columns
 * `job_queue.chunk_id` and `job_queue.embedding_set_id` instead (migrations 042
 * and 043 added them for exactly this reason). BST-1214: a debug query that used
 * `split_part(dedupe_key, ':', 1)` reported every failed embedding as merely
 * pending, because it was reading a key built by a different producer.
 *
 * @throws If any component is blank — a blank segment would collide across
 * otherwise distinct chunks, so it is refused rather than coerced. `null` and
 * `undefined` are the only accepted "no embedding set" signals; a blank string
 * is a caller bug, not a synonym for them.
 */
export function buildEmbedJobDedupeKey(
  chunkId: string,
  embeddingSetId: string | null | undefined,
  contentHash: string
): string {
  const normalizedChunkId = chunkId.trim();
  if (!normalizedChunkId) {
    throw new Error('Cannot build an embedding job dedupe key without a chunk id.');
  }

  const normalizedContentHash = contentHash.trim();
  if (!normalizedContentHash) {
    throw new Error('Cannot build an embedding job dedupe key without a content hash.');
  }

  if (embeddingSetId !== null && embeddingSetId !== undefined && !embeddingSetId.trim()) {
    throw new Error(
      'Cannot build an embedding job dedupe key from a blank embedding set id; pass null for no set.'
    );
  }
  const normalizedSetId = embeddingSetId?.trim() ?? EMBED_JOB_DEDUPE_KEY_NO_SET;

  return `${normalizedChunkId}:${normalizedSetId}:${normalizedContentHash}`;
}

export interface EmbeddingModelConfig {
  contextWindow?: number;
  description: string;
  dimensions: number;
  id: string;
  name: string;
  origin?: string;
  /** The catalog row's pooling (BST-1993); absent asks the worker for 'mean'. */
  pooling?: EmbeddingPooling;
  pricePer1MTokens?: number;
  /** The catalog row's query/document prompts (BST-1993); absent embeds raw text. */
  prompts?: EmbeddingPrompts;
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

/**
 * Keyless hosted runtimes. MIRROR-CONTRACT-TESTED (BST-1361): this package
 * cannot depend on `@brainstrike/assistant-contract`, so
 * `scripts/__tests__/provider-env-keys-mirror-contract.test.mjs` pins this
 * set to the registry's `authType: 'none'` hosted providers.
 */
const NO_API_KEY_HOSTED_PROVIDERS: ReadonlySet<HostedProviderType> = new Set([
  'ollama',
  'lmstudio',
]);

const EMBEDDING_PROVIDER_DEFINITIONS: readonly EmbeddingProviderDefinition[] = [
  {
    displayName: 'Local (Browser)',
    id: 'local',
    models: [],
    runtime: 'browser',
  },
  {
    displayName: 'Transformers.js',
    id: 'transformers',
    models: [],
    runtime: 'browser',
  },
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
    runtime: 'hosted',
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
    runtime: 'hosted',
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
    runtime: 'hosted',
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
    runtime: 'hosted',
  },
  {
    displayName: 'Ollama (Local Runtime)',
    id: 'ollama',
    models: [],
    runtime: 'hosted',
  },
  {
    displayName: 'LM Studio (Local Runtime)',
    id: 'lmstudio',
    models: [],
    runtime: 'hosted',
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
  const provider = parsed?.provider ?? providerHint ?? 'local';
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

/**
 * Build durable input hashes using the exact model identity the embedding
 * worker resolves from a queued job. The batch form deliberately computes
 * independent SHA-256 digests concurrently before a producer writes anything.
 */
export async function buildEmbeddingJobInputHashes(
  contentHashes: readonly string[],
  modelKey: string,
  providerHint?: EmbeddingProviderType | null
): Promise<string[]> {
  const parsed = parseEmbeddingProviderModelKey(modelKey);
  const resolvedModelKey = (() => {
    if (parsed) {
      return modelKey;
    }
    if (providerHint && isHostedProvider(providerHint)) {
      return formatEmbeddingProviderModelKey(providerHint, modelKey);
    }
    throw new Error(`Invalid modelKey for embedding job input hash: ${modelKey}`);
  })();

  return Promise.all(
    contentHashes.map((contentHash) => buildEmbeddingInputHash(contentHash, resolvedModelKey))
  );
}
