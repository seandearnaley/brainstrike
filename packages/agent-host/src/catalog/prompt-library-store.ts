import { parsePromptLibraryRequest } from '@brainstrike/types/catalog-args';
import type { PromptLibraryReply, PromptLibraryRequest } from '@brainstrike/types/prompt-item';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.js';
export interface PromptLibraryPort {
  promptLibrary(request: PromptLibraryRequest): Promise<PromptLibraryReply>;
}
const Id = z.string().regex(/\S/u);
const DateString = z.string().datetime();
const Common = {
  content: z.string(),
  createdAt: DateString,
  description: z.string().nullable(),
  id: Id,
  modelKey: z.string().nullable(),
  modelSettings: z.record(z.string(), z.unknown()).nullable(),
  revision: z.number().int().positive(),
  tags: z.array(z.string()),
  title: z.string(),
};
const Item = z.strictObject({
  ...Common,
  archivedAt: DateString.nullable(),
  embeddingError: z.string().nullable(),
  embeddingProfileId: z.string().nullable(),
  embeddingRevision: z.number().int().positive().nullable(),
  embeddingStatus: z.enum(['pending', 'ready', 'error']),
  embeddingUpdatedAt: DateString.nullable(),
  isFavorite: z.boolean(),
  kind: z.enum(['prompt', 'snippet', 'fragment']),
  lastUsedAction: z.enum(['compose', 'insert', 'new-thread']).nullable(),
  lastUsedAt: DateString.nullable(),
  rating: z.number().int().min(0).max(5).nullable(),
  sourceUrl: z.string().nullable(),
  updatedAt: DateString,
  useCount: z.number().int().nonnegative(),
});
const Reply = z.strictObject({
  accepted: z.boolean(),
  items: z.array(Item),
  profile: z.strictObject({
    dimensions: z.literal(384),
    distance: z.literal('cosine'),
    id: z.literal('default'),
    modelId: z.literal('Xenova/all-MiniLM-L6-v2'),
    modelKey: z.literal('local::Xenova/all-MiniLM-L6-v2'),
  }),
  revisions: z.array(z.strictObject({ ...Common, note: z.string().nullable(), promptItemId: Id })),
  similarities: z.array(
    z.strictObject({
      id: Id,
      revision: z.number().int().positive(),
      similarity: z.number().finite().min(-1).max(1),
    })
  ),
});
const METHOD = 'host/prompt-library';
export function servePromptLibrary(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: PromptLibraryPort
): { close(): Promise<void> } {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<PromptLibraryReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
      throw new Error('Prompt Library endpoint is closing');
    }
    const work = store.promptLibrary(parsePromptLibraryRequest(input));
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
        while (pending.size) {
          await Promise.allSettled([...pending]);
        }
        subscription.dispose();
      });
      return closing;
    },
  };
}
export function createPromptLibraryClient(connection: MessageConnection): PromptLibraryPort {
  return {
    promptLibrary: async (request) =>
      Reply.parse(await sendCatalogRequest(connection, METHOD, parsePromptLibraryRequest(request))),
  };
}
