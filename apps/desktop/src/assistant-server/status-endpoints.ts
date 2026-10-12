import type http from 'node:http';
import { respondJson } from '@brainstrike/assistant-service/http';
import {
  createOpenRouterModelMetadataService,
  requireOpenRouterModelId,
} from '@brainstrike/host-capabilities/openrouter-model-metadata';
import {
  createProviderVerificationService,
  MissingProviderCredentialError,
  UnknownVerificationProviderError,
  UnsupportedVerificationCredentialError,
} from '@brainstrike/host-capabilities/provider-verification';
import { desktopAssistantServerLogger as logger } from './logger';
import {
  collectAvailableProviders,
  readMainVerificationCredential,
  resolveProviderApiKeyOrRespond,
} from './provider-credentials';
import { respondToSecretReadError } from './secret-error-responses';
import type { AssistantServerOptions } from './server-options';

const defaultOpenRouterModelMetadataService = createOpenRouterModelMetadataService();
const defaultProviderVerificationService = createProviderVerificationService({
  readCredential: readMainVerificationCredential,
});
export async function handleAssistantStatus(
  res: http.ServerResponse,
  options: AssistantServerOptions
): Promise<void> {
  try {
    // BST-1361: rename warnings for deprecated env names. Desktop MAIN
    // computed these from its own process env at startup (see
    // AssistantServerOptions.deprecatedEnvVars); absence and empty both omit
    // the field so unaffected payloads are unchanged. A rejected env FILE
    // does not suppress them: the inherited process env can still carry a
    // deprecated name, and the repair guidance is most useful exactly when
    // the user is already editing their environment.
    const deprecatedEnvVars =
      options.deprecatedEnvVars && options.deprecatedEnvVars.length > 0
        ? { deprecatedEnvVars: options.deprecatedEnvVars }
        : {};

    if (options.envFileFailures && options.envFileFailures.length > 0) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ...deprecatedEnvVars,
          enabled: false,
          envFileFailures: options.envFileFailures,
          error: 'assistant_configuration_invalid',
          message: 'Desktop environment configuration is invalid.',
          providers: [],
        })
      );
      return;
    }

    const { providerErrors, providerKeySources, providers } = await collectAvailableProviders();
    const enabled = providers.length > 0;
    const payload = enabled
      ? {
          ...deprecatedEnvVars,
          enabled,
          ...(providerErrors.length > 0 ? { providerErrors } : {}),
          providerKeySources,
          providers,
        }
      : {
          ...deprecatedEnvVars,
          enabled,
          providers: [] as string[],
          reason: 'no_providers_configured',
        };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(JSON.stringify(payload));
  } catch (error) {
    logger.error('Assistant status check failed', { error });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: 'assistant_status_failed',
        message: 'Assistant status unavailable.',
      })
    );
  }
}

const OPENROUTER_METADATA_ERROR_MAX_CHARS = 300;

export async function handleOpenRouterModelMetadata(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions
): Promise<void> {
  const modelId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('model')?.trim();
  if (!modelId) {
    respondJson(res, 400, {
      error: 'missing_model',
      message: 'OpenRouter model metadata requires a model query parameter.',
    });
    return;
  }

  try {
    requireOpenRouterModelId(modelId);
  } catch (error) {
    respondJson(res, 400, {
      error: 'invalid_model',
      message:
        error instanceof Error
          ? error.message.slice(0, OPENROUTER_METADATA_ERROR_MAX_CHARS)
          : 'OpenRouter model id is invalid',
    });
    return;
  }

  const apiKeyResolution = await resolveProviderApiKeyOrRespond('openrouter', res);
  if (!apiKeyResolution) {
    return;
  }
  const { apiKey } = apiKeyResolution;
  if (!apiKey) {
    respondJson(res, 400, {
      error: 'missing_api_key',
      message: 'No API key configured for provider "openrouter".',
    });
    return;
  }

  try {
    const service = options.openRouterModelMetadataService ?? defaultOpenRouterModelMetadataService;
    const snapshot = await service.get(modelId, apiKey);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(JSON.stringify(snapshot));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, OPENROUTER_METADATA_ERROR_MAX_CHARS)
        : 'OpenRouter Models API request failed';
    logger.warn('OpenRouter model metadata request failed', { error, modelId });
    respondJson(res, 502, {
      error: 'openrouter_model_metadata_failed',
      message,
    });
  }
}

/**
 * GET /assistant/verify-provider?provider=<id> (BST-1357): runs the
 * cheapest-authenticated-call credential probe for one provider and returns
 * the typed {@link ProviderVerificationSnapshot}. The renderer sends ONLY the
 * provider id — credentials resolve main-side inside the service via the
 * typed reader, and the response never carries key material. Probe outcomes
 * (invalid/unreachable/…) are 200-with-result; 4xx/5xx here mean the REQUEST
 * itself failed (unknown provider, no credential, unreadable secret store).
 */
export async function handleVerifyProviderRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions
): Promise<void> {
  const providerId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
    .get('provider')
    ?.trim();
  if (!providerId) {
    respondJson(res, 400, {
      error: 'missing_provider',
      message: 'Provider verification requires a provider query parameter.',
    });
    return;
  }

  try {
    const service = options.providerVerificationService ?? defaultProviderVerificationService;
    const snapshot = await service.verify(providerId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(JSON.stringify(snapshot));
  } catch (error) {
    if (error instanceof UnknownVerificationProviderError) {
      respondJson(res, 400, { error: 'unknown_provider', message: error.message });
      return;
    }
    if (error instanceof MissingProviderCredentialError) {
      respondJson(res, 400, { error: 'missing_api_key', message: error.message });
      return;
    }
    if (error instanceof UnsupportedVerificationCredentialError) {
      respondJson(res, 400, { error: 'verification_unsupported', message: error.message });
      return;
    }
    if (respondToSecretReadError(res, error)) {
      return;
    }
    // Error classes above carry static or provider-id-only messages; anything
    // else is bounded before it becomes visible.
    const message =
      error instanceof Error
        ? error.message.slice(0, OPENROUTER_METADATA_ERROR_MAX_CHARS)
        : 'Provider verification failed.';
    logger.warn('Provider verification request failed', { error, providerId });
    respondJson(res, 500, { error: 'verify_provider_failed', message });
  }
}
