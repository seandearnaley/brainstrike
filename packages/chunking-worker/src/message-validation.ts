import { isChunkingStrategy } from '@brainstrike/text-splitter';
import { Schema } from 'effect';
import { CHUNKING_CONFIG } from './chunking-config';
import type { ChunkBatchRequest, ChunkingRequestOptions, ChunkRequest } from './shared';

/**
 * Worker message schemas (docs/agents/effect-boundary.md § "Schema at
 * boundaries"). They keep the worker's historical leniency on purpose: extra
 * keys pass, an optional key present as `undefined` passes, and `content` is
 * only required to be a string. Size handling stays in the worker runtime so
 * an oversized file becomes a per-file skip or error, never a terminal
 * `__init__` failure that poisons the whole worker session.
 */
const boundedInt = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum));

const metadataString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(CHUNKING_CONFIG.maxMetadataFieldLength)
);

/**
 * The strategy set is owned by @brainstrike/text-splitter; if it changes,
 * update that source of truth instead of widening this validator locally.
 */
const chunkingStrategy = Schema.declare(isChunkingStrategy);

const chunkingRequestOptions = Schema.Struct({
  allowLargeFiles: Schema.optional(Schema.Boolean),
  forceStrategy: Schema.optional(Schema.Boolean),
  ignoreFileTypeRecommendations: Schema.optional(Schema.Boolean),
  maxTokens: Schema.optional(boundedInt(1, CHUNKING_CONFIG.maxTokensHardLimit)),
  maxTokensCap: Schema.optional(boundedInt(1, CHUNKING_CONFIG.maxTokensHardLimit)),
  overlap: Schema.optional(boundedInt(0, CHUNKING_CONFIG.overlapHardLimit)),
  separators: Schema.optional(
    Schema.Array(Schema.String).check(Schema.isMaxLength(CHUNKING_CONFIG.maxSeparatorsCount))
  ),
  strategy: chunkingStrategy,
  tokenTrueSizing: Schema.optional(Schema.Boolean),
});

const chunkRequestFields = {
  content: Schema.String,
  fileName: metadataString,
  filePath: metadataString,
  fileRecordId: metadataString,
  id: metadataString,
  options: chunkingRequestOptions,
};

const chunkRequest = Schema.Struct({ ...chunkRequestFields, type: Schema.Literal('chunk') });

const chunkBatchRequest = Schema.Struct({
  requests: Schema.Array(Schema.Struct(chunkRequestFields)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CHUNKING_CONFIG.maxBatchSize)
  ),
  type: Schema.Literal('chunk-batch'),
});

/** Maps every key of `Interface` that the schema does not declare to `never`. */
type UndeclaredKeys<Interface, Declared> = {
  readonly [K in Exclude<keyof Interface, keyof Declared>]: never;
};

/**
 * The schema type without `readonly`. Structured clone delivers fresh mutable
 * values, so readonly-ness is the one difference the drift check ignores.
 */
type Writable<T> = T extends readonly (infer Item)[]
  ? Writable<Item>[]
  : T extends object
    ? { -readonly [K in keyof T]: Writable<T[K]> }
    : T;

/**
 * A type guard for `schema` that narrows to the hand-written message
 * interface. The type parameters are the drift check, in both directions: the
 * interface must fit the schema's type, the schema's type (readonly aside) must
 * fit the interface, and the interface may not declare a top-level key the
 * schema lacks, even an optional one. A field added to only one side, typed
 * differently on each, or narrowed on the interface alone (an optional field
 * made required, a union member dropped, `| undefined` removed from a field the
 * schema accepts as `undefined`) stops this module compiling.
 */
const guardFor = <S extends Schema.Top>(schema: S) => {
  const matches = Schema.is(schema);
  return <Interface extends S['Type'] & UndeclaredKeys<Interface, S['Type']>>(
    ..._exact: [Writable<S['Type']>] extends [Interface] ? [] : [never]
  ) =>
    (value: unknown): value is Interface =>
      matches(value);
};

const matchesOptions = guardFor(chunkingRequestOptions)<ChunkingRequestOptions>();
const matchesRequest = guardFor(chunkRequest)<ChunkRequest>();
const matchesBatch = guardFor(chunkBatchRequest)<ChunkBatchRequest>();

export function isChunkingRequestOptions(value: unknown): value is ChunkingRequestOptions {
  return matchesOptions(value);
}

export function isChunkRequest(value: unknown): value is ChunkRequest {
  return matchesRequest(value);
}

export function isChunkBatchRequest(value: unknown): value is ChunkBatchRequest {
  return matchesBatch(value);
}
