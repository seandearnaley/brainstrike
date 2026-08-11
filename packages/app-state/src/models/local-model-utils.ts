const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['local', 'transformers']);

export interface LocalModelLike {
  capabilities?: {
    type?: unknown;
  } | null;
  isEnabled?: unknown;
  providerId?: unknown;
}

export function isLocalModelProviderId(providerId: string): boolean {
  return LOCAL_PROVIDER_IDS.has(providerId);
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
