import type { RuntimeData } from '@brainstrike/agent/hosted-web';
import {
  type ConfiguredAssistantProviderConfig,
  type HostedWebAssistantProvider,
  isHostedWebAssistantProvider,
} from './assistant-config';
import { parseWebAssistantRuntimeData } from './web-assistant-runtime-schema';

export class InvalidWebAssistantRuntimeDataError extends Error {
  readonly code = 'invalid_web_assistant_runtime_data';

  constructor(field: string, reason: 'invalid' | 'unsupported' = 'unsupported') {
    super(
      `${reason === 'unsupported' ? 'Unsupported' : 'Invalid'} web assistant runtime field: ${field}`
    );
    this.name = 'InvalidWebAssistantRuntimeDataError';
  }
}

/**
 * Build the TRUSTED runtime for a web assistant request (mirrors the desktop
 * assistant server's trust boundary). Lives in its own PGlite-free module so the
 * trust logic is unit-testable without a Node/PGlite environment.
 *
 * Only explicit request metadata crosses this boundary. The shared UI's model,
 * generation, loop, MCP, and enabled-tool hints are accepted for wire
 * compatibility but are never copied into the runtime. A requested provider is
 * admitted only after it matches the server's configured Hosted Web set; the
 * server still owns its key, default model, generation policy, and empty tool
 * registry. Every other field is rejected.
 */
export function resolveWebAssistantRuntime(
  data: unknown,
  apiKey: string,
  signal?: AbortSignal,
  provider: HostedWebAssistantProvider = 'openai'
): RuntimeData {
  resolveWebAssistantProvider(data, [provider]);
  const requestRuntime = readClientRuntime(data);
  return {
    ...requestRuntime,
    apiKey,
    provider,
    ...(signal ? { signal } : {}),
  };
}

export function resolveWebAssistantProvider(
  data: unknown,
  enabledProviders: readonly HostedWebAssistantProvider[]
): HostedWebAssistantProvider {
  const defaultProvider = enabledProviders[0];
  if (!defaultProvider) {
    throw new InvalidWebAssistantRuntimeDataError('provider', 'invalid');
  }
  if (!(data && typeof data === 'object' && !Array.isArray(data))) {
    return defaultProvider;
  }
  const requestedProvider = (data as Record<string, unknown>)['provider'];
  if (requestedProvider === undefined) {
    return defaultProvider;
  }
  if (
    typeof requestedProvider !== 'string' ||
    !isHostedWebAssistantProvider(requestedProvider) ||
    !enabledProviders.includes(requestedProvider)
  ) {
    throw new InvalidWebAssistantRuntimeDataError('provider', 'invalid');
  }
  return requestedProvider;
}

export function resolveWebAssistantProviderConfig(
  data: unknown,
  configuredProviders: readonly ConfiguredAssistantProviderConfig[]
): ConfiguredAssistantProviderConfig {
  const provider = resolveWebAssistantProvider(
    data,
    configuredProviders.map((config) => config.provider)
  );
  const config = configuredProviders.find((candidate) => candidate.provider === provider);
  if (!(config?.enabled && config.apiKey)) {
    throw new InvalidWebAssistantRuntimeDataError('provider', 'invalid');
  }
  return config;
}

function readClientRuntime(data: unknown): Partial<RuntimeData> {
  const result = parseWebAssistantRuntimeData(data);
  if (!result.success) {
    throw new InvalidWebAssistantRuntimeDataError(result.field, result.reason);
  }
  return result.data;
}
