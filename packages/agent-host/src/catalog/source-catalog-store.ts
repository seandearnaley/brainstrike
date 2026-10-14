import type { SourceCatalogPort, SourceCatalogReply } from '@brainstrike/state-store';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.js';

const Id = z.string().min(1);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Stat = z.strictObject({
  mtimeMs: z.number().nonnegative().nullable(),
  size: z.number().int().nonnegative(),
});
const Source = z.strictObject({
  content: z.string(),
  contentHash: Hash,
  fileName: Id,
  path: Id,
  stat: Stat,
});
const Record = z.strictObject({
  chunksCount: z.number().int().nonnegative().nullable(),
  chunksProcessed: z.boolean(),
  content: z.string().nullable(),
  contentHash: Hash,
  createdAt: z.string().datetime(),
  embeddingSetId: Id.nullable(),
  fileId: Id,
  fileName: Id,
  path: Id,
  rootId: Id.nullable(),
  stat: Stat,
  updatedAt: z.string().datetime(),
});
const Request = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ embeddingSetId: Id.nullable(), operation: z.literal('inventory') }),
  z.strictObject({
    fileIds: z.array(Id).max(250),
    maxContentBytes: z.number().int().nonnegative().optional(),
    operation: z.literal('read'),
  }),
  z.strictObject({
    embeddingSetId: Id.nullable(),
    files: z.array(Source).max(250),
    operation: z.literal('import'),
  }),
  z.strictObject({
    embeddingSetId: Id.nullable(),
    files: z.array(Source).max(250),
    operation: z.literal('prepare'),
    rootId: Id,
  }),
  z.strictObject({
    files: z.array(z.strictObject({ expected: Record, source: Source })).max(250),
    operation: z.literal('replace'),
  }),
  z.strictObject({
    files: z
      .array(z.strictObject({ chunkCount: z.number().int().nonnegative(), expected: Record }))
      .max(250),
    operation: z.literal('complete'),
  }),
  z.strictObject({ files: z.array(Record).max(250), operation: z.literal('remove') }),
]);
const Reply = z.strictObject({ files: z.array(Record), imported: z.array(z.boolean()).optional() });
const METHOD = 'host/source-catalog';

/** Authenticated clients borrow the existing source catalog writer. */
export function serveSourceCatalogStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: SourceCatalogPort
): { close(): Promise<void> } {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<SourceCatalogReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
      throw new Error('Source catalog endpoint is closing');
    }
    const request = Request.parse(input);
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
      const reply = Reply.parse(
        await sendCatalogRequest(connection, METHOD, Request.parse(request))
      );
      return {
        files: reply.files,
        ...(reply.imported === undefined ? {} : { imported: reply.imported }),
      };
    },
  };
}
