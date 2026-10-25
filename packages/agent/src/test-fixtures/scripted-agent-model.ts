import type { LanguageModel } from '@mastra/core/llm';

// Derive the supported wire contract from Mastra's public model type. The
// separately installed AI SDK's historical V2 metadata type is not identical.
type ScriptedModel = Extract<LanguageModel, { specificationVersion: 'v2' }>;
type LanguageModelV2CallOptions = Parameters<ScriptedModel['doStream']>[0];
type ModelStream = Awaited<ReturnType<ScriptedModel['doStream']>>['stream'];
type LanguageModelV2StreamPart = ModelStream extends ReadableStream<infer Part> ? Part : never;

/**
 * A model transport fixture: Agent, tools, hooks, streams and storage stay real.
 * An async script holds its model step until the test's gate opens.
 */
export function scriptedAgentModel(
  script: (
    options: LanguageModelV2CallOptions
  ) => LanguageModelV2StreamPart[] | Promise<LanguageModelV2StreamPart[]>
): { model: ScriptedModel; prompts: LanguageModelV2CallOptions[] } {
  const prompts: LanguageModelV2CallOptions[] = [];
  const model: ScriptedModel = {
    doGenerate: () => Promise.reject(new Error('Unexpected non-streaming model call')),
    doStream: async (options) => {
      prompts.push(options);
      const parts = await script(options);
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
