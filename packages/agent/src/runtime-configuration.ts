import { createLogger } from '@brainstrike/logging';
import { createMastraAgentError } from './mastra-boundary/mastra-agent-error';
import {
  isSupportedProvider,
  resolveProviderApiKey,
  type SupportedProvider,
} from './providers/key-resolver';
import {
  apiKeyAuthInput,
  assertNeverAuthInput,
  assertValidProviderAuthInput,
  type ProviderAuthInput,
} from './providers/provider-auth-input';
import { providerAuthType } from './providers/types';
import type { RuntimeData } from './types';

const logger = createLogger('MastraAgentRuntimeConfig');

export interface ResolvedRuntimeConfiguration {
  apiKey: string;
  /**
   * The auth input `instantiateLanguageModel` hands to `createProvider`
   * (BST-1352). Populated from the caller's direct-parameter auth input when
   * one was threaded, otherwise wrapped from the legacy runtime/env-resolved
   * key. NEVER copied onto `runtime` — RuntimeData must not carry auth inputs.
   */
  authInput?: ProviderAuthInput;
  provider: SupportedProvider;
  runtime: RuntimeData & { provider: SupportedProvider };
}

/**
 * Project a threaded auth input onto the resolved bearer-key string the rest
 * of the runtime assembly consumes. Only `aws` has no bearer projection — it resolves to `''` WITHOUT
 * tripping the missing-key rejection (SigV4 auth needs no bearer key; the
 * factory owns aws consumption/validation).
 */
function bearerKeyForAuthInput(auth: ProviderAuthInput): {
  apiKey: string;
  requireNonEmpty: boolean;
} {
  switch (auth.kind) {
    case 'api_key':
    case 'custom_fetch':
      // Both carry a required bearer string (custom_fetch's is the dummy the
      // SDK factories demand); an empty one is a malformed input surfaced via
      // the same stable missing-key code.
      return { apiKey: auth.apiKey, requireNonEmpty: true };
    case 'aws':
      return { apiKey: auth.apiKey ?? '', requireNonEmpty: false };
    default:
      return assertNeverAuthInput(auth);
  }
}

export function resolveRuntimeConfiguration(
  runtimeData: RuntimeData | undefined,
  authInput?: ProviderAuthInput
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

  // Malformed auth inputs (aws without a region) fail HERE, before any keyless
  // or missing-key decision — a shape error must never read as a key error.
  assertValidProviderAuthInput(authInput);

  // Keyless providers (registry `authType: 'none'`) do not require API keys.
  if (providerAuthType(normalizedProvider) === 'none') {
    return {
      apiKey: '',
      ...(authInput ? { authInput } : {}),
      provider: normalizedProvider,
      runtime: sanitizedRuntime,
    };
  }

  if (authInput) {
    // A threaded auth input is AUTHORITATIVE: no fallback into runtime/env
    // key resolution behind the caller's back.
    const bearer = bearerKeyForAuthInput(authInput);
    if (bearer.requireNonEmpty && !bearer.apiKey) {
      logger.warn('mastra agent missing api key', {
        code: 'mastra_agent_missing_api_key',
        provider: normalizedProvider,
      });
      throw createMastraAgentError('mastra_agent_missing_api_key', {
        context: { provider: normalizedProvider },
      });
    }
    return {
      apiKey: bearer.apiKey,
      authInput,
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

  // Legacy resolution wraps into the union so instantiateLanguageModel has
  // ONE input shape (the ONE string→union adapter).
  const legacyAuthInput = apiKeyAuthInput(apiKey);
  return {
    apiKey,
    ...(legacyAuthInput ? { authInput: legacyAuthInput } : {}),
    provider: normalizedProvider,
    runtime: sanitizedRuntime,
  };
}
