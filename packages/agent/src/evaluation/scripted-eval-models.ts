import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';

/**
 * Deterministic LanguageModelV2 fixtures for the agent-behavior eval suite
 * (BST-589). Injected via createMastraAgentRuntime's modelOverride so the
 * REAL Agent (tools, instructions, gates) runs with zero network and zero
 * LLM cost. Mirrors the scripted model in
 * mastra-tool-execution.integration.spec.ts.
 */

function streamOf(parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

const BASE_MODEL = {
  modelId: 'scripted-eval-model',
  provider: 'fake',
  specificationVersion: 'v2',
  supportedUrls: {},
} as const;

const FINISH_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as const;

function toolNamesOf(options: LanguageModelV2CallOptions): string[] {
  const tools = (options as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) =>
      tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined
    )
    .filter((name): name is string => typeof name === 'string');
}

function textOnlyParts(text: string): LanguageModelV2StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 'text-1', type: 'text-start' },
    { delta: text, id: 'text-1', type: 'text-delta' },
    { id: 'text-1', type: 'text-end' },
    { finishReason: 'stop', type: 'finish', usage: FINISH_USAGE },
  ];
}

/**
 * Calls `toolName` with `input` on the first step, then answers with
 * `finalText` once the prompt contains the tool result.
 */
export function createToolCallingEvalModel(args: {
  finalText: string;
  input: string;
  toolName: string;
}): LanguageModelV2 {
  return {
    ...BASE_MODEL,
    // runEvals drives agent.generate() → doGenerate; the streaming path stays
    // for harnesses that pump fullStream. Both follow the same two-step script.
    doGenerate: (options: LanguageModelV2CallOptions) => {
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
      if (promptHasToolResult) {
        return Promise.resolve({
          content: [{ text: args.finalText, type: 'text' as const }],
          finishReason: 'stop' as const,
          usage: FINISH_USAGE,
          warnings: [],
        });
      }
      return Promise.resolve({
        content: [
          {
            input: args.input,
            toolCallId: 'eval-tool-call-1',
            toolName: args.toolName,
            type: 'tool-call' as const,
          },
        ],
        finishReason: 'tool-calls' as const,
        usage: FINISH_USAGE,
        warnings: [],
      });
    },
    doStream: (options: LanguageModelV2CallOptions) => {
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
      if (promptHasToolResult) {
        return Promise.resolve({ stream: streamOf(textOnlyParts(args.finalText)) });
      }
      return Promise.resolve({
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          {
            input: args.input,
            toolCallId: 'eval-tool-call-1',
            toolName: args.toolName,
            type: 'tool-call',
          },
          { finishReason: 'tool-calls', type: 'finish', usage: FINISH_USAGE },
        ]),
      });
    },
  } as LanguageModelV2;
}

/**
 * Selects the forbidden tool when it is visible, otherwise the safe tool.
 * A plan-mode regression therefore turns into a deterministic gate failure.
 */
export function createPlanModeInventoryEvalModel(args: {
  finalText: string;
  forbiddenInput: string;
  forbiddenToolName: string;
  safeInput: string;
  safeToolName: string;
}): LanguageModelV2 {
  function selection(options: LanguageModelV2CallOptions): {
    input: string;
    toolName: string;
  } {
    if (toolNamesOf(options).includes(args.forbiddenToolName)) {
      return { input: args.forbiddenInput, toolName: args.forbiddenToolName };
    }
    return { input: args.safeInput, toolName: args.safeToolName };
  }

  return {
    ...BASE_MODEL,
    doGenerate: (options: LanguageModelV2CallOptions) => {
      if (
        Array.isArray(options.prompt) &&
        options.prompt.some((message) => message.role === 'tool')
      ) {
        return Promise.resolve({
          content: [{ text: args.finalText, type: 'text' as const }],
          finishReason: 'stop' as const,
          usage: FINISH_USAGE,
          warnings: [],
        });
      }
      const selected = selection(options);
      return Promise.resolve({
        content: [
          {
            input: selected.input,
            toolCallId: 'eval-plan-mode-tool-call-1',
            toolName: selected.toolName,
            type: 'tool-call' as const,
          },
        ],
        finishReason: 'tool-calls' as const,
        usage: FINISH_USAGE,
        warnings: [],
      });
    },
    doStream: (options: LanguageModelV2CallOptions) => {
      if (
        Array.isArray(options.prompt) &&
        options.prompt.some((message) => message.role === 'tool')
      ) {
        return Promise.resolve({ stream: streamOf(textOnlyParts(args.finalText)) });
      }
      const selected = selection(options);
      return Promise.resolve({
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          {
            input: selected.input,
            toolCallId: 'eval-plan-mode-tool-call-1',
            toolName: selected.toolName,
            type: 'tool-call',
          },
          { finishReason: 'tool-calls', type: 'finish', usage: FINISH_USAGE },
        ]),
      });
    },
  } as LanguageModelV2;
}

/** Answers directly WITHOUT calling any tool — the misbehaving control. */
export function createTextOnlyEvalModel(text: string): LanguageModelV2 {
  return {
    ...BASE_MODEL,
    doGenerate: () =>
      Promise.resolve({
        content: [{ text, type: 'text' as const }],
        finishReason: 'stop' as const,
        usage: FINISH_USAGE,
        warnings: [],
      }),
    doStream: () => Promise.resolve({ stream: streamOf(textOnlyParts(text)) }),
  } as LanguageModelV2;
}
