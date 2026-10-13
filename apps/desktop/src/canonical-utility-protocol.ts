import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import type {
  ScopedCoverage,
  ScopedFilePlan,
  ScopedManifestFile,
  ScopedManifestResult,
  VectorProfile,
} from '@brainstrike/indexer';
import { isChunkingStrategy } from '@brainstrike/text-splitter';
import { Schema } from 'effect';

export const CANONICAL_CHANNEL = 'canonical-ingestion-v1';
export const MAX_CANONICAL_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_CANONICAL_PENDING = 64;
export const positive = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
export const nonnegative = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
export const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(/\S/u)
);
export const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const scopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('workspace'), rootId: identifier }),
  Schema.Struct({ embeddingSetId: identifier, kind: Schema.Literal('collection') }),
]);
export const statSchema = Schema.Struct({
  mtimeMs: Schema.NullOr(Schema.Finite),
  size: nonnegative,
});
export const identitySchema = Schema.Struct({
  embeddingSetId: Schema.NullOr(identifier),
  fileId: identifier,
  fileName: identifier,
  relativePath: Schema.NullOr(identifier),
  rootId: Schema.NullOr(identifier),
  sourcePath: Schema.NullOr(identifier),
});
export const sourceFileSchema = Schema.Struct({ ...identitySchema.fields, stat: statSchema });
export const manifestSchema = Schema.Struct({ ...identitySchema.fields, contentHash: hash });
export const catalogFileSchema = Schema.Struct({
  ...sourceFileSchema.fields,
  chunksProcessed: Schema.Boolean,
  contentHash: Schema.NullOr(hash),
});
export const ticketSchema = Schema.Struct({
  generation: positive,
  requestId: identifier,
  scope: scopeSchema,
  storeId: identifier,
});
export const receiptSchema = Schema.Struct({
  excluded: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        fileId: Schema.NullOr(identifier),
        reason: Schema.Literals(['null-byte-content', 'binary-content']),
        relativePath: Schema.NullOr(identifier),
        rootId: Schema.NullOr(identifier),
      })
    )
  ),
  reason: Schema.Literals([
    'complete',
    'partial',
    'aborted',
    'scan-errors',
    'truncated',
    'write-failed',
    'manifest-mismatch',
  ]),
  scanComplete: Schema.Boolean,
  ticket: ticketSchema,
});
export const manifestResultSchema = Schema.Struct({
  changed: Schema.Array(manifestSchema),
  complete: Schema.Boolean,
  missing: Schema.Array(manifestSchema),
  storeId: identifier,
  unexpected: Schema.Array(manifestSchema),
});
export const readSchema = Schema.Struct({ content: Schema.String, stat: statSchema });
export const listSchema = Schema.NullOr(
  Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({
        isDirectory: Schema.Boolean,
        isFile: Schema.Boolean,
        isSymbolicLink: Schema.Boolean,
        lastModified: Schema.optionalKey(Schema.Finite),
        name: identifier,
        size: Schema.optionalKey(nonnegative),
      })
    ),
    inspected: nonnegative,
    truncated: Schema.Boolean,
  })
);
export const fileReadSchema = Schema.Union([
  Schema.Struct({ content: Schema.String, status: Schema.Literal('ok') }),
  Schema.Struct({ status: Schema.Literals(['not-found', 'oversized', 'unreadable']) }),
]);
export const changesSchema = Schema.Array(
  Schema.Struct({
    kind: Schema.Literals(['file', 'directory']),
    path: identifier,
    type: Schema.Literals(['added', 'removed', 'modified']),
  })
);
export const watchBatchSchema = Schema.Struct({
  changes: changesSchema,
  metadata: Schema.optionalKey(
    Schema.Struct({
      filteredChangeBoundaries: Schema.Array(identifier),
      filteredChangeBoundariesOverflow: Schema.optionalKey(Schema.Literal(true)),
    })
  ),
});
export const watchSignalSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('overflow') }),
  Schema.Struct({ message: Schema.String, type: Schema.Literal('errored') }),
]);
export const healthSchema = Schema.Struct({
  backend: Schema.Literals(['fs-events', 'inotify', 'windows']),
  failure: Schema.optionalKey(
    Schema.Struct({
      code: identifier,
      message: Schema.String,
      retryable: Schema.Boolean,
      terminal: Schema.Boolean,
    })
  ),
  state: Schema.Literals(['starting', 'healthy', 'degraded', 'failed', 'stopped']),
  timestamp: Schema.Finite,
});
export const configSchema = Schema.Struct({
  indexingPolicyPreset: Schema.Literals(['balanced', 'full-root']),
  lease: Schema.NullOr(
    Schema.Struct({ canonicalPath: identifier, generation: identifier, rootId: identifier })
  ),
  // Null only for a workspace in the TEXT partition (BST-1988); a collection names itself.
  managedCollectionId: Schema.NullOr(identifier),
  mode: Schema.Literals(['TEXT', 'VECTOR']),
  parser: Schema.Struct({ parser: Schema.Literals(['oxc', 'babel']) }),
  request: Schema.Struct({
    batchSize: positive.check(Schema.isLessThanOrEqualTo(64)),
    chunkingOptions: Schema.Struct({
      allowLargeFiles: Schema.optional(Schema.Boolean),
      forceStrategy: Schema.optional(Schema.Boolean),
      ignoreFileTypeRecommendations: Schema.optional(Schema.Boolean),
      maxTokens: Schema.optional(positive),
      maxTokensCap: Schema.optional(positive),
      overlap: Schema.optional(nonnegative),
      separators: Schema.optional(Schema.Array(Schema.String)),
      strategy: Schema.declare(isChunkingStrategy),
      tokenTrueSizing: Schema.optional(Schema.Boolean),
    }),
    maxFileBytes: positive.check(Schema.isLessThanOrEqualTo(16 * 1024 * 1024)),
  }),
  scope: scopeSchema,
});
export type CanonicalUtilityConfig = typeof configSchema.Type;
const batch = Schema.Struct({ files: Schema.Array(identitySchema), scope: scopeSchema });
const discoveredSchema = Schema.Struct({
  fileName: identifier,
  relativePath: identifier,
  rootId: identifier,
  sourcePath: identifier,
  stat: statSchema,
});
const chunkSchema = Schema.Struct({
  chunkIndex: nonnegative,
  chunkSize: positive,
  chunkType: Schema.Literals(['text', 'sentence', 'recursive']),
  content: Schema.String,
  contentHash: hash,
  endLine: positive,
  endOffset: nonnegative,
  startLine: positive,
  startOffset: nonnegative,
  tokenCount: nonnegative,
});
const syntaxSchema = Schema.Struct({
  refs: Schema.Array(
    Schema.Struct({
      fileRecordId: identifier,
      fromSymbolSeq: Schema.optionalKey(nonnegative),
      kind: Schema.Literals(['call', 'extends', 'implements', 'import']),
      line: positive,
      module: Schema.optionalKey(Schema.String),
      name: identifier,
      seq: nonnegative,
    })
  ),
  symbols: Schema.Array(
    Schema.Struct({
      endLine: positive,
      endOffset: nonnegative,
      exported: Schema.Boolean,
      fileRecordId: identifier,
      kind: Schema.Literals([
        'class',
        'enum',
        'function',
        'interface',
        'method',
        'type',
        'variable',
      ]),
      name: identifier,
      seq: nonnegative,
      startLine: positive,
      startOffset: nonnegative,
    })
  ),
});
const profileFields = {
  dimensions: positive.check(Schema.isLessThanOrEqualTo(16_000)),
  distance: Schema.Literals(['cosine', 'l2', 'ip']),
  modelId: identifier,
};
export const vectorProfileSchema: Schema.Codec<VectorProfile> = Schema.Union([
  Schema.Struct({
    ...profileFields,
    dtype: Schema.Literals(['q4', 'q8', 'fp16', 'fp32']),
    provider: Schema.Literals(['local', 'transformers']),
    revision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))),
    tokenCap: Schema.optional(positive),
  }),
  Schema.Struct({
    ...profileFields,
    provider: Schema.Literals(['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio']),
  }),
]);
const bindingFields = {
  embeddingSetId: Schema.NullOr(identifier),
  fileId: identifier,
  relativePath: Schema.NullOr(identifier),
  rootId: Schema.NullOr(identifier),
  sourcePath: Schema.NullOr(identifier),
};
const payloadSchema = Schema.Struct({
  content: Schema.String,
  fileId: identifier,
  providedChunks: Schema.Array(chunkSchema),
  syntax: Schema.optionalKey(syntaxSchema),
});
const chunkMetadata = {
  chunkIndex: Schema.NullOr(nonnegative),
  chunkSize: Schema.NullOr(positive),
  chunkType: Schema.NullOr(chunkSchema.fields.chunkType),
  endOffset: Schema.NullOr(nonnegative),
  startOffset: Schema.NullOr(nonnegative),
  tokenCount: Schema.NullOr(positive),
};
const nativeChunkSchema = Schema.Struct({
  ...chunkMetadata,
  chunkId: hash,
  content: Schema.String,
  contentHash: hash,
  embeddingHash: Schema.NullOr(hash),
  endLine: positive,
  startLine: positive,
});
const proofFields = { authorityEpoch: hash, authorityRevision: nonnegative, storeId: hash };
export const scopedPlanSchema: Schema.Codec<ScopedFilePlan> = Schema.Struct({
  ...proofFields,
  chunks: Schema.Array(nativeChunkSchema),
  contentHash: hash,
  embeddingChunkIds: Schema.Array(hash),
  previousSnapshotHash: Schema.NullOr(hash),
  profile: Schema.NullOr(vectorProfileSchema),
  profileHash: Schema.NullOr(hash),
  snapshot: Schema.Union([
    Schema.Struct({ ...bindingFields, chunkLines: positive, content: Schema.String }),
    Schema.Struct({
      ...bindingFields,
      content: Schema.String,
      providedChunks: Schema.Array(chunkSchema),
    }),
  ]),
});
const scopedManifestFileSchema: Schema.Codec<ScopedManifestFile> = Schema.Struct({
  ...bindingFields,
  chunks: Schema.Array(
    Schema.Struct({
      ...chunkMetadata,
      chunkId: hash,
      contentHash: hash,
      endLine: positive,
      startLine: positive,
    })
  ),
  contentHash: hash,
});
const scopedManifestResultSchema: Schema.Codec<ScopedManifestResult> = Schema.Struct({
  ...proofFields,
  changed: Schema.Array(scopedManifestFileSchema),
  complete: Schema.Boolean,
  missing: Schema.Array(scopedManifestFileSchema),
  scope: scopeSchema,
  unexpected: Schema.Array(scopedManifestFileSchema),
});
const scopedCoverageSchema: Schema.Codec<ScopedCoverage> = Schema.Struct({
  ...proofFields,
  counts: Schema.Struct({
    chunks: nonnegative,
    indexedFiles: nonnegative,
    missingVectors: nonnegative,
    vectors: nonnegative,
  }),
  profile: Schema.NullOr(vectorProfileSchema),
  profileHash: Schema.NullOr(hash),
  scope: scopeSchema,
  vectorCoverageComplete: Schema.Boolean,
});
const embeddingsSchema = Schema.Array(
  Schema.Struct({
    chunkId: hash,
    vector: Schema.Array(Schema.Finite).check(Schema.isBetweenLength(1, 16_000)),
  })
);
export const canonicalOperations = {
  'abort-scan': { input: ticketSchema, output: Schema.Null },
  'apply-cache': {
    input: Schema.Struct({
      files: Schema.Array(
        Schema.Struct({ ...manifestSchema.fields, content: Schema.String, stat: statSchema })
      ),
      scope: scopeSchema,
    }),
    output: Schema.Null,
  },
  'begin-scan': {
    input: Schema.Struct({ requestId: identifier, scope: scopeSchema }),
    output: ticketSchema,
  },
  'commit-text': {
    input: Schema.Struct({
      file: identitySchema,
      payload: payloadSchema,
      ticket: ticketSchema,
    }),
    output: Schema.Null,
  },
  'commit-vector': {
    input: Schema.Struct({
      embeddings: embeddingsSchema,
      file: identitySchema,
      plan: scopedPlanSchema,
      profile: vectorProfileSchema,
      syntax: Schema.optional(syntaxSchema),
      ticket: ticketSchema,
    }),
    output: Schema.Null,
  },
  'complete-files': {
    input: Schema.Struct({
      files: Schema.Array(
        Schema.Struct({ chunkCount: nonnegative, contentHash: hash, fileId: identifier })
      ),
      scope: scopeSchema,
    }),
    output: Schema.Null,
  },
  'finish-scan': {
    input: Schema.Struct({
      aborted: Schema.Boolean,
      errors: Schema.Array(Schema.String),
      files: Schema.Array(manifestSchema),
      full: Schema.Boolean,
      ticket: ticketSchema,
      truncatedDirectories: Schema.Array(Schema.String),
    }),
    output: receiptSchema,
  },
  'inference-cancel': { input: Schema.Struct({ requestId: identifier }), output: Schema.Null },
  'inference-generate': {
    input: Schema.Struct({
      chunks: Schema.Array(
        Schema.Struct({ chunkId: hash, content: Schema.String.check(Schema.isPattern(/\S/u)) })
      ).check(Schema.isBetweenLength(1, 64)),
      profile: vectorProfileSchema,
      requestId: identifier,
    }),
    output: Schema.Struct({
      profile: vectorProfileSchema,
      requestId: identifier,
      vectors: embeddingsSchema.check(Schema.isBetweenLength(1, 64)),
    }),
  },
  'inference-join': { input: Schema.Struct({ requestId: identifier }), output: Schema.Null },
  'list-dir': {
    input: Schema.Struct({ maxEntries: positive, relativePath: identifier }),
    output: listSchema,
  },
  'load-authorized': { input: batch, output: Schema.Array(catalogFileSchema) },
  'load-files': { input: scopeSchema, output: Schema.Array(sourceFileSchema) },
  'prepare-sources': {
    input: Schema.Struct({
      files: Schema.Array(
        Schema.Struct({ ...discoveredSchema.fields, content: Schema.String, contentHash: hash })
      ),
      scope: scopeSchema,
    }),
    output: Schema.Array(manifestSchema),
  },
  'prepare-vector': {
    input: Schema.Struct({
      file: identitySchema,
      payload: payloadSchema,
      profile: vectorProfileSchema,
      ticket: ticketSchema,
    }),
    output: scopedPlanSchema,
  },
  'read-file': {
    input: Schema.Struct({ maxBytes: positive, relativePath: identifier }),
    output: fileReadSchema,
  },
  'read-retained': {
    input: Schema.Struct({ file: sourceFileSchema, maxFileBytes: positive }),
    output: readSchema,
  },
  'remove-file': {
    input: Schema.Struct({ file: identitySchema, ticket: ticketSchema }),
    output: Schema.Null,
  },
  'remove-files': { input: batch, output: Schema.Null },
  'resolve-profile': { input: Schema.Struct({ scope: scopeSchema }), output: vectorProfileSchema },
  'retire-lease': { input: Schema.Null, output: Schema.Null },
  subscribe: { input: Schema.Null, output: Schema.Null },
  unsubscribe: { input: Schema.Null, output: Schema.Null },
  'vector-coverage': {
    input: Schema.Struct({ profile: vectorProfileSchema, scope: scopeSchema }),
    output: scopedCoverageSchema,
  },
  'verify-manifest': {
    input: Schema.Struct({ files: Schema.Array(manifestSchema), scope: scopeSchema }),
    output: manifestResultSchema,
  },
  'verify-vector-manifest': {
    input: Schema.Struct({ files: Schema.Array(scopedManifestFileSchema), scope: scopeSchema }),
    output: scopedManifestResultSchema,
  },
} as const;
export type CanonicalOperation = keyof typeof canonicalOperations;
const fields = { channel: Schema.Literal(CANONICAL_CHANNEL), owner: identifier };
export interface CanonicalFault {
  readonly cause?: CanonicalFault;
  readonly errors?: readonly CanonicalFault[];
  readonly message: string;
  readonly name: string;
}
export const faultSchema: Schema.Codec<CanonicalFault> = Schema.Struct({
  cause: Schema.optionalKey(Schema.suspend(() => faultSchema)),
  errors: Schema.optionalKey(Schema.Array(Schema.suspend(() => faultSchema))),
  message: Schema.String,
  name: identifier,
});
const frameSchema = Schema.Union([
  Schema.Struct({
    ...fields,
    id: positive,
    kind: Schema.Literal('call'),
    op: identifier,
    payload: Schema.Unknown,
    requestId: Schema.NullOr(identifier),
  }),
  Schema.Struct({ ...fields, id: positive, kind: Schema.Literal('cancel') }),
  Schema.Struct({
    ...fields,
    id: positive,
    kind: Schema.Literal('result'),
    ok: Schema.Literal(true),
    value: Schema.Unknown,
  }),
  Schema.Struct({
    ...fields,
    cancelled: Schema.optionalKey(Schema.Literal(true)),
    error: faultSchema,
    id: positive,
    kind: Schema.Literal('result'),
    ok: Schema.Literal(false),
  }),
  Schema.Struct({
    ...fields,
    event: identifier,
    kind: Schema.Literal('event'),
    value: Schema.Unknown,
  }),
]);
export type CanonicalFrame = typeof frameSchema.Type;
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): ((input: unknown) => S['Type']) => makeThrowingDecoder(schema, { onExcessProperty: 'error' });
export function assertCanonicalMessageBound(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) {
    throw new Error('Canonical utility message exceeds its explicit byte bound.');
  }
}
export function decodeCanonicalFrame(value: unknown): CanonicalFrame {
  assertCanonicalMessageBound(value);
  return decode(frameSchema)(value);
}
export function isCanonicalFrame(value: unknown): boolean {
  return Schema.is(Schema.Struct({ channel: Schema.Literal(CANONICAL_CHANNEL) }))(value);
}
export function canonicalFault(
  error: unknown,
  ancestors: ReadonlySet<unknown> = new Set()
): CanonicalFault {
  if (ancestors.has(error)) {
    throw new Error('Canonical error causes contain a cycle.');
  }
  const visited = new Set([...ancestors, error]);
  const errors: readonly unknown[] | undefined =
    error instanceof AggregateError ? error.errors : undefined;
  return {
    ...(error instanceof Error && error.cause !== undefined
      ? { cause: canonicalFault(error.cause, visited) }
      : {}),
    ...(errors ? { errors: errors.map((cause) => canonicalFault(cause, visited)) } : {}),
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
  };
}
export function canonicalError(fault: CanonicalFault): Error {
  const options = fault.cause ? { cause: canonicalError(fault.cause) } : {};
  const error = fault.errors
    ? new AggregateError(fault.errors.map(canonicalError), fault.message, options)
    : new Error(fault.message, options);
  error.name = fault.name;
  return error;
}
