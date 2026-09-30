import type { MastraDBMessage } from '@mastra/core/agent';
import { backgroundTaskReferences, record } from '../background-result-projection';

export function hasBackgroundInvocation(message: MastraDBMessage, toolCallId: string): boolean {
  return message.content.parts.some(
    (part) => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === toolCallId
  );
}

/** Native observation splits retain message metadata while rotating to suffix-only parts. */
export function removeInheritedBackgroundReference(
  message: MastraDBMessage,
  taskId: string,
  toolCallId: string,
  owners: readonly MastraDBMessage[]
): void {
  if (record(message.content.metadata?.['mastra'])?.['sealed'] !== true) {
    throw new Error('Background parent invocation is missing or ambiguous.');
  }
  let sealedOwner = false;
  for (const owner of owners) {
    if (owner.id === message.id || backgroundTaskReferences(owner).get(toolCallId) !== taskId) {
      continue;
    }
    const invocationIndexes = owner.content.parts.flatMap((part, index) =>
      part.type === 'tool-invocation' && part.toolInvocation.toolCallId === toolCallId
        ? [index]
        : []
    );
    if (
      owner.threadId !== message.threadId ||
      owner.resourceId !== message.resourceId ||
      invocationIndexes.length > 1
    ) {
      throw new Error('Background parent invocation is missing or ambiguous.');
    }
    if (invocationIndexes.length === 0) {
      continue;
    }
    const sealIndex = owner.content.parts.findLastIndex(
      (part) =>
        typeof record(record(record(part)?.['metadata'])?.['mastra'])?.['sealedAt'] === 'number'
    );
    if (
      record(owner.content.metadata?.['mastra'])?.['sealed'] === true &&
      sealIndex >= (invocationIndexes[0] ?? 0) &&
      owner.createdAt.getTime() <= message.createdAt.getTime()
    ) {
      sealedOwner = true;
    }
  }
  if (!sealedOwner) {
    throw new Error('Background parent invocation is missing or ambiguous.');
  }
  const metadata = { ...message.content.metadata };
  const references = { ...record(metadata['backgroundTasks']) };
  delete references[toolCallId];
  metadata['backgroundTasks'] = references;
  message.content.metadata = metadata;
}
