import { omitUndefinedOptional } from '@brainstrike/assistant-contract/schema-boundary';
import type { CollectionPort, CollectionReply } from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.js';

const Id = Schema.String.check(Schema.isPattern(/\S/));
const Metadata = Schema.Struct({
  category: omitUndefinedOptional(Schema.String),
  description: omitUndefinedOptional(Schema.String),
  name: omitUndefinedOptional(Schema.String),
  tags: omitUndefinedOptional(Schema.String),
});
const CollectionSchema = Schema.Struct({
  ...Metadata.fields,
  ...{
    createdAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
    dimensions: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(16_000)),
    distance: Schema.Literals(['cosine', 'l2', 'ip']),
    id: Id,
    modelId: Id,
    modelKey: Id,
    systemRole: omitUndefinedOptional(Schema.Literal('workspace-index')),
  },
});
const Collection = CollectionSchema;
const Request = Schema.Union(
  [
    Schema.Struct({ operation: Schema.Literal('list') }),
    Schema.Struct({ operation: Schema.Literal('snapshot') }),
    Schema.Struct({ id: Id, operation: Schema.Literal('get') }),
    Schema.Struct({ collection: Collection, operation: Schema.Literal('create') }),
    Schema.Struct({ id: Id, metadata: Metadata, operation: Schema.Literal('update') }),
    Schema.Struct({ id: Id, operation: Schema.Literal('delete') }),
  ],
  { mode: 'oneOf' }
);
const Reply = Schema.Struct({
  collections: Schema.mutable(Schema.Array(Collection)),
  counts: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          chunks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          id: Id,
          unprocessedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        })
      )
    )
  ),
});
const METHOD = 'host/collections';
export function serveCollectionStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: CollectionPort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<CollectionReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
      throw new Error('Collection endpoint is closing');
    }
    const request = Schema.decodeUnknownSync(Request, { errors: 'all', onExcessProperty: 'error' })(
      input
    );
    const work = store.collections(request);
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
export function createCollectionClient(connection: MessageConnection): CollectionPort {
  return {
    collections: async (request) => {
      const reply = Schema.decodeUnknownSync(Reply, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(
          connection,
          METHOD,
          Schema.decodeUnknownSync(Request, { errors: 'all', onExcessProperty: 'error' })(request)
        )
      );
      return {
        collections: reply.collections,
        ...(reply.counts === undefined ? {} : { counts: reply.counts }),
      };
    },
  };
}
