import type { Agent } from '@mastra/core/agent';
import type { MemoryConfig } from '@mastra/core/memory';
import type { Processor } from '@mastra/core/processors';
import type { ChildContinuationScope } from './child-continuation-host-port';

/** A historical branch uses selected messages, never later derived summaries. */
export const CHILD_BRANCH_MEMORY_OPTIONS = {
  lastMessages: 1,
  observationalMemory: false,
  semanticRecall: false,
  workingMemory: { enabled: false },
} satisfies MemoryConfig;

export async function childBranchInputProcessors(child: Agent, scope: ChildContinuationScope) {
  if (!scope.branch) {
    return;
  }
  if (!scope.branchMessageIds) {
    throw new Error('Child branch has no authorized history selection.');
  }
  const memory = await child.getMemory();
  const store = await memory?.storage.getStore('memory');
  if (!store) {
    throw new Error('Child branch requires native durable memory.');
  }
  const selectedIds = new Set(scope.branchMessageIds);
  const { messages } = selectedIds.size
    ? await store.listMessagesById({ messageIds: [...selectedIds] })
    : { messages: [] };
  if (
    messages.length !== selectedIds.size ||
    messages.some(
      (message) => message.threadId !== scope.threadId || message.resourceId !== scope.resourceId
    )
  ) {
    throw new Error('Child branch history changed or has a different owner.');
  }
  const byId = new Map(messages.map((message) => [message.id, message]));
  const prefix = scope.branchMessageIds.map((id) => {
    const message = byId.get(id);
    if (!message) {
      throw new Error('Child branch history is incomplete.');
    }
    return message;
  });
  const processor: Processor = {
    id: 'brainstrike-child-selected-history',
    processInput({ messageList }) {
      messageList.add(prefix, 'memory');
      const sources = messageList.makeMessageSourceChecker();
      return messageList.get.all
        .db()
        .filter(
          (message) => selectedIds.has(message.id) || sources.getSource(message) !== 'memory'
        );
    },
  };
  return [processor, ...(await child.listConfiguredInputProcessors())];
}
