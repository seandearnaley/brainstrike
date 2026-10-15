import { createRequire } from 'node:module';
import { ProjectionSafeToolCallFilter } from '../../../../packages/agent/src/mastra-processors/projection-safe-tool-call-filter.ts';

type Input = Parameters<ProjectionSafeToolCallFilter['processInputStep']>[0];
type Request = Parameters<ProjectionSafeToolCallFilter['processLLMRequest']>[0];
const requireAgent = createRequire(
  new URL('../../../../packages/agent/package.json', import.meta.url)
);
const MessageList = requireAgent('@mastra/core/agent')
  .MessageList as new () => Input['messageList'];

/** Derive exact replay text through the existing production processor, not a header heuristic. */
export function canonicalArtifactReplayTexts(observed: {
  readonly content: string;
  readonly name: string;
  readonly toolCallId: string;
}): readonly string[] {
  // This wire content already is the JSON projection's serialized model text.
  const output = { type: 'text' as const, value: observed.content };
  const message = {
    content: {
      format: 2,
      parts: [
        { type: 'step-start' },
        {
          providerMetadata: { mastra: { modelOutput: output } },
          toolInvocation: {
            args: {},
            result: observed.content,
            state: 'result',
            toolCallId: observed.toolCallId,
            toolName: observed.name,
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date(0),
    id: observed.toolCallId,
    role: 'assistant',
  } as Input['messages'][number];
  const prompt: Request['prompt'] = [
    {
      content: [
        { input: {}, toolCallId: observed.toolCallId, toolName: observed.name, type: 'tool-call' },
      ],
      role: 'assistant',
    },
    {
      content: [
        { output, toolCallId: observed.toolCallId, toolName: observed.name, type: 'tool-result' },
      ],
      role: 'tool',
    },
  ];
  const processor = new ProjectionSafeToolCallFilter({
    filterAfterToolSteps: 0,
    logger: { info: () => {} },
    toolNameMap: new Map([[observed.name, 'brainstrike.readToolOutputArtifact']]),
  });
  const state: Record<string, unknown> = {};
  const model = {} as Input['model'];
  const abort = (reason?: string): never => {
    throw new Error(reason ?? 'Replay processor aborted.');
  };
  processor.processInputStep({
    abort,
    messageList: new MessageList(),
    messages: [message],
    model,
    retryCount: 0,
    state,
    stepNumber: 0,
    steps: [],
    systemMessages: [],
  });
  const transformed = processor.processLLMRequest({
    abort,
    model: model as Request['model'],
    prompt,
    retryCount: 0,
    state,
    stepNumber: 0,
    steps: [],
  });
  if (!transformed?.prompt) {
    throw new Error('Production processor supplied no artifact replay prompt.');
  }
  const texts = transformed.prompt.flatMap((entry) =>
    entry.role === 'user' && Array.isArray(entry.content)
      ? entry.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : []
  );
  if (texts.length !== 1) {
    throw new Error('Production processor did not produce one canonical artifact replay.');
  }
  return texts;
}

export function isObservedArtifactReplay(
  message: unknown,
  knownTexts: ReadonlySet<string>
): boolean {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('role' in message) ||
    message.role !== 'user' ||
    !('content' in message)
  ) {
    return false;
  }
  if (typeof message.content === 'string') {
    return knownTexts.has(message.content);
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }
  return message.content.every(
    (part: unknown) =>
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string' &&
      Object.keys(part).every((key) => key === 'type' || key === 'text') &&
      knownTexts.has(part.text)
  );
}
