import { createLogger } from '@brainstrike/utils/logger';
import {
  isSupportedProvider,
  resolveProviderApiKey,
  type SupportedProvider,
} from '../providers/key-resolver';
import type { RuntimeData } from '../types';
import { createMastraAgentError } from './mastra-agent-error';

const logger = createLogger('MastraAgentRuntimeConfig');

export interface ResolvedRuntimeConfiguration {
  apiKey: string;
  provider: SupportedProvider;
  runtime: RuntimeData & { provider: SupportedProvider };
}

export function resolveRuntimeConfiguration(
  runtimeData: RuntimeData | undefined
): ResolvedRuntimeConfiguration {
  const rawProvider = typeof runtimeData?.provider === 'string' ? runtimeData.provider.trim() : '';
  if (!rawProvider) {
    logger.warn('mastra agent missing provider', { code: 'mastra_agent_missing_provider' });
    throw createMastraAgentError('mastra_agent_missing_provider');
  }

  const normalizedProvider = rawProvider.toLowerCase();
  if (!isSupportedProvider(normalizedProvider)) {
    logger.warn('mastra agent unsupported provider', {
      code: 'mastra_agent_unsupported_provider',
      provider: rawProvider,
    });
    throw createMastraAgentError('mastra_agent_unsupported_provider', {
      context: { provider: rawProvider },
    });
  }

  const sanitizedRuntime: RuntimeData & { provider: SupportedProvider } = runtimeData
    ? { ...runtimeData, provider: normalizedProvider }
    : { provider: normalizedProvider };

  // Local runtimes do not require API keys.
  if (
    normalizedProvider === 'local' ||
    normalizedProvider === 'ollama' ||
    normalizedProvider === 'lmstudio'
  ) {
    return {
      apiKey: '',
      provider: normalizedProvider,
      runtime: sanitizedRuntime,
    };
  }

  const apiKey = resolveProviderApiKey(normalizedProvider, sanitizedRuntime);
  if (!apiKey) {
    logger.warn('mastra agent missing api key', {
      code: 'mastra_agent_missing_api_key',
      provider: normalizedProvider,
    });
    throw createMastraAgentError('mastra_agent_missing_api_key', {
      context: { provider: normalizedProvider },
    });
  }

  return {
    apiKey,
    provider: normalizedProvider,
    runtime: sanitizedRuntime,
  };
}
