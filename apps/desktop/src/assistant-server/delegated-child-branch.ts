import type { ChildContinuationScope } from '@brainstrike/agent';
import {
  type DelegatedConversationDatabase,
  readAssistantHistoryMessages,
  recordAssistantHistoryParent,
} from '@brainstrike/db';

/** Resolve selection only after the host has authorized the native child identity. */
export async function prepareDelegatedChildBranch(
  database: DelegatedConversationDatabase,
  scope: ChildContinuationScope,
  writeParents: boolean
): Promise<ChildContinuationScope> {
  if (!scope.branch) {
    return scope;
  }
  const messages = await readAssistantHistoryMessages(database, scope.threadId, scope.resourceId, {
    targetMessageId: scope.branch.messageId,
  });
  const nodes = new Map(
    messages.map((message, index) => [
      message.id,
      {
        ...message,
        parentId:
          message.parentId === undefined ? (messages[index - 1]?.id ?? null) : message.parentId,
      },
    ])
  );
  const selected = nodes.get(scope.branch.messageId);
  const expectedRole = scope.branch.kind === 'retry' ? 'assistant' : 'user';
  if (!selected || selected.role !== expectedRole) {
    throw new Error('The selected child message is no longer available for this action.');
  }
  const parentId = selected.parentId;
  if (scope.branch.kind === 'retry' && (!parentId || nodes.get(parentId)?.role !== 'user')) {
    throw new Error('The selected child answer has no durable user prompt to retry.');
  }
  const prefix: string[] = [];
  let cursor = parentId;
  while (cursor !== null) {
    const row = nodes.get(cursor);
    if (!row || prefix.includes(cursor)) {
      throw new Error('Child branch history is incomplete or cyclic.');
    }
    prefix.unshift(cursor);
    cursor = row.parentId;
  }
  const branchInputMessageId = `${scope.messageId}:input`;
  if (writeParents) {
    const base = { resourceId: scope.resourceId, threadId: scope.threadId };
    if (scope.branch.kind === 'edit') {
      await recordAssistantHistoryParent(database, {
        ...base,
        messageId: branchInputMessageId,
        parentId,
      });
    }
    await recordAssistantHistoryParent(database, {
      ...base,
      messageId: scope.messageId,
      parentId: scope.branch.kind === 'edit' ? branchInputMessageId : parentId,
    });
  }
  return { ...scope, branchInputMessageId, branchMessageIds: prefix };
}
