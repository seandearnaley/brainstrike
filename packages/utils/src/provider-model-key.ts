const PROVIDER_SEPARATOR = '::';
const LEGACY_SEPARATOR = ':';

export interface ParsedProviderModelKey<Provider extends string = string> {
  modelId: string;
  provider: Provider;
}

export function formatProviderModelKey<Provider extends string>(
  provider: Provider,
  modelId: string
): string {
  return `${provider}${PROVIDER_SEPARATOR}${modelId}`;
}

export function parseProviderModelKey<Provider extends string = string>(
  composite: string | null | undefined
): ParsedProviderModelKey<Provider> | null {
  if (!composite) {
    return null;
  }

  if (composite.includes(PROVIDER_SEPARATOR)) {
    const separatorIndex = composite.indexOf(PROVIDER_SEPARATOR);
    const provider = composite.slice(0, separatorIndex).trim();
    const modelId = composite.slice(separatorIndex + PROVIDER_SEPARATOR.length).trim();
    if (!(provider && modelId)) {
      return null;
    }
    return {
      modelId,
      provider: provider as Provider,
    };
  }

  const legacyIndex = composite.indexOf(LEGACY_SEPARATOR);
  if (legacyIndex > 0 && legacyIndex < composite.length - 1) {
    const provider = composite.slice(0, legacyIndex).trim();
    const modelId = composite.slice(legacyIndex + 1).trim();
    if (!(provider && modelId)) {
      return null;
    }
    return {
      modelId,
      provider: provider as Provider,
    };
  }

  return null;
}

export function canonicalizeProviderModelKey<Provider extends string = string>(
  modelKey: string | null | undefined,
  options?: {
    fallbackProvider?: Provider;
    providerHint?: Provider;
  }
): { composite: string; modelId: string; provider: Provider } | null {
  const parsed = parseProviderModelKey<Provider>(modelKey);
  const provider = parsed?.provider ?? options?.providerHint ?? options?.fallbackProvider;
  const rawModelId = parsed?.modelId ?? modelKey?.trim() ?? '';
  if (!(provider && rawModelId)) {
    return null;
  }
  return {
    composite: formatProviderModelKey(provider, rawModelId),
    modelId: rawModelId,
    provider,
  };
}
