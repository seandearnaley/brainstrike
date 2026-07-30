import { PROVIDER_DEFAULT_MODELS, type RuntimeData } from '@brainstrike/agent';
import { type AssistantLlmHostManager, createMainLlmHostClient } from './ports.js';

export function isLocalChatProvider(runtimeData: RuntimeData | undefined): boolean {
  const provider = typeof runtimeData?.provider === 'string' ? runtimeData.provider.trim() : '';
  return provider.toLowerCase() === 'local';
}

/** Model id from a 'local/<modelId>' observational-memory target, if active. */
function resolveLocalObservationalMemoryModelId(
  runtimeData: RuntimeData | undefined
): string | undefined {
  const observationalMemory = runtimeData?.memory?.memorySettings?.observationalMemory;
  if (!observationalMemory?.enabled) {
    return;
  }
  const target = observationalMemory.modelTarget?.trim() ?? '';
  if (!target.toLowerCase().startsWith('local/')) {
    return;
  }
  const modelId = target.slice('local/'.length).trim();
  return modelId.length > 0 ? modelId : undefined;
}

export function resolveLocalLlmHostClient(
  runtimeData: RuntimeData | undefined,
  toolDependencies: {
    readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
  }
): ReturnType<typeof createMainLlmHostClient> | undefined {
  const needsClient =
    isLocalChatProvider(runtimeData) ||
    resolveLocalObservationalMemoryModelId(runtimeData) !== undefined;
  if (!needsClient) {
    return;
  }
  const manager = toolDependencies.llmHostManager;
  if (!manager) {
    throw new Error(
      'The built-in local model requires the llm-host manager; the assistant server was started without one.'
    );
  }
  return createMainLlmHostClient(manager);
}

function resolveLocalModelId(runtimeData: RuntimeData | undefined): string {
  const requested = typeof runtimeData?.model === 'string' ? runtimeData.model.trim() : '';
  if (requested.length > 0) {
    return requested;
  }
  const fallback = PROVIDER_DEFAULT_MODELS['local'];
  if (!fallback) {
    throw new Error('No default model is registered for the local provider.');
  }
  return fallback;
}

/**
 * Every local model this request will drive (chat and/or memory), deduped.
 *
 * SINGLE-ENGINE ASSUMPTION: the llm-host backend holds ONE engine, so warming
 * model A then model B unloads A. With today's catalog (one Gemma spec) chat
 * and local-OM targets always dedupe to one id; if the local catalog grows a
 * second spec, differing chat/OM targets would thrash (warm A → warm B
 * unloads A → the chat generation reloads A → the OM observation reloads B…).
 */
export function collectLocalLlmWarmupModelIds(runtimeData: RuntimeData | undefined): string[] {
  const modelIds = new Set<string>();
  if (isLocalChatProvider(runtimeData)) {
    modelIds.add(resolveLocalModelId(runtimeData));
  }
  const memoryModelId = resolveLocalObservationalMemoryModelId(runtimeData);
  if (memoryModelId) {
    modelIds.add(memoryModelId);
  }
  return [...modelIds];
}
