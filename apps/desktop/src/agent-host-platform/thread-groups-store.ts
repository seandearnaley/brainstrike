import type { ThreadGroupsPort, ThreadGroupsReply } from '@brainstrike/types';
import { AGENT_SEMANTIC_COLOR_IDS, ASSISTANT_THREAD_ICON_IDS } from '@brainstrike/types';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { parseThreadGroupsRequest } from '../ipc-domains/thread-groups.contract';

const Text = z.string().min(1);
const ThreadGroup = z.strictObject({
  color: z.enum(AGENT_SEMANTIC_COLOR_IDS).nullable(),
  icon: z.enum(ASSISTANT_THREAD_ICON_IDS).nullable(),
  id: Text,
  name: Text,
  rank: Text,
  resourceId: Text,
});
const ThreadPlacement = z.strictObject({
  flatRank: Text.nullable(),
  groupId: Text.nullable(),
  rank: Text,
  resourceId: Text,
  threadId: Text,
});

const Reply = z.strictObject({
  groups: z.array(ThreadGroup),
  placements: z.array(ThreadPlacement),
});
const METHOD = 'host/thread-groups';
export function serveThreadGroups(
  connection: MessageConnection,
  store: ThreadGroupsPort
): { close(): Promise<void> } {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<ThreadGroupsReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
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
      Reply.parse(await connection.sendRequest(METHOD, parseThreadGroupsRequest(request))),
  };
}
