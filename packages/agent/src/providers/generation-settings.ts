/** Canonical generation settings shared by the legacy loop and the SDK host. */
import {
  getLlmModelDefinition,
  listProviderLlmModels,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
} from '@brainstrike/assistant-contract';
import { createMastraAgentError } from '../mastra/mastra-agent-error';
import type { RuntimeData } from '../types';
import { getDefaultModel } from './provider-factory';

/**
 * Default OpenRouter output window when the client sent no explicit
 * `modelSettings.maxOutputTokens` (BST-1170). Reasoning tokens are output
 * tokens on OpenRouter, so the window is sized for the reasoning state the
 * request actually carries: an active-reasoning request on a catalogued model
 * with a vendor-documented completion window reserves that window; everything
 * else keeps the coding ceiling. Undeclared routes have no recorded facts and
 * keep the ceiling — the base contract, not a per-model guess.
 */
function resolveOpenRouterBackstopMaxOutputTokens(runtimeData: RuntimeData): number {
  const modelId = runtimeData.model?.trim() || getDefaultModel('openrouter');
  const definition = listProviderLlmModels('openrouter').find(({ id }) => id === modelId);
  if (!definition) {
    return resolveOpenRouterCodingMaxOutputTokens();
  }
  const reasoning = runtimeData.providerOptions?.openrouter?.reasoning;
  const explicitEffort = reasoning?.enabled === false ? 'none' : reasoning?.effort;
  return resolveOpenRouterOutputWindow(
    definition,
    resolveOpenRouterReasoningActive(definition, explicitEffort)
  );
}

export function buildModelSettingsOption(runtimeData: RuntimeData | undefined): {
  modelSettings?: RuntimeData['modelSettings'];
} {
  let modelSettings = runtimeData?.modelSettings;
  if (runtimeData?.provider === 'openrouter') {
    modelSettings = {
      maxOutputTokens: resolveOpenRouterBackstopMaxOutputTokens(runtimeData),
      ...modelSettings,
    };
  } else if (runtimeData?.provider === 'local') {
    const modelId = runtimeData.model?.trim() || getDefaultModel('local');
    const definition = getLlmModelDefinition('local', modelId);
    if (definition.maxOutputTokens === undefined) {
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { model: modelId, provider: 'local' },
        detail: `Local model ${modelId} has no maxOutputTokens registry budget`,
      });
    }
    modelSettings = {
      maxOutputTokens: definition.maxOutputTokens,
      ...modelSettings,
    };
  }
  return modelSettings ? { modelSettings } : {};
}

/**
 * Keep Brainstrike's local-server transport settings out of Mastra generation
 * options. Mastra namespaces compatible-provider options by the model id's
 * first segment, so forwarding `providerOptions.ollama` or `.lmstudio` would
 * serialize `baseUrl` and `apiToken` into the chat-completions request body.
 */
export function buildGenerationProviderOptionsOption(runtimeData: RuntimeData | undefined): {
  providerOptions?: RuntimeData['providerOptions'];
} {
  const providerOptions = runtimeData?.providerOptions;
  if (!providerOptions) {
    return {};
  }
  if (providerOptions.ollama === undefined && providerOptions.lmstudio === undefined) {
    return { providerOptions };
  }

  const generationProviderOptions = Object.fromEntries(
    Object.entries(providerOptions).filter(
      ([namespace]) => namespace !== 'ollama' && namespace !== 'lmstudio'
    )
  ) as NonNullable<RuntimeData['providerOptions']>;
  if (Object.keys(generationProviderOptions).length === 0) {
    return {};
  }
  return { providerOptions: generationProviderOptions };
}
