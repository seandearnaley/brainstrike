import type { ThreadGroupsPort, ThreadGroupsReply } from '@brainstrike/types';
import { AGENT_SEMANTIC_COLOR_IDS, ASSISTANT_THREAD_ICON_IDS } from '@brainstrike/types';
import { parseThreadGroupsRequest } from '@brainstrike/types/catalog-args';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { sendCatalogRequest } from './request.js';

const Text = Schema.String.check(Schema.isMinCodePoints(1));
const ThreadGroup = Schema.Struct({
  color: Schema.NullOr(Schema.Literals(AGENT_SEMANTIC_COLOR_IDS)),
  icon: Schema.NullOr(Schema.Literals(ASSISTANT_THREAD_ICON_IDS)),
  id: Text,
  name: Text,
  rank: Text,
  resourceId: Text,
});
const ThreadPlacement = Schema.Struct({
  flatRank: Schema.NullOr(Text),
  groupId: Schema.NullOr(Text),
  rank: Text,
  resourceId: Text,
  threadId: Text,
});
const Reply = Schema.Struct({
  groups: Schema.mutable(Schema.Array(ThreadGroup)),
  placements: Schema.mutable(Schema.Array(ThreadPlacement)),
});
const METHOD = 'host/thread-groups';
export function serveThreadGroups(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: ThreadGroupsPort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<ThreadGroupsReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing !== undefined) {
      throw new Error('Thread groups endpoint is closing');
    }
    const work = store.threadGroups(parseThreadGroupsRequest(input));
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
export function createThreadGroupsClient(connection: MessageConnection): ThreadGroupsPort {
  return {
    threadGroups: async (request) =>
      Schema.decodeUnknownSync(Reply, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(connection, METHOD, parseThreadGroupsRequest(request))
      ),
  };
}
