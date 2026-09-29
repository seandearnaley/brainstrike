import type { OutputProcessor } from '@mastra/core/processors';

export function createResponseBoundaryProcessor(): OutputProcessor {
  return {
    id: 'brainstrike-response-boundaries',
    processOutputStep({ messageList, toolCalls }) {
      if (toolCalls?.length) {
        return messageList;
      }
      // Core re-adds all response rows at finish. Preserve the last native row
      // so replaying an earlier approval row cannot merge it into this one.
      // Tool steps remain open for their results and normal step continuation.
      const response = messageList.get.response
        .db()
        .findLast((message) => message.role === 'assistant');
      if (response && !messageList.markResponseMessageBoundary(response.id)) {
        throw new Error('Cannot preserve the native response message boundary.');
      }
      return messageList;
    },
  };
}
