import type http from 'node:http';
import {
  buildNativeToolRiskMap,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  listSuspendedMastraRuns,
  type RediscoveredToolApproval,
  type RuntimeAssistantMemorySettings,
  resolveApprovalStaleMs,
  type SuspendedApprovalsResponse,
} from '@brainstrike/agent';
import { respondJson } from './http-responses';
import { desktopAssistantServerLogger as logger } from './logger';
import { getDesktopMastraMemory } from './mastra-memory';
import {
  createOpenRouterModelMetadataService,
  requireOpenRouterModelId,
} from './openrouter-model-metadata';
import { collectAvailableProviders, resolveProviderApiKeyOrRespond } from './provider-credentials';
import type { AssistantServerOptions } from './server-types';

const defaultOpenRouterModelMetadataService = createOpenRouterModelMetadataService();

const SUSPENDED_RUN_DISCOVERY_MEMORY_SETTINGS: RuntimeAssistantMemorySettings = {
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
    retrievalMode: 'off',
  },
  semanticRecall: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
    enabled: false,
  },
};

export async function handleAssistantStatus(
  res: http.ServerResponse,
  options: AssistantServerOptions
): Promise<void> {
  try {
    if (options.envFileFailures && options.envFileFailures.length > 0) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 200;
      res.end(
        JSON.stringify({
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
          enabled,
          ...(providerErrors.length > 0 ? { providerErrors } : {}),
          providerKeySources,
          providers,
        }
      : {
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
 * Restart-safe rediscovery of pending tool approvals for a thread. On reload the
 * live-stream approval notice is gone (it was never persisted), but the suspended
 * run snapshot survives in workflow storage — this endpoint surfaces it so the
 * renderer can re-render a working Approve/Decline notice (reusing the existing
 * resume seam). Discovery is CONTEXT-FREE + KEYLESS + MODEL-FREE: the stable
 * agent id ('brainstrike-assistant') is provider-independent, and
 * `listSuspendedMastraRuns` builds its runtime with an INERT listing-only model
 * (no provider/model is ever resolved), so no provider/apiKey is required from
 * the renderer and no inference happens (listing only reads snapshots). The
 * `provider: 'ollama'` below is a keyless placeholder that satisfies runtime
 * config; it is never used to construct a model.
 */
export async function handleSuspendedRunsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions
): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  const threadId = query.get('threadId')?.trim() ?? '';
  const resourceId = query.get('resourceId')?.trim() ?? '';
  if (!(threadId && resourceId)) {
    respondJson(res, 400, {
      error: 'missing_thread_context',
      message: 'Both threadId and resourceId query parameters are required.',
    });
    return;
  }

  try {
    const memoryResult = await getDesktopMastraMemory(
      SUSPENDED_RUN_DISCOVERY_MEMORY_SETTINGS,
      undefined,
      undefined,
      undefined,
      { embeddingHostManager: options.embeddingHostManager }
    );
    if (!memoryResult?.storage) {
      respondJson(res, 503, {
        error: 'tool_approval_storage_unavailable',
        message: 'Workflow storage is unavailable; suspended approvals cannot be discovered.',
      });
      return;
    }

    const discovery = await listSuspendedMastraRuns(
      { resourceId, threadId },
      {
        memory: memoryResult.memory,
        // Keyless, provider-independent, model-free listing (see the doc comment
        // above). `listSuspendedMastraRuns` injects an inert listing-only model,
        // so this provider is a placeholder that is never used to build a model.
        runtime: { memory: { resourceId, threadId }, provider: 'ollama' },
        storage: memoryResult.storage,
      }
    );

    const riskByTool = buildNativeToolRiskMap();
    const staleThresholdMs = resolveApprovalStaleMs();
    const now = Date.now();
    const approvals: RediscoveredToolApproval[] = discovery.approvals.map((approval) => {
      // Discovery returns the ORIGINAL dotted tool name (the agent maps the
      // stored sanitized id back — see listSuspendedMastraRuns), so this lookup
      // hits for every known native tool.
      const riskCategory = riskByTool[approval.toolName];
      if (!riskCategory) {
        // Honest degradation, surfaced loudly: without a risk category the
        // rediscovered notice renders no reason line and no grant actions
        // (never a fabricated category — no-silent-fallbacks).
        logger.warn('Rediscovered approval has no resolvable risk category', {
          code: 'assistant_suspended_approval_risk_unresolved',
          runId: approval.runId,
          toolName: approval.toolName,
        });
      }
      return {
        runId: approval.runId,
        stale: now - Date.parse(approval.suspendedAt) > staleThresholdMs,
        suspendedAt: approval.suspendedAt,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        ...(approval.args === undefined ? {} : { args: approval.args }),
        ...(riskCategory ? { policyDecision: 'ask' as const, riskCategory } : {}),
      };
    });

    const payload: SuspendedApprovalsResponse = { approvals };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(JSON.stringify(payload));
  } catch (error) {
    logger.error('Suspended approval discovery failed', { error });
    respondJson(res, 500, {
      error: 'suspended_runs_failed',
      message: 'Suspended approval discovery failed.',
    });
  }
}
