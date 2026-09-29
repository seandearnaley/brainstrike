import type { AssistantChildInput } from './child-input.js';
import { findLlmModelDefinition, findProviderDefinition } from './provider-registry.js';

/** Same tri-state policy as the root composer: unknown routes retain visible provider errors. */
export function assertAssistantChildImageCapability(
  input: AssistantChildInput,
  provider: string | undefined,
  modelId: string | undefined
): void {
  if (!input.attachments?.length) {
    return;
  }
  if (!(provider && modelId)) {
    throw new Error('The child has no effective model for image input.');
  }
  const selectedProvider = findProviderDefinition(provider);
  if (!selectedProvider) {
    throw new Error('The child image provider is unavailable.');
  }
  if (
    provider === 'local' ||
    findLlmModelDefinition(selectedProvider.id, modelId)?.vision === 'unsupported'
  ) {
    throw new Error(`${modelId} does not support image input for this child.`);
  }
}
