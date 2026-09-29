import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import type { ProcessOutputStepArgs } from '@mastra/core/processors';
import { describe, expect, it, vi } from 'vitest';
import { createResponseBoundaryProcessor } from '../mastra/response-boundary-processor';

function row(id: string, text: string): MastraDBMessage {
  return {
    content: { format: 2, parts: [{ text, type: 'text' }] },
    createdAt: new Date(),
    id,
    role: 'assistant',
  };
}

function processStep(messageList: MessageList, toolCalls: ProcessOutputStepArgs['toolCalls'] = []) {
  const processor = createResponseBoundaryProcessor();
  if (!processor.processOutputStep) {
    throw new Error('Missing output-step processor');
  }
  return processor.processOutputStep({
    abort: (reason) => {
      throw new Error(reason);
    },
    messageList,
    messages: messageList.get.all.db(),
    retryCount: 0,
    state: {},
    stepNumber: 0,
    steps: [],
    systemMessages: [],
    toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
}

describe('native response boundaries', () => {
  it('keeps an earlier response replay out of the latest continuation without deduplicating text', async () => {
    const messages = new MessageList();
    const before = row('before', 'Repeated text.');
    messages.add(before, 'response');
    messages.markResponseMessageBoundary('before');
    messages.add(row('after', 'Repeated text.'), 'response');
    await processStep(messages);
    messages.add(before, 'response');
    expect(
      messages.get.response.db().map(({ id, content }) => ({ id, parts: content.parts }))
    ).toMatchObject([
      { id: 'before', parts: [{ text: 'Repeated text.', type: 'text' }] },
      { id: 'after', parts: [{ text: 'Repeated text.', type: 'text' }] },
    ]);
  });

  it('leaves a tool step open for ordinary continuation', async () => {
    const messages = new MessageList();
    messages.add(row('before', 'Before.'), 'response');
    await processStep(messages, [{ args: {}, toolCallId: 'read-1', toolName: 'read' }]);
    messages.add(row('after', 'After.'), 'response');
    expect(messages.get.response.db()).toHaveLength(1);
    expect(messages.get.response.db()[0]?.content.parts).toMatchObject([
      { text: 'Before.', type: 'text' },
      { text: 'After.', type: 'text' },
    ]);
  });

  it('fails explicitly when native identity cannot be sealed', async () => {
    const messages = new MessageList();
    messages.add(row('response', 'Retain this evidence.'), 'response');
    vi.spyOn(messages, 'markResponseMessageBoundary').mockReturnValue(false);
    expect(() => processStep(messages)).toThrow(
      'Cannot preserve the native response message boundary.'
    );
    expect(messages.get.response.db()[0]?.content.parts).toMatchObject([
      { text: 'Retain this evidence.', type: 'text' },
    ]);
  });

  it('does not invent a row for an empty response', async () => {
    const messages = new MessageList();
    await processStep(messages);
    expect(messages.get.response.db()).toEqual([]);
  });
});
