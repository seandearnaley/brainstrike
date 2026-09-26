import type { StreamChunk } from '../../types';

export function shellOutputOwners(chunks: readonly StreamChunk[]): string[] {
  return chunks
    .flatMap((chunk) =>
      chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'shell-output'
        ? [chunk.identity.parentToolCallId]
        : []
    )
    .sort();
}

/** A granted sibling's card locks before its native start and first output. */
export function hasGrantedShellProgressOrder(
  chunks: readonly StreamChunk[],
  leafToolCallId: string,
  parentToolCallId: string
): boolean {
  const answer = chunks.findIndex(
    (chunk) =>
      chunk.type === 'tool-approval-answered' && chunk.delegation?.toolCallId === leafToolCallId
  );
  const start = chunks.findIndex(
    (chunk) =>
      chunk.type === 'delegated-conversation-chunk' &&
      chunk.identity.parentToolCallId === parentToolCallId &&
      chunk.chunk.type === 'tool-event' &&
      chunk.chunk.status === 'start'
  );
  const output = chunks.findIndex(
    (chunk) =>
      chunk.type === 'delegated-conversation-chunk' &&
      chunk.identity.parentToolCallId === parentToolCallId &&
      chunk.chunk.type === 'shell-output'
  );
  return answer >= 0 && start > answer && output > start;
}
