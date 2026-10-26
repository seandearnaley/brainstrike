/** Canonical generation settings shared by the legacy loop and the SDK host. */
import {
  listProviderLlmModels,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
} from '@brainstrike/assistant-contract';
import type { RuntimeData } from '../types.ts';
import { getDefaultModel } from './provider-factory.ts';

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
  }
  return modelSettings ? { modelSettings } : {};
}
