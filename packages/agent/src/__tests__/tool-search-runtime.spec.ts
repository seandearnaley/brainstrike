import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { MASTRA_THREAD_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MastraAgentError } from '../mastra/mastra-agent-error';
import { BrainstrikeToolSearchProcessor } from '../mastra/tool-search-runtime';

const DEFERRED_TOOL_ID = 'brainstrike_listWorkspaceContext';

function createDeferredTool() {
  return createTool({
    description: 'List the files and metadata in the active workspace context.',
    execute: async () => ({ files: ['src/index.ts'] }),
    id: DEFERRED_TOOL_ID,
    inputSchema: z.object({}),
  });
}

function createProcessor(): BrainstrikeToolSearchProcessor {
  return new BrainstrikeToolSearchProcessor({
    deferredTools: { [DEFERRED_TOOL_ID]: createDeferredTool() },
    toolNameMap: new Map([[DEFERRED_TOOL_ID, 'brainstrike.listWorkspaceContext']]),
  });
}

function createStepArgs(
  options: {
    readonly messageList?: MessageList;
    readonly stepNumber?: number;
    readonly threadId?: unknown;
  } = {}
): ProcessInputStepArgs {
  const messageList = options.messageList ?? new MessageList();
  const requestContext = options.threadId === undefined ? undefined : new RequestContext();
  requestContext?.set(MASTRA_THREAD_ID_KEY, options.threadId);
  return {
    abort(reason?: string): never {
      throw new Error(reason ?? 'processor aborted');
    },
    messageList,
    messages: messageList.get.all.db(),
    model: 'openai/gpt-5.6-terra',
    ...(requestContext ? { requestContext } : {}),
    retryCount: 0,
    state: {},
    stepNumber: options.stepNumber ?? 0,
    steps: [],
    systemMessages: [],
    tools: {},
  };
}

function createPersistedSearchResultMessage(): MastraDBMessage {
  return {
    content: {
      format: 2,
      parts: [
        {
          toolInvocation: {
            args: { query: 'workspace context' },
            result: {
              message: `Found and loaded 1 tool(s): ${DEFERRED_TOOL_ID}.`,
              results: [
                {
                  description: 'List workspace context',
                  name: DEFERRED_TOOL_ID,
                  score: 1,
                },
              ],
            },
            state: 'result',
            toolCallId: 'search-1',
            toolName: 'search_tools',
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date(),
    id: 'assistant-search-1',
    role: 'assistant',
  };
}

describe('BrainstrikeToolSearchProcessor', () => {
  it('starts with search only, auto-loads top matches, then appends the deferred tool', async () => {
    const processor = createProcessor();
    const first = await processor.processInputStep(createStepArgs({ threadId: 'thread-1' }));

    expect(Object.keys(first.tools)).toEqual(['search_tools']);
    await expect(
      first.tools.search_tools.execute?.({ query: 'workspace context' })
    ).resolves.toMatchObject({
      results: [{ name: DEFERRED_TOOL_ID }],
    });

    const second = await processor.processInputStep(
      createStepArgs({ stepNumber: 1, threadId: 'thread-1' })
    );
    expect(Object.keys(second.tools)).toEqual(['search_tools', DEFERRED_TOOL_ID]);
  });

  it('reconstructs loaded tools from persisted search results after processor restart', async () => {
    const persistedMessages = new MessageList();
    persistedMessages.add(createPersistedSearchResultMessage(), 'memory');

    const restartedProcessor = createProcessor();
    const result = await restartedProcessor.processInputStep(
      createStepArgs({ messageList: persistedMessages, threadId: 'thread-1' })
    );

    expect(Object.keys(result.tools)).toEqual(['search_tools', DEFERRED_TOOL_ID]);
  });

  it('does not share anonymous loaded state through a default thread', async () => {
    const processor = createProcessor();
    const first = await processor.processInputStep(createStepArgs());
    await first.tools.search_tools.execute?.({ query: 'workspace context' });

    const unrelatedAnonymousStep = await processor.processInputStep(createStepArgs());
    expect(Object.keys(unrelatedAnonymousStep.tools)).toEqual(['search_tools']);
  });

  it('fails visibly when request context contains an invalid thread id', async () => {
    const processor = createProcessor();

    await expect(
      processor.processInputStep(createStepArgs({ threadId: 42 }))
    ).rejects.toMatchObject({
      code: 'mastra_agent_tool_discovery_failure',
      context: { phase: 'context-trimming' },
    });
  });

  it('fails visibly when context trimming removes a loaded-tool result mid-runtime', async () => {
    const processor = createProcessor();
    const persistedMessages = new MessageList();
    persistedMessages.add(createPersistedSearchResultMessage(), 'memory');
    await processor.processInputStep(
      createStepArgs({ messageList: persistedMessages, threadId: 'thread-1' })
    );

    let received: unknown;
    try {
      await processor.processInputStep(createStepArgs({ stepNumber: 1, threadId: 'thread-1' }));
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(MastraAgentError);
    expect(received).toMatchObject({
      code: 'mastra_agent_tool_discovery_failure',
      context: {
        invalidatedToolIds: ['brainstrike.listWorkspaceContext'],
        phase: 'context-trimming',
      },
    });
  });
});
