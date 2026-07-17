import type {
  LocalRuntimeNormalizedModel,
  LocalRuntimeOllamaCapabilitiesResult,
} from './local-runtime-model-catalog-types.js';

export type OllamaCapabilityHydrationOutcome =
  | {
      readonly models: readonly LocalRuntimeNormalizedModel[];
      readonly ok: true;
    }
  | {
      readonly message: string;
      readonly ok: false;
    };

export async function hydrateOllamaModelCapabilities(
  models: readonly LocalRuntimeNormalizedModel[],
  resolveCapabilities: (modelId: string) => Promise<LocalRuntimeOllamaCapabilitiesResult>
): Promise<OllamaCapabilityHydrationOutcome> {
  const results = await Promise.all(
    models.map(async (model) => ({
      model,
      resolved: await resolveCapabilities(model.modelId),
    }))
  );

  const unavailable = results.find(({ resolved }) => resolved.state === 'unavailable');
  if (unavailable?.resolved.state === 'unavailable') {
    return {
      message: `Ollama capability lookup failed for "${unavailable.model.modelId}" at ${unavailable.resolved.endpoint}: ${unavailable.resolved.message}`,
      ok: false,
    };
  }

  return {
    models: results.map(({ model, resolved }) => {
      if (resolved.state !== 'resolved') {
        throw new Error(`Unexpected Ollama capability state for ${model.modelId}`);
      }
      return {
        ...model,
        capabilities: {
          embeddings: resolved.embedding ? 'supported' : 'unsupported',
          llm: resolved.llm,
          vision: resolved.vision ? 'supported' : 'unsupported',
        },
        capabilitySource: 'provider_reported',
        dimensionsKnown: {
          state: resolved.embedding ? 'needs_verification' : 'not_applicable',
        },
      } satisfies LocalRuntimeNormalizedModel;
    }),
    ok: true,
  };
}
