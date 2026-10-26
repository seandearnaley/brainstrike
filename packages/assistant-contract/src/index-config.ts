import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

/** Custom sizes stay inside the canonical chunker's 4096-token and 1024-overlap safety caps. */
export const CHUNK_SIZE_TOKENS = { maximum: 2048, minimum: 128 } as const;
export const CHUNK_OVERLAP_TOKENS = { maximum: 256, minimum: 0 } as const;
/** Off opens no index to re-chunk, so chunking changes only while search is on. */
export const INDEX_CHUNKING_OFF_MESSAGE = 'Turn search on before changing chunking.';

const IntBetween = (bounds: { readonly maximum: number; readonly minimum: number }) =>
  Schema.Int.check(Schema.isBetween(bounds));

/** Auto keeps the chunker's per-language sizes; Custom applies one size to every file type. */
export const IndexChunkingSchema = Schema.TaggedUnion({
  // biome-ignore lint/style/useNamingConvention: TaggedUnion keys are the persisted `_tag` values.
  Auto: {},
  // biome-ignore lint/style/useNamingConvention: TaggedUnion keys are the persisted `_tag` values.
  Custom: { maxTokens: IntBetween(CHUNK_SIZE_TOKENS), overlap: IntBetween(CHUNK_OVERLAP_TOKENS) },
});

/** An embedding model whose dimensions were verified. */
export const IndexModelSchema = Schema.Struct({
  dimensions: IntBetween({ maximum: 16_000, minimum: 1 }),
  modelKey: Schema.String.check(Schema.isPattern(/^[^:\s]+::\S+/)),
});

const fields = {
  chunking: IndexChunkingSchema,
  mode: Schema.Literals(['off', 'text', 'semantic']),
  model: Schema.NullOr(IndexModelSchema),
  paused: Schema.Boolean,
  policy: Schema.Literals(['balanced', 'full-root']),
  /** Worktree RootId → indexed. Workspace folders are always indexed. */
  worktrees: Schema.Record(Schema.String, Schema.Boolean),
};

/** One profile's search index: how it searches, with which model, over which files. */
export const IndexConfigSchema = Schema.Struct(fields).check(
  Schema.makeFilter(({ mode, model }) =>
    mode !== 'semantic' || model !== null
      ? undefined
      : { issue: 'Semantic search needs an embedding model', path: ['model'] }
  )
);

/** The fields one change sets; `worktrees` entries merge into the saved map. */
export const IndexConfigPatchSchema = Schema.Struct({
  chunking: Schema.optionalKey(fields.chunking),
  mode: Schema.optionalKey(fields.mode),
  model: Schema.optionalKey(fields.model),
  paused: Schema.optionalKey(fields.paused),
  policy: Schema.optionalKey(fields.policy),
  worktrees: Schema.optionalKey(fields.worktrees),
});

export type IndexChunking = typeof IndexChunkingSchema.Type;
export type IndexConfig = typeof IndexConfigSchema.Type;
export type IndexConfigPatch = typeof IndexConfigPatchSchema.Type;
export type IndexModel = typeof IndexModelSchema.Type;

/** A fresh profile: text search and automatic chunking. */
export const DEFAULT_INDEX_CONFIG: IndexConfig = {
  chunking: { _tag: 'Auto' },
  mode: 'text',
  model: null,
  paused: false,
  policy: 'balanced',
  worktrees: {},
};

export const decodeIndexConfig = makeThrowingDecoder(IndexConfigSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});

/**
 * The refusal code of a saved config this version cannot read (one saved before a field or
 * model was removed): Reset search settings replaces it with the defaults.
 */
export const INDEX_CONFIG_UNREADABLE = 'index-config.unreadable';
export const INDEX_CONFIG_RESET_REMEDY = 'Reset search settings in Settings → Search & Indexing.';

export const sameIndexChunking = Schema.toEquivalence(IndexChunkingSchema);
export const sameIndexModel = Schema.toEquivalence(IndexModelSchema);

/** `provider::modelId` → `modelId`. */
export function indexModelId(model: Pick<IndexModel, 'modelKey'>): string {
  const separator = model.modelKey.indexOf('::');
  if (separator === -1) {
    throw new Error(`Embedding model key "${model.modelKey}" names no provider.`);
  }
  return model.modelKey.slice(separator + 2);
}

/**
 * The profile's index config as Main owns it. `updateConfig` takes `unknown` because preload
 * contracts stay Effect-free: Main decodes the change with `IndexConfigPatchSchema`.
 */
export interface IndexConfigCapability {
  onConfigChanged(listener: (config: IndexConfig) => void): () => void;
  readConfig(): Promise<IndexConfig>;
  /** Saves the defaults in place of a saved config that cannot be read, then rebuilds the index. */
  resetConfig(): Promise<IndexConfig>;
  updateConfig(patch: unknown): Promise<IndexConfig>;
}
