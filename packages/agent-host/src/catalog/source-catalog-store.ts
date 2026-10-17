import type { SourceCatalogPort, SourceCatalogReply } from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.js';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Stat = Schema.Struct({
  mtimeMs: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const Source = Schema.Struct({
  content: Schema.String,
  contentHash: Hash,
  fileName: Id,
  path: Id,
  stat: Stat,
});
const Record = Schema.Struct({
  chunksCount: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  chunksProcessed: Schema.Boolean,
  content: Schema.NullOr(Schema.String),
  contentHash: Hash,
  createdAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
  embeddingSetId: Schema.NullOr(Id),
  fileId: Id,
  fileName: Id,
  path: Id,
  rootId: Schema.NullOr(Id),
  stat: Stat,
  updatedAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
});
const Request = Schema.Union(
  [
    Schema.Struct({ operation: Schema.Literal('list') }),
    Schema.Struct({ embeddingSetId: Schema.NullOr(Id), operation: Schema.Literal('inventory') }),
    Schema.Struct({
      fileIds: Schema.mutable(Schema.Array(Id)).check(Schema.isMaxLength(250)),
      maxContentBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      operation: Schema.Literal('read'),
    }),
    Schema.Struct({
      embeddingSetId: Schema.NullOr(Id),
      files: Schema.mutable(Schema.Array(Source)).check(Schema.isMaxLength(250)),
      operation: Schema.Literal('import'),
    }),
    Schema.Struct({
      embeddingSetId: Schema.NullOr(Id),
      files: Schema.mutable(Schema.Array(Source)).check(Schema.isMaxLength(250)),
      operation: Schema.Literal('prepare'),
      rootId: Id,
    }),
    Schema.Struct({
      files: Schema.mutable(
        Schema.Array(Schema.Struct({ expected: Record, source: Source }))
      ).check(Schema.isMaxLength(250)),
      operation: Schema.Literal('replace'),
    }),
    Schema.Struct({
      files: Schema.mutable(
        Schema.Array(
          Schema.Struct({
            chunkCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
            expected: Record,
          })
        )
      ).check(Schema.isMaxLength(250)),
      operation: Schema.Literal('complete'),
    }),
    Schema.Struct({
      files: Schema.mutable(Schema.Array(Record)).check(Schema.isMaxLength(250)),
      operation: Schema.Literal('remove'),
    }),
  ],
  { mode: 'oneOf' }
);
const Reply = Schema.Struct({
  files: Schema.mutable(Schema.Array(Record)),
  imported: Schema.optional(Schema.mutable(Schema.Array(Schema.Boolean))),
});
const METHOD = 'host/source-catalog';
/** Authenticated clients borrow the existing source catalog writer. */
export function serveSourceCatalogStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: SourceCatalogPort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<SourceCatalogReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing !== undefined) {
      throw new Error('Source catalog endpoint is closing');
    }
    const request = Schema.decodeUnknownSync(Request, { errors: 'all', onExcessProperty: 'error' })(
      input
    );
    const normalized =
      request.operation === 'read'
        ? {
            fileIds: request.fileIds,
            operation: request.operation,
            ...(request.maxContentBytes === undefined
              ? {}
              : { maxContentBytes: request.maxContentBytes }),
          }
        : request;
    const work = store.sourceCatalog(normalized);
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  });
  return {
    close: () => {
      closing ??= Promise.resolve().then(async () => {
        while (pending.size > 0) {
          await Promise.allSettled([...pending]);
        }
        subscription.dispose();
      });
      return closing;
    },
  };
}
export function createSourceCatalogClient(connection: MessageConnection): SourceCatalogPort {
  return {
    sourceCatalog: async (request) => {
      const reply = Schema.decodeUnknownSync(Reply, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(
          connection,
          METHOD,
          Schema.decodeUnknownSync(Request, { errors: 'all', onExcessProperty: 'error' })(request)
        )
      );
      return {
        files: reply.files,
        ...(reply.imported === undefined ? {} : { imported: reply.imported }),
      };
    },
  };
}
