import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { type ProcessInputStepArgs, TokenLimiter } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import { ProjectionAwareTokenLimiter } from '../mastra/projection-aware-token-limiter';

function createProcessInputStepArgs(messageList: MessageList): ProcessInputStepArgs {
  return {
    abort(reason?: string): never {
      throw new Error(reason ?? 'processor aborted');
    },
    messageList,
    messages: messageList.get.all.db(),
    model: 'openai/gpt-5.5',
    retryCount: 0,
    state: {},
    stepNumber: 1,
    steps: [],
    systemMessages: [],
  };
}

function createToolResultMessage(args: {
  modelOutput: unknown;
  rawResult: unknown;
}): MastraDBMessage {
  return {
    content: {
      format: 2,
      parts: [
        {
          providerMetadata: { mastra: { modelOutput: args.modelOutput } },
          toolInvocation: {
            args: {},
            result: args.rawResult,
            state: 'result',
            toolCallId: 'call-1',
            toolName: 'large_output',
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date(),
    id: 'assistant-1',
    role: 'assistant',
  };
}

describe('ProjectionAwareTokenLimiter', () => {
  it('counts the model projection with compact media markers and restores the raw result', async () => {
    const rawResult = { content: 'r'.repeat(250_000), rawOnly: true };
    const mediaData = 'b'.repeat(250_000);
    const modelOutput = {
      type: 'content',
      value: [
        { text: 'Compact result summary.', type: 'text' },
        { data: mediaData, mediaType: 'image/png', type: 'media' },
      ],
    };
    const message = createToolResultMessage({ modelOutput, rawResult });
    const messageList = new MessageList();
    messageList.add(message, 'response');
    const options = {
      limit: 200,
      strategy: 'truncate' as const,
      trimMode: 'contiguous' as const,
    };
    const rawCountingMessageList = new MessageList();
    rawCountingMessageList.add(createToolResultMessage({ modelOutput, rawResult }), 'response');

    await expect(
      new TokenLimiter(options).processInputStep(createProcessInputStepArgs(rawCountingMessageList))
    ).rejects.toThrow('No messages fit within the remaining token budget');

    await expect(
      new ProjectionAwareTokenLimiter(options).processInputStep(
        createProcessInputStepArgs(messageList)
      )
    ).resolves.toBe(undefined);

    const retainedPart = messageList.get.all.db()[0]?.content.parts[0];
    expect(retainedPart).toMatchObject({
      providerMetadata: { mastra: { modelOutput } },
      toolInvocation: { result: rawResult },
    });
    expect(modelOutput.value[1]?.data).toBe(mediaData);
  });

  it('compacts file data URLs without exempting remote URL text from token counting', async () => {
    const rawResult = { content: 'r'.repeat(250_000), rawOnly: true };
    const dataUrl = `data:application/pdf;base64,${'f'.repeat(250_000)}`;
    const dataUrlMessage = createToolResultMessage({
      modelOutput: {
        type: 'content',
        value: [{ type: 'file-url', url: dataUrl }],
      },
      rawResult,
    });
    const dataUrlMessageList = new MessageList();
    dataUrlMessageList.add(dataUrlMessage, 'response');
    const options = {
      limit: 200,
      strategy: 'truncate' as const,
      trimMode: 'contiguous' as const,
    };

    await expect(
      new ProjectionAwareTokenLimiter(options).processInputStep(
        createProcessInputStepArgs(dataUrlMessageList)
      )
    ).resolves.toBe(undefined);
    expect(dataUrlMessage.content.parts[0]).toMatchObject({
      toolInvocation: { result: rawResult },
    });

    const remoteUrlRawResult = { remote: true };
    const remoteUrlMessage = createToolResultMessage({
      modelOutput: {
        type: 'content',
        value: [{ type: 'image-url', url: `https://example.com/${'x'.repeat(10_000)}` }],
      },
      rawResult: remoteUrlRawResult,
    });
    const remoteUrlMessageList = new MessageList();
    remoteUrlMessageList.add(remoteUrlMessage, 'response');

    await expect(
      new ProjectionAwareTokenLimiter(options).processInputStep(
        createProcessInputStepArgs(remoteUrlMessageList)
      )
    ).rejects.toThrow('No messages fit within the remaining token budget');
    expect(remoteUrlMessage.content.parts[0]).toMatchObject({
      toolInvocation: { result: remoteUrlRawResult },
    });
  });

  it('restores the raw result when the delegated limiter throws', async () => {
    const rawResult = { content: 'raw result must survive the tripwire' };
    const message = createToolResultMessage({
      modelOutput: { type: 'text', value: 'projected '.repeat(10_000) },
      rawResult,
    });
    const messageList = new MessageList();
    messageList.add(message, 'response');
    const limiter = new ProjectionAwareTokenLimiter({
      limit: 100,
      strategy: 'truncate',
      trimMode: 'contiguous',
    });

    await expect(limiter.processInputStep(createProcessInputStepArgs(messageList))).rejects.toThrow(
      'No messages fit within the remaining token budget'
    );

    expect(message.content.parts[0]).toMatchObject({
      toolInvocation: { result: rawResult },
    });
  });

  it("keeps Mastra's canonical token-limiter processor id", () => {
    expect(new ProjectionAwareTokenLimiter(100).id).toBe('token-limiter');
  });
});
