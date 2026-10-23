import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

/** Custom sizes stay inside the canonical chunker's 4096-token and 1024-overlap safety caps. */
export const CHUNK_SIZE_TOKENS = { maximum: 2048, minimum: 128 } as const;
export const CHUNK_OVERLAP_TOKENS = { maximum: 256, minimum: 0 } as const;

const Tokens = (bounds: { readonly maximum: number; readonly minimum: number }) =>
  Schema.Int.check(Schema.isBetween(bounds));
const Text = Schema.String.check(Schema.isPattern(/\S/));

/** Auto keeps the chunker's per-language sizes; Custom applies one size to every file type. */
export const IndexChunkingSchema = Schema.TaggedUnion({
  // biome-ignore lint/style/useNamingConvention: TaggedUnion keys are the persisted `_tag` values.
  Auto: {},
  // biome-ignore lint/style/useNamingConvention: TaggedUnion keys are the persisted `_tag` values.
  Custom: { maxTokens: Tokens(CHUNK_SIZE_TOKENS), overlap: Tokens(CHUNK_OVERLAP_TOKENS) },
});

/** An embedding model whose dimensions were verified; `local` is how an on-device model runs. */
export const IndexModelSchema = Schema.Struct({
  dimensions: Tokens({ maximum: 16_000, minimum: 1 }),
  local: Schema.NullOr(
    Schema.Struct({
      device: Schema.Literals(['webgpu', 'wasm']),
      dtype: Text,
      revision: Schema.optionalKey(Text),
    })
  ),
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

/** A fresh profile: text search and automatic chunking, with nothing to download. */
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

export const sameIndexChunking = Schema.toEquivalence(IndexChunkingSchema);

/** `provider::modelId` → `modelId`. */
export function indexModelId(model: Pick<IndexModel, 'modelKey'>): string {
  return model.modelKey.slice(model.modelKey.indexOf('::') + 2);
}

/** Structurally the indexing contract's `NativeLocalSelection`. */
export interface IndexLocalSelection {
  readonly device: 'webgpu' | 'wasm';
  readonly dimensions: number;
  readonly dtype: string;
  readonly modelId: string;
  readonly revision?: string;
}

/** The on-device execution the index runs a local model with; null for a hosted model. */
export function indexModelLocalSelection(model: IndexModel): IndexLocalSelection | null {
  if (model.local === null) {
    return null;
  }
  return {
    device: model.local.device,
    dimensions: model.dimensions,
    dtype: model.local.dtype,
    modelId: indexModelId(model),
    ...(model.local.revision === undefined ? {} : { revision: model.local.revision }),
  };
}

/**
 * The profile's index config as Main owns it. `updateConfig` takes `unknown` because preload
 * contracts stay Effect-free: Main decodes the change with `IndexConfigPatchSchema`.
 */
export interface IndexConfigCapability {
  onConfigChanged(listener: (config: IndexConfig) => void): () => void;
  readConfig(): Promise<IndexConfig>;
  updateConfig(patch: unknown): Promise<IndexConfig>;
}
