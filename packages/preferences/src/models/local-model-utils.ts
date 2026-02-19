const LOCAL_PROVIDER_IDS = new Set(['local', 'transformers'] as const);

export interface LocalModelLike {
  providerId?: unknown;
  isEnabled?: unknown;
  capabilities?: {
    type?: unknown;
  } | null;
}

export function isLocalModelProviderId(providerId: string): boolean {
  return LOCAL_PROVIDER_IDS.has(providerId as 'local' | 'transformers');
}

export function isEnabledLocalLlmModel(model: LocalModelLike): boolean {
  if (typeof model.providerId !== 'string') {
    return false;
  }

  return (
    isLocalModelProviderId(model.providerId) &&
    model.isEnabled === true &&
    model.capabilities?.type === 'llm'
  );
}

export function hasEnabledLocalLlmModels(models: readonly LocalModelLike[]): boolean {
  return models.some((model) => isEnabledLocalLlmModel(model));
}
