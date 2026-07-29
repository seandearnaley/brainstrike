import type { RuntimeData } from '@brainstrike/agent';
import {
  isSupportedProvider,
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  type RuntimeAssistantMemorySettings,
} from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';

export interface DesktopMemoryModelTargetDescriptor {
  readonly model: string;
  readonly provider: SupportedProvider;
}

export interface DesktopObservationalMemoryModelTarget extends DesktopMemoryModelTargetDescriptor {
  readonly apiKey: string;
  readonly cacheKey: string;
}

export interface DesktopSemanticRecallEmbeddingModelTarget
  extends DesktopMemoryModelTargetDescriptor {
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

const DESKTOP_OBSERVATIONAL_MEMORY_PROVIDERS = new Set<SupportedProvider>([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  // Built-in local model: resolved to the llm-host proxy chat model (no API
  // key); requires the llm-host manager to be injected into the runtime.
  'local',
]);
const DESKTOP_SEMANTIC_RECALL_EMBEDDING_PROVIDERS = new Set<SupportedProvider>([
  'openai',
  'google',
  // Built-in local embedders: proxied to the hidden embedding-host renderer
  // (no API key); requires the embedding host manager.
  'local',
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
export function parseModelTarget(
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
      `Desktop observational memory requires a hosted model provider or the built-in local model; received "${provider}" in "${modelTarget}".`,
    formatLabel: 'Observational memory model target',
    unsupportedProviderLabel: 'observational memory',
  });
}
/**
 * The {provider, model} the OM observer/reflector actually runs on this
 * request, for attributing child-run-usage rows (BST-953). Undefined when OM
 * is off or the target is unresolvable — in that state no observer runs, so no
 * OM usage chunks can arrive; a chunk that somehow does is dropped with a
 * visible warn by the persister rather than written under a guessed model.
 */
export function resolveDesktopObserverUsageTarget(
  memorySettings: RuntimeAssistantMemorySettings | undefined
): { readonly model: string; readonly provider: string } | undefined {
  const observationalMemory = memorySettings?.observationalMemory;
  if (
    !observationalMemory?.enabled ||
    observationalMemory.modelTarget === OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET
  ) {
    return;
  }
  try {
    return parseObservationalMemoryModelTarget(observationalMemory.modelTarget);
  } catch {
    // Memory construction parses the same target and throws loudly; reaching
    // here means no observer was built for this run.
    return;
  }
}
export function parseSemanticRecallEmbeddingModelTarget(
  modelTarget: string
): DesktopMemoryModelTargetDescriptor {
  return parseModelTarget(modelTarget, {
    allowedProviders: DESKTOP_SEMANTIC_RECALL_EMBEDDING_PROVIDERS,
    disallowedProviderMessage: (provider) =>
      `Desktop Mastra semantic recall supports hosted OpenAI/Google embedders or the built-in local embedder; received "${provider}" in "${modelTarget}".`,
    formatLabel: 'Semantic recall embedding model target',
    unsupportedProviderLabel: 'semantic recall embedding',
  });
}
