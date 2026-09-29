import type { ChildContinuationScope } from '@brainstrike/agent';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  type DelegatedConversationDatabase,
  readAssistantHistoryMessages,
  recordAssistantHistoryParent,
} from '@brainstrike/db';

type HistoryMessage = Awaited<ReturnType<typeof readAssistantHistoryMessages>>[number];

function oldestHistoryMessageId(messages: readonly HistoryMessage[]): string {
  const id = messages[0]?.id;
  if (!id) {
    throw new Error('Child branch history has no paging cursor.');
  }
  return id;
}

async function readBranchHistory(
  database: DelegatedConversationDatabase,
  scope: ChildContinuationScope
): Promise<readonly string[]> {
  const targetMessageId = scope.branch?.messageId;
  if (!targetMessageId) {
    return [];
  }
  let page = await readAssistantHistoryMessages(database, scope.threadId, scope.resourceId, {
    limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    targetMessageId,
  });
  while (true) {
    const targetIndex = page.findIndex(({ id }) => id === targetMessageId);
    if (targetIndex >= 0) {
      let messages = page.slice(0, targetIndex + 1);
      let reachedStart = page.length < ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT;
      while (true) {
        const prefix = resolveBranchPrefix(messages, scope, reachedStart);
        if (prefix) {
          return prefix;
        }
        if (reachedStart) {
          throw new Error('Child branch history is incomplete or cyclic.');
        }
        const older = await readAssistantHistoryMessages(
          database,
          scope.threadId,
          scope.resourceId,
          {
            beforeMessageId: oldestHistoryMessageId(messages),
            limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
            targetMessageId,
          }
        );
        reachedStart = older.length < ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT;
        messages = [...older, ...messages];
      }
    }
    const cursor = page[0]?.id;
    if (!cursor) {
      throw new Error('The selected child message is no longer available for this action.');
    }
    page = await readAssistantHistoryMessages(database, scope.threadId, scope.resourceId, {
      beforeMessageId: cursor,
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
      targetMessageId,
    });
  }
}

function resolveBranchPrefix(
  messages: readonly HistoryMessage[],
  scope: ChildContinuationScope,
  reachedStart: boolean
): readonly string[] | undefined {
  const nodes = new Map(
    messages.map((message, index) => [
      message.id,
      {
        ...message,
        parentId:
          message.parentId === undefined
            ? (messages[index - 1]?.id ?? (reachedStart ? null : undefined))
            : message.parentId,
      },
    ])
  );
  const selected = nodes.get(scope.branch?.messageId ?? '');
  const expectedRole = scope.branch?.kind === 'retry' ? 'assistant' : 'user';
  if (!selected || selected.role !== expectedRole) {
    throw new Error('The selected child message is no longer available for this action.');
  }
  const prefix: string[] = [];
  let cursor = selected.parentId;
  while (cursor !== null) {
    if (cursor === undefined) {
      return;
    }
    const row = nodes.get(cursor);
    if (!row) {
      return;
    }
    if (prefix.includes(cursor)) {
      throw new Error('Child branch history is incomplete or cyclic.');
    }
    prefix.unshift(cursor);
    cursor = row.parentId;
  }
  if (scope.branch?.kind === 'retry' && nodes.get(selected.parentId ?? '')?.role !== 'user') {
    throw new Error('The selected child answer has no durable user prompt to retry.');
  }
  return prefix;
}

/** Resolve selection only after the host has authorized the native child identity. */
export async function prepareDelegatedChildBranch(
  database: DelegatedConversationDatabase,
  scope: ChildContinuationScope,
  writeParents: boolean
): Promise<ChildContinuationScope> {
  if (!scope.branch) {
    return scope;
  }
  const prefix = await readBranchHistory(database, scope);
  const parentId = prefix.at(-1) ?? null;
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
