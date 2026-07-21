import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import type { ProcessInputStepArgs, ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it, vi } from 'vitest';
import { ProjectionSafeToolCallFilter } from '../mastra/projection-safe-tool-call-filter';

const READ_TOOL = 'brainstrike_readWorkspaceFile';
const TOOL_NAME_MAP = new Map([[READ_TOOL, 'brainstrike.readWorkspaceFile']]);

type MessageSource = Parameters<MessageList['add']>[1];

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === 'bigint' ? `${candidate}n` : candidate
  );
}

function createToolMessage(options: {
  id: string;
  modelOutput?: unknown;
  rawResult?: unknown;
  state?: string;
  toolCallId?: string;
  toolName?: string;
}): MastraDBMessage {
  const providerMetadata = Object.hasOwn(options, 'modelOutput')
    ? { mastra: { modelOutput: options.modelOutput } }
    : undefined;
  return {
    content: {
      format: 2,
      parts: [
        { type: 'step-start' },
        {
          ...(providerMetadata ? { providerMetadata } : {}),
          toolInvocation: {
            args: { path: `${options.id}.ts` },
            ...(Object.hasOwn(options, 'rawResult') ? { result: options.rawResult } : {}),
            state: options.state ?? 'result',
            toolCallId: options.toolCallId ?? `call-${options.id}`,
            toolName: options.toolName ?? READ_TOOL,
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date('2026-07-21T12:00:00.000Z'),
    id: options.id,
    role: 'assistant',
  } as MastraDBMessage;
}

function createTextMessage(id: string, text: string): MastraDBMessage {
  return {
    content: { format: 2, parts: [{ text, type: 'text' }] },
    createdAt: new Date('2026-07-21T12:00:00.000Z'),
    id,
    role: 'user',
  };
}

async function filterMessages(
  processor: ProjectionSafeToolCallFilter,
  messages: MastraDBMessage[],
  source: MessageSource
): Promise<{ inputAfter: string; output: ProcessLLMRequestArgs['prompt'] }> {
  const messageList = new MessageList();
  for (const message of messages) {
    messageList.add(structuredClone(message), source);
  }
  const inputBefore = serialize(messageList.get.all.db());
  const prompt = await messageList.get.all.aiV5.llmPrompt();
  const state: Record<string, unknown> = {};
  const abort = (reason?: string): never => {
    throw new Error(reason ?? 'processor aborted');
  };
  const model = {} as ProcessInputStepArgs['model'];
  const stepResult = processor.processInputStep({
    abort,
    messageList,
    messages: structuredClone(messages),
    model,
    retryCount: 0,
    state,
    stepNumber: 0,
    steps: [],
    systemMessages: [],
  });
  expect(stepResult).toBeUndefined();
  const result = processor.processLLMRequest({
    abort,
    model: model as ProcessLLMRequestArgs['model'],
    prompt: structuredClone(prompt),
    retryCount: 0,
    state,
    stepNumber: 0,
    steps: [],
  });
  expect(serialize(messageList.get.all.db())).toBe(inputBefore);
  return { inputAfter: inputBefore, output: result?.prompt ?? prompt };
}

describe('ProjectionSafeToolCallFilter', () => {
  it('filters only stale completed reads and keeps two recent tool-producing steps', async () => {
    const processor = new ProjectionSafeToolCallFilter({ toolNameMap: TOOL_NAME_MAP });
    const messages = [
      createToolMessage({
        id: 'old',
        modelOutput: { type: 'text', value: 'compact old result' },
        rawResult: { body: 'raw-old-sentinel' },
      }),
      createTextMessage('user-between', 'Continue with the next two reads.'),
      createToolMessage({
        id: 'recent-one',
        modelOutput: { type: 'text', value: 'compact recent one' },
        rawResult: { body: 'raw-recent-one' },
      }),
      createToolMessage({
        id: 'recent-two',
        modelOutput: { type: 'text', value: 'compact recent two' },
        rawResult: { body: 'raw-recent-two' },
      }),
    ];

    const hydrated = await filterMessages(processor, messages, 'memory');
    const live = await filterMessages(processor, messages, 'response');
    const output = JSON.stringify(hydrated.output);

    expect(JSON.stringify(live.output)).not.toContain('old.ts');
    expect(output).toContain('compact old result');
    expect(output).not.toContain('raw-old-sentinel');
    expect(output).not.toContain('old.ts');
    expect(output).toContain('recent-one.ts');
    expect(output).toContain('recent-two.ts');
    expect(output).toContain('Continue with the next two reads.');
  });

  it.each([
    {
      label: 'missing model projection',
      message: createToolMessage({ id: 'missing', rawResult: { body: 'missing-projection' } }),
      sentinel: 'missing-projection',
    },
    {
      label: 'guarded error',
      message: createToolMessage({
        id: 'guarded-error',
        modelOutput: { type: 'text', value: 'compact error' },
        rawResult: {
          error: { code: 'tool_failed', message: 'read failed', toolName: READ_TOOL },
          ok: false,
          sentinel: 'guarded-error',
        },
      }),
      sentinel: 'guarded-error',
    },
    {
      label: 'domain availability error',
      message: createToolMessage({
        id: 'unavailable',
        modelOutput: { type: 'text', value: 'compact unavailable' },
        rawResult: { available: false, message: 'key required', sentinel: 'unavailable-error' },
      }),
      sentinel: 'unavailable-error',
    },
    {
      label: 'partial retrieval failure',
      message: createToolMessage({
        id: 'partial',
        modelOutput: { type: 'text', value: 'compact partial result' },
        rawResult: { failed: [{ reason: 'refused' }], sentinel: 'partial-error' },
        toolName: 'brainstrike_webExtract',
      }),
      sentinel: 'partial-error',
    },
    {
      label: 'multimodal projection',
      message: createToolMessage({
        id: 'multimodal',
        modelOutput: {
          type: 'content',
          value: [{ data: 'image-bytes', mediaType: 'image/png', type: 'media' }],
        },
        rawResult: { sentinel: 'multimodal-result' },
      }),
      sentinel: 'multimodal-result',
    },
    {
      label: 'non-serializable projection',
      message: createToolMessage({
        id: 'non-serializable',
        modelOutput: { value: 1n },
        rawResult: { sentinel: 'non-serializable-result' },
      }),
      sentinel: 'non-serializable-result',
    },
    {
      label: 'incomplete call',
      message: createToolMessage({ id: 'incomplete', state: 'call' }),
      sentinel: 'incomplete.ts',
    },
  ])('preserves $label verbatim', async ({ message, sentinel }) => {
    const processor = new ProjectionSafeToolCallFilter({
      filterAfterToolSteps: 0,
      toolNameMap: new Map([
        ...TOOL_NAME_MAP,
        ['brainstrike_webExtract', 'brainstrike.webExtract'],
      ]),
    });

    const { inputAfter, output } = await filterMessages(processor, [message], 'memory');
    expect(inputAfter).toContain(sentinel);
    if (output.length > 0 && message.content.parts?.[1]?.type === 'tool-invocation') {
      expect(serialize(output)).toContain(`${message.content.parts[1].toolInvocation.toolCallId}`);
    }
  });

  it.each([
    'brainstrike_stringReplaceWorkspaceFile',
    'brainstrike_executeCommand',
    'brainstrike_lspInspect',
    'brainstrike_manageTaskList',
    'search_tools',
    'load_tool',
    'custom_mcp_search',
  ])('never filters protected tool %s', async (toolName) => {
    const processor = new ProjectionSafeToolCallFilter({
      filterAfterToolSteps: 0,
      toolNameMap: new Map([[toolName, toolName.replace('brainstrike_', 'brainstrike.')]]),
    });
    const message = createToolMessage({
      id: toolName,
      modelOutput: { type: 'text', value: 'compact protected result' },
      rawResult: { sentinel: `raw-${toolName}` },
      toolName,
    });

    const { output } = await filterMessages(processor, [message], 'memory');
    expect(JSON.stringify(output)).toContain(`call-${toolName}`);
  });

  it('retains an artifact continuation action while removing old raw page bytes', async () => {
    const toolName = 'brainstrike_readToolOutputArtifact';
    const logger = { info: vi.fn() };
    const processor = new ProjectionSafeToolCallFilter({
      filterAfterToolSteps: 0,
      logger,
      toolNameMap: new Map([[toolName, 'brainstrike.readToolOutputArtifact']]),
    });
    const message = createToolMessage({
      id: 'artifact-page',
      modelOutput: {
        type: 'json',
        value: {
          content: 'bounded page',
          next: {
            input: { cursor: 'opaque-next-cursor' },
            tool: 'brainstrike.readToolOutputArtifact',
          },
        },
      },
      rawResult: { content: 'raw-artifact-page-sentinel' },
      toolName,
    });

    const { output } = await filterMessages(processor, [message], 'response');
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('raw-artifact-page-sentinel');
    expect(serialized).toContain('opaque-next-cursor');
    expect(serialized).toContain('brainstrike.readToolOutputArtifact');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'mastra_agent_tool_history_filtered',
        filteredToolCallCount: 1,
      }),
      'filtered stale tool history from provider input'
    );
  });
});
