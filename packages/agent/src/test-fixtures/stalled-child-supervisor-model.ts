import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';

/** A real supervisor delegation whose child model stream never emits or closes. */
export function createStalledChildSupervisorModel(delegationTool: string): LanguageModelV2 {
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: async (options) => {
      if (!options.tools?.some((tool) => tool.name === delegationTool)) {
        // Only the native loop's abort can end consumption of this hung child.
        return { stream: new ReadableStream<LanguageModelV2StreamPart>() };
      }
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              input: JSON.stringify({ prompt: 'find the flag' }),
              toolCallId: 'delegation-call-1',
              toolName: delegationTool,
              type: 'tool-call',
            });
            controller.enqueue({
              finishReason: 'tool-calls',
              type: 'finish',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}
