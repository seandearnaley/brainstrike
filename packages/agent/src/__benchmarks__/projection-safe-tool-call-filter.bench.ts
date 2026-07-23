import { createHash } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { ProcessInputStepArgs, ProcessLLMRequestArgs } from '@mastra/core/processors';
import { bench, describe } from 'vitest';
import { ProjectionSafeToolCallFilter } from '../mastra/projection-safe-tool-call-filter';

const FILTER_STATE_KEY = 'brainstrikeProjectionSafeToolCallFilter';
const MESSAGE_COUNT = 5000;
const EXPECTED_PROMPT_CHECKSUM = 'e6109dde6dced0e9ea57167fed6c18446761ee7ea7f9f8a6072ecc3fee6b3876';
const READ_TOOL = 'brainstrike_readWorkspaceFile';
const TOOL_NAME_MAP = new Map([[READ_TOOL, 'brainstrike.readWorkspaceFile']]);
const model = {} as ProcessInputStepArgs['model'];
const abort = (reason?: string): never => {
  throw new Error(reason ?? 'processor aborted');
};

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readSafeToolCallCount(state: Record<string, unknown>): number {
  const filterState = state[FILTER_STATE_KEY];
  if (!(filterState && typeof filterState === 'object' && !Array.isArray(filterState))) {
    throw new Error('benchmark scan produced no projection filter state');
  }
  const safeToolCallIds = Reflect.get(filterState, 'safeToolCallIds');
  const ineligibleToolCallCount = Reflect.get(filterState, 'ineligibleToolCallCount');
  const recentToolCallCount = Reflect.get(filterState, 'recentToolCallCount');
  if (
    !Array.isArray(safeToolCallIds) ||
    safeToolCallIds.length !== MESSAGE_COUNT ||
    ineligibleToolCallCount !== 0 ||
    recentToolCallCount !== 0
  ) {
    throw new Error('benchmark scan produced unexpected projection filter state');
  }
  return safeToolCallIds.length;
}

function createStoredMessage(index: number): MastraDBMessage {
  return {
    content: {
      format: 2,
      parts: [
        { type: 'step-start' },
        { text: 'continue', type: 'text' },
        {
          providerMetadata: {
            mastra: { modelOutput: { type: 'text', value: `projection-${index}` } },
          },
          toolInvocation: {
            args: { path: `file-${index}.ts` },
            result: { content: `raw-${index}` },
            state: 'result',
            toolCallId: `call-${index}`,
            toolName: READ_TOOL,
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date('2026-07-23T12:00:00.000Z'),
    id: `message-${index}`,
    role: 'assistant',
  } as MastraDBMessage;
}

const storedMessages = Array.from({ length: MESSAGE_COUNT }, (_, index) =>
  createStoredMessage(index)
);
const prompt = storedMessages.flatMap((_, index) => [
  {
    content: [
      { text: 'continue', type: 'text' as const },
      {
        input: { path: `file-${index}.ts` },
        toolCallId: `call-${index}`,
        toolName: READ_TOOL,
        type: 'tool-call' as const,
      },
    ],
    role: 'assistant' as const,
  },
  {
    content: [
      {
        output: { type: 'text' as const, value: `projection-${index}` },
        toolCallId: `call-${index}`,
        toolName: READ_TOOL,
        type: 'tool-result' as const,
      },
    ],
    role: 'tool' as const,
  },
]) as ProcessLLMRequestArgs['prompt'];
const processor = new ProjectionSafeToolCallFilter({
  filterAfterToolSteps: 0,
  logger: { info: () => undefined },
  toolNameMap: TOOL_NAME_MAP,
});
const state: Record<string, unknown> = {};
processor.processInputStep({
  abort,
  messageList: {} as ProcessInputStepArgs['messageList'],
  messages: storedMessages,
  model,
  retryCount: 0,
  state,
  stepNumber: 0,
  steps: [],
  systemMessages: [],
});
const projectedPrompt = processor.processLLMRequest({
  abort,
  model: model as ProcessLLMRequestArgs['model'],
  prompt,
  retryCount: 0,
  state,
  stepNumber: 0,
  steps: [],
})?.prompt;
const promptChecksum = checksum(projectedPrompt);
if (promptChecksum !== EXPECTED_PROMPT_CHECKSUM) {
  throw new Error(
    `benchmark projected prompt checksum changed: expected ${EXPECTED_PROMPT_CHECKSUM}, received ${promptChecksum}`
  );
}
readSafeToolCallCount(state);

describe('ProjectionSafeToolCallFilter 5,000-message allocation fixture', () => {
  bench('scan stored history', () => {
    const iterationState: Record<string, unknown> = {};
    processor.processInputStep({
      abort,
      messageList: {} as ProcessInputStepArgs['messageList'],
      messages: storedMessages,
      model,
      retryCount: 0,
      state: iterationState,
      stepNumber: 0,
      steps: [],
      systemMessages: [],
    });
    readSafeToolCallCount(iterationState);
  });

  bench('rewrite provider prompt', () => {
    const result = processor.processLLMRequest({
      abort,
      model: model as ProcessLLMRequestArgs['model'],
      prompt,
      retryCount: 0,
      state,
      stepNumber: 0,
      steps: [],
    });
    if (result?.prompt?.length !== MESSAGE_COUNT) {
      throw new Error('benchmark prompt rewrite produced unexpected message count');
    }
  });
});
