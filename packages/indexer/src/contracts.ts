import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

const nonblank = Schema.String.check(Schema.isPattern(/\S/u));
const positive = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const nonnegative = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const profileSchema = Schema.Struct({
  dimensions: positive,
  dtype: Schema.Literals(['q8', 'fp16', 'fp32']),
  modelId: nonblank,
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  tokenCap: positive,
});
export type EmbeddingProfile = typeof profileSchema.Type;
export const optionsSchema = Schema.Struct({
  dbPath: nonblank,
  profile: profileSchema,
  rootIds: Schema.Array(nonblank),
});
export type IndexerOptions = typeof optionsSchema.Type;
const snapshotFields = {
  content: Schema.String,
  fileId: nonblank,
  relativePath: nonblank,
  rootId: nonblank,
};
const producerFields = {
  chunkIndex: nonnegative,
  chunkSize: positive,
  chunkType: Schema.Literals(['text', 'sentence', 'recursive']),
  endOffset: nonnegative,
  startOffset: nonnegative,
  tokenCount: positive,
};
export const providedChunkSchema = Schema.Struct({
  ...producerFields,
  content: nonblank,
  contentHash: hash,
  endLine: positive,
  startLine: positive,
});
export type ProvidedChunk = typeof providedChunkSchema.Type;
export const providedSnapshotSchema = Schema.Struct({
  ...snapshotFields,
  providedChunks: Schema.Array(providedChunkSchema),
});
export type ProvidedFileSnapshot = typeof providedSnapshotSchema.Type;
export const snapshotSchema = Schema.Union([
  Schema.Struct({ ...snapshotFields, chunkLines: positive }),
  providedSnapshotSchema,
]);
export type FileSnapshot = typeof snapshotSchema.Type;
const chunkMetadata = {
  chunkIndex: Schema.NullOr(nonnegative),
  chunkSize: Schema.NullOr(positive),
  chunkType: Schema.NullOr(producerFields.chunkType),
  endOffset: Schema.NullOr(nonnegative),
  startOffset: Schema.NullOr(nonnegative),
  tokenCount: Schema.NullOr(positive),
};
export const chunkSchema = Schema.Struct({
  ...chunkMetadata,
  chunkId: hash,
  content: Schema.String,
  contentHash: hash,
  embeddingHash: hash,
  endLine: positive,
  startLine: positive,
});
export type FileChunk = typeof chunkSchema.Type;
export const planSchema = Schema.Struct({
  chunks: Schema.Array(chunkSchema),
  contentHash: hash,
  embeddingChunkIds: Schema.Array(hash),
  previousSnapshotHash: Schema.NullOr(hash),
  profileHash: hash,
  snapshot: snapshotSchema,
  unchanged: Schema.Boolean,
});
export type FilePlan = typeof planSchema.Type;
export const vectorSchema = Schema.Array(Schema.Finite).check(Schema.isBetweenLength(384, 384));
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
  fromSymbolSeq: Schema.optional(nonnegative),
  kind: Schema.Literals(['call', 'extends', 'implements', 'import']),
  line: positive,
  module: Schema.optional(Schema.String),
  name: Schema.String,
  seq: nonnegative,
});
export const syntaxSchema = Schema.Struct({
  refs: Schema.Array(refSchema),
  symbols: Schema.Array(symbolSchema),
});
export type FileSyntax = typeof syntaxSchema.Type;
export const commitSchema = Schema.Struct({
  embeddings: Schema.Array(Schema.Struct({ chunkId: hash, vector: vectorSchema })),
  plan: planSchema,
  profile: profileSchema,
  syntax: Schema.optional(syntaxSchema),
});
export type FileCommit = typeof commitSchema.Type;
export const identitySchema = Schema.Struct({ fileId: nonblank, rootId: nonblank });
export const searchSchema = Schema.Struct({
  limit: positive.check(Schema.isLessThanOrEqualTo(100)),
  mode: Schema.Literals(['bm25', 'trigram', 'vector']),
  profile: Schema.optional(profileSchema),
  rootIds: Schema.Array(nonblank),
  text: Schema.optional(Schema.String),
  vector: Schema.optional(vectorSchema),
});
export type SearchRequest = typeof searchSchema.Type;
export const hitSchema = Schema.Struct({
  ...chunkMetadata,
  chunkId: hash,
  content: Schema.String,
  contentHash: hash,
  endLine: positive,
  fileId: nonblank,
  relativePath: nonblank,
  rootId: nonblank,
  score: Schema.Finite,
  startLine: positive,
});
export const searchResultSchema = Schema.Struct({
  candidateCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hits: Schema.Array(hitSchema),
  profileHash: hash,
});
export type SearchResult = typeof searchResultSchema.Type;
export const commitResultSchema = Schema.Struct({
  reusedEmbeddings: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  syntaxStatus: Schema.Literals(['replaced', 'retained', 'not-provided']),
  unchanged: Schema.Boolean,
  writtenChunks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  writtenRefs: nonnegative,
  writtenSymbols: nonnegative,
});
export type CommitResult = typeof commitResultSchema.Type;
export const infoSchema = Schema.Struct({
  dbPath: nonblank,
  journalMode: Schema.String,
  pid: positive,
  profileHash: hash,
  readerQueryOnly: Schema.Int,
  vecVersion: Schema.String,
  writerThreadId: positive,
});
export type IndexerInfo = typeof infoSchema.Type;
export const faultSchema = Schema.Struct({ code: nonblank, message: Schema.String });
export const requestSchema = Schema.Struct({ id: positive, op: nonblank, payload: Schema.Unknown });
export const frameSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('ready'), value: Schema.Unknown }),
  Schema.Struct({ error: faultSchema, kind: Schema.Literal('startup-error') }),
  Schema.Struct({
    id: positive,
    kind: Schema.Literal('response'),
    ok: Schema.Literal(true),
    value: Schema.Unknown,
  }),
  Schema.Struct({
    error: faultSchema,
    id: positive,
    kind: Schema.Literal('response'),
    ok: Schema.Literal(false),
  }),
]);
export function decoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): (input: unknown) => S['Type'] {
  return makeThrowingDecoder(schema, { onExcessProperty: 'error' });
}
export class IndexerError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'IndexerError';
  }
}
export function fault(error: unknown): typeof faultSchema.Type {
  return {
    code:
      error instanceof IndexerError
        ? error.code
        : error instanceof TypeError
          ? 'invalid-input'
          : 'indexer-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}
export function authorize(allowed: ReadonlySet<string>, rootIds: readonly string[]): void {
  for (const rootId of rootIds) {
    if (!allowed.has(rootId)) {
      throw new IndexerError(
        'root-not-authorized',
        `Root ${rootId} is not authorized by this indexer host.`
      );
    }
  }
}
