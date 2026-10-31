import { Schema } from 'effect';

/**
 * The write shapes a producer sends the indexer, defined once. The indexer's writer decodes
 * requests with these schemas, and producers compile against their types.
 */
export const nonblank = Schema.String.check(Schema.isPattern(/\S/u));
export const positive = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
export const nonnegative = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
export const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const chunkTypeSchema = Schema.Literals(['text', 'sentence', 'recursive']);
export const providedChunkSchema = Schema.Struct({
  chunkIndex: nonnegative,
  chunkSize: positive,
  chunkType: chunkTypeSchema,
  content: nonblank,
  contentHash: hash,
  endLine: positive,
  endOffset: nonnegative,
  startLine: positive,
  startOffset: nonnegative,
  tokenCount: positive,
});
export type IndexerProvidedChunk = typeof providedChunkSchema.Type;

export const symbolSchema = Schema.Struct({
  endLine: positive,
  endOffset: nonnegative,
  exported: Schema.Boolean,
  fileRecordId: nonblank,
  kind: Schema.Literals(['class', 'enum', 'function', 'interface', 'method', 'type', 'variable']),
  name: Schema.String,
  seq: nonnegative,
  startLine: positive,
  startOffset: nonnegative,
});
export const refSchema = Schema.Struct({
  fileRecordId: nonblank,
  fromSymbolSeq: Schema.optionalKey(nonnegative),
  kind: Schema.Literals(['call', 'extends', 'implements', 'import']),
  line: positive,
  module: Schema.optionalKey(Schema.String),
  name: Schema.String,
  seq: nonnegative,
});
export const syntaxSchema = Schema.Struct({
  refs: Schema.Array(refSchema),
  symbols: Schema.Array(symbolSchema),
});
export type IndexerFileSyntax = typeof syntaxSchema.Type;

export const manifestFileSchema = Schema.Struct({
  contentHash: hash,
  fileId: nonblank,
  relativePath: nonblank,
});
export type IndexerManifestFile = typeof manifestFileSchema.Type;
export const manifestRequestSchema = Schema.Struct({
  files: Schema.Array(manifestFileSchema),
  rootId: nonblank,
});
export type IndexerManifestRequest = typeof manifestRequestSchema.Type;

export const commitResultSchema = Schema.Struct({
  reusedEmbeddings: nonnegative,
  syntaxStatus: Schema.Literals(['replaced', 'retained', 'not-provided']),
  unchanged: Schema.Boolean,
  writtenChunks: nonnegative,
  writtenRefs: nonnegative,
  writtenSymbols: nonnegative,
});
export type IndexerCommitResult = typeof commitResultSchema.Type;
