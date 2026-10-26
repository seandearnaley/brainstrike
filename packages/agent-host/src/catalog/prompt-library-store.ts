import { parsePromptLibraryRequest } from '@brainstrike/types/catalog-args';
import type { PromptLibraryReply, PromptLibraryRequest } from '@brainstrike/types/prompt-item';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.ts';
export interface PromptLibraryPort {
  promptLibrary(request: PromptLibraryRequest): Promise<PromptLibraryReply>;
}
const Id = Schema.String.check(Schema.isPattern(/\S/u));
const DateString = Schema.String.check(Schema.isPattern(z.regexes.datetime({})));
const Common = {
  content: Schema.String,
  createdAt: DateString,
  description: Schema.NullOr(Schema.String),
  id: Id,
  modelKey: Schema.NullOr(Schema.String),
  modelSettings: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  tags: Schema.mutable(Schema.Array(Schema.String)),
  title: Schema.String,
};
const Item = Schema.Struct({
  ...Common,
  archivedAt: Schema.NullOr(DateString),
  isFavorite: Schema.Boolean,
  kind: Schema.Literals(['prompt', 'snippet', 'fragment']),
  lastUsedAction: Schema.NullOr(Schema.Literals(['compose', 'insert', 'new-thread'])),
  lastUsedAt: Schema.NullOr(DateString),
  rating: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(5))
  ),
  sourceUrl: Schema.NullOr(Schema.String),
  updatedAt: DateString,
  useCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const Reply = Schema.Struct({
  items: Schema.mutable(Schema.Array(Item)),
  revisions: Schema.mutable(
    Schema.Array(Schema.Struct({ ...Common, note: Schema.NullOr(Schema.String), promptItemId: Id }))
  ),
});
const METHOD = 'host/prompt-library';
export function servePromptLibrary(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: PromptLibraryPort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<PromptLibraryReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing !== undefined) {
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
      Schema.decodeUnknownSync(Reply, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(connection, METHOD, parsePromptLibraryRequest(request))
      ),
  };
}
