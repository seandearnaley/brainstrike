/**
 * One-shot assistant-message-id generator (BST-742): aligns the client-provided
 * persisted assistant id with Mastra's memory ID context. Shared by the
 * runtime's Mastra registration (`registerAgentWithMastra`) and the stream
 * path's `experimental_generateMessageId` option — each side consumes its OWN
 * generator instance (sharing one would make whichever Mastra path runs first
 * force the other to a UUID, breaking visible/persisted identity alignment).
 */
import { generateUUID } from '@brainstrike/utils';
import type { IdGeneratorContext } from '@mastra/core/types';

export interface AssistantMessageIdGenerator {
  assertConsumed: () => void;
  generate: (context?: IdGeneratorContext) => string;
}

export function createAssistantMessageIdGenerator(
  initialMessageId: string
): AssistantMessageIdGenerator {
  let nextMessageId: string | undefined = initialMessageId;
  return {
    assertConsumed() {
      if (nextMessageId === undefined) {
        return;
      }
      throw new Error(
        `Mastra completed without persisting assistant message ID "${initialMessageId}" through its memory ID context.`
      );
    },
    generate(context?: IdGeneratorContext) {
      if (context && (context.idType !== 'message' || context.source !== 'memory')) {
        return generateUUID();
      }
      if (nextMessageId !== undefined) {
        const messageId = nextMessageId;
        nextMessageId = undefined;
        return messageId;
      }
      return generateUUID();
    },
  };
}
