import type { RuntimeData } from '@brainstrike/agent';
import {
  isSupportedProvider,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';

export interface DesktopMemoryModelTargetDescriptor {
  readonly model: string;
  readonly provider: SupportedProvider;
}

export interface DesktopObservationalMemoryModelTarget extends DesktopMemoryModelTargetDescriptor {
  readonly apiKey: string;
  readonly cacheKey: string;
}

export type DesktopMemoryModelTargetResolution<T extends DesktopMemoryModelTargetDescriptor> =
  | { readonly kind: 'disabled' }
  | {
      readonly descriptor: T;
      readonly kind: 'needs_async_resolution';
    }
  | {
      readonly kind: 'resolved';
      readonly target: T & { readonly apiKey: string; readonly cacheKey: string };
    };

export type RuntimeMemoryOptions = NonNullable<RuntimeData['memory']>['memoryOptions'];

// All four need a key.
const DESKTOP_OBSERVATIONAL_MEMORY_PROVIDERS = new Set<SupportedProvider>([
  'openai',
  'anthropic',
  'google',
  'openrouter',
]);
export function resolveRequestedProvider(
  data: RuntimeData | undefined
): SupportedProvider | undefined {
  const raw = typeof data?.provider === 'string' ? data.provider.trim() : '';
  if (!raw) {
    return;
  }

  const normalized = raw.toLowerCase();
  return isSupportedProvider(normalized) ? normalized : undefined;
}

function parseModelTarget(
  modelTarget: string,
  {
    allowedProviders,
    formatLabel,
    unsupportedProviderLabel,
    disallowedProviderMessage,
  }: {
    readonly allowedProviders: ReadonlySet<SupportedProvider>;
    readonly disallowedProviderMessage: (provider: SupportedProvider) => string;
    readonly formatLabel: string;
    readonly unsupportedProviderLabel: string;
  }
): DesktopMemoryModelTargetDescriptor {
  const trimmed = modelTarget.trim();
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(`${formatLabel} must use provider/model format; received "${modelTarget}".`);
  }

  const provider = trimmed.slice(0, separatorIndex).toLowerCase();
  const model = trimmed.slice(separatorIndex + 1).trim();
  if (!isSupportedProvider(provider)) {
    throw new Error(
      `Unsupported ${unsupportedProviderLabel} provider "${provider}" in model target "${modelTarget}".`
    );
  }
  if (!allowedProviders.has(provider)) {
    throw new Error(disallowedProviderMessage(provider));
  }

  return { model, provider };
}

export function parseObservationalMemoryModelTarget(
  modelTarget: string
): DesktopMemoryModelTargetDescriptor {
  return parseModelTarget(modelTarget, {
    allowedProviders: DESKTOP_OBSERVATIONAL_MEMORY_PROVIDERS,
    disallowedProviderMessage: (provider) =>
      `Desktop observational memory requires a hosted model provider; received "${provider}" in "${modelTarget}".`,
    formatLabel: 'Observational memory model target',
    unsupportedProviderLabel: 'observational memory',
  });
}
