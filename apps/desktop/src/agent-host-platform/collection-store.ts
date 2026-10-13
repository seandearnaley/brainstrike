import type {
  CollectionMetadata,
  CollectionPort,
  CollectionRecord,
  CollectionReply,
} from '@brainstrike/state-store';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';

const Id = z.string().regex(/\S/);
const Metadata = z.strictObject({
  category: z.string().optional(),
  description: z.string().optional(),
  name: z.string().optional(),
  tags: z.string().optional(),
});
const CollectionSchema = Metadata.extend({
  createdAt: z.string().datetime(),
  dimensions: z.number().int().positive().max(16_000),
  distance: z.enum(['cosine', 'l2', 'ip']),
  id: Id,
  modelId: Id,
  modelKey: Id,
  systemRole: z.literal('workspace-index').optional(),
});
function metadata(value: z.infer<typeof Metadata>): CollectionMetadata {
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.category === undefined ? {} : { category: value.category }),
    ...(value.tags === undefined ? {} : { tags: value.tags }),
  };
}
const Collection = CollectionSchema.transform((value): CollectionRecord => {
  const { name, description, category, tags, systemRole, ...required } = value;
  return {
    ...required,
    ...metadata({ category, description, name, tags }),
    ...(systemRole === undefined ? {} : { systemRole }),
  };
});
const Request = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('snapshot') }),
  z.strictObject({ id: Id, operation: z.literal('get') }),
  z.strictObject({ collection: Collection, operation: z.literal('create') }),
  z.strictObject({
    id: Id,
    metadata: Metadata.transform(metadata),
    operation: z.literal('update'),
  }),
  z.strictObject({ id: Id, operation: z.literal('delete') }),
]);
const Reply = z.strictObject({
  collections: z.array(Collection),
  counts: z
    .array(
      z.strictObject({
        chunks: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
        id: Id,
        unprocessedFiles: z.number().int().nonnegative(),
      })
    )
    .optional(),
});
const METHOD = 'host/collections';

export function serveCollectionStore(
  connection: MessageConnection,
  store: CollectionPort
): { close(): Promise<void> } {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<CollectionReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
      throw new Error('Collection endpoint is closing');
    }
    const request = Request.parse(input);
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
      const reply = Reply.parse(await connection.sendRequest(METHOD, Request.parse(request)));
      return {
        collections: reply.collections,
        ...(reply.counts === undefined ? {} : { counts: reply.counts }),
      };
    },
  };
}
