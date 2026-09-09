import type { LanguageModel } from '@mastra/core/llm';

// Derive the supported wire contract from Mastra's public model type. The
// separately installed AI SDK's historical V2 metadata type is not identical.
type ScriptedModel = Extract<LanguageModel, { specificationVersion: 'v2' }>;
type LanguageModelV2CallOptions = Parameters<ScriptedModel['doStream']>[0];
type ModelStream = Awaited<ReturnType<ScriptedModel['doStream']>>['stream'];
type LanguageModelV2StreamPart = ModelStream extends ReadableStream<infer Part> ? Part : never;

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

export function toolCallParts(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>
): LanguageModelV2StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { input: JSON.stringify(args), toolCallId, toolName, type: 'tool-call' },
    { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
  ];
}

export function textParts(text: string): LanguageModelV2StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 'answer', type: 'text-start' },
    { delta: text, id: 'answer', type: 'text-delta' },
    { id: 'answer', type: 'text-end' },
    { finishReason: 'stop', type: 'finish', usage: USAGE },
  ];
}

/** A model transport fixture: Agent, tools, hooks, streams and storage stay real. */
export function scriptedAgentModel(
  script: (options: LanguageModelV2CallOptions) => LanguageModelV2StreamPart[]
): { model: ScriptedModel; prompts: LanguageModelV2CallOptions[] } {
  const prompts: LanguageModelV2CallOptions[] = [];
  const model: ScriptedModel = {
    doGenerate: () => Promise.reject(new Error('Unexpected non-streaming model call')),
    doStream: async (options) => {
      prompts.push(options);
      const parts = script(options);
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      };
    },
    modelId: 'scripted-delegation',
    provider: 'test',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
  return { model, prompts };
}

export function hasToolResult(options: LanguageModelV2CallOptions, toolName: string): boolean {
  return options.prompt.some(
    (message) =>
      message.role === 'tool' && message.content.some((part) => part.toolName === toolName)
  );
}

export function toolThenAnswer(toolName: string, callId: string, args: Record<string, unknown>) {
  return scriptedAgentModel((options) =>
    hasToolResult(options, toolName)
      ? textParts(`${callId} answered`)
      : toolCallParts(toolName, callId, args)
  );
}
