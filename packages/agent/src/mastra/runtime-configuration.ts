import { createLogger } from '@brainstrike/utils';
import type { RuntimeData } from '../index';
import {
  isSupportedProvider,
  resolveProviderApiKey,
  type SupportedProvider,
} from '../providers/key-resolver';
import { createMastraAgentError } from './mastra-agent-error';

const logger = createLogger('MastraAgentRuntimeConfig');

export interface ResolvedRuntimeConfiguration {
  provider: SupportedProvider;
  runtime: RuntimeData & { provider: SupportedProvider };
  apiKey: string;
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
      code: 'mastra_agent_missing_provider',
      provider: rawProvider,
    });
    throw createMastraAgentError('mastra_agent_missing_provider', {
      context: { provider: rawProvider },
    });
  }

  const sanitizedRuntime: RuntimeData & { provider: SupportedProvider } = runtimeData
    ? { ...runtimeData, provider: normalizedProvider }
    : { provider: normalizedProvider };

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
    provider: normalizedProvider,
    runtime: sanitizedRuntime,
    apiKey,
  };
}
