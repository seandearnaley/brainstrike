import type http from 'node:http';
import {
  buildNativeToolRiskMap,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  hasRegisteredSuspendResumeUi,
  listSuspendedMastraRuns,
  type RediscoveredToolApproval,
  type RediscoveredToolSuspend,
  RUN_PYTHON_TOOL_ID,
  type RuntimeAssistantMemorySettings,
  resolveApprovalStaleMs,
  resolveRunPythonExecutionContext,
  type SuspendedRunsResponse,
} from '@brainstrike/agent';
import { respondJson } from '@brainstrike/assistant-service/http';
import { getProviderAuthEngine } from '../provider-auth/provider-auth-runtime';
import { desktopAssistantServerLogger as logger } from './logger';
import { getDesktopMastraMemory } from './mastra-memory';
import {
  createOpenRouterModelMetadataService,
  requireOpenRouterModelId,
} from './openrouter-model-metadata';
import { collectAvailableProviders, resolveProviderApiKeyOrRespond } from './provider-credentials';
import {
  createProviderVerificationService,
  MissingProviderCredentialError,
  UnknownVerificationProviderError,
  UnsupportedVerificationCredentialError,
} from './provider-verification';
import { respondToSecretReadError } from './secret-error-responses';
import type { AssistantServerOptions } from './server-options';

const defaultOpenRouterModelMetadataService = createOpenRouterModelMetadataService();
const defaultProviderVerificationService = createProviderVerificationService({
  /**
   * BST-1356: subscription freshness is answered by the SHARED provider-auth
   * engine's single-flight refresher. Resolved lazily so this module-scope
   * construction never forces the runtime to exist (it does not in tests or
   * on web); an uninitialized runtime surfaces as a typed unsupported-probe
   * failure rather than a crash.
   */
  verifySubscriptionSession: async (providerId) => {
    let engine: ReturnType<typeof getProviderAuthEngine>;
    try {
      engine = getProviderAuthEngine();
    } catch {
      // Uninitialized runtime (web, tests, any non-desktop host): surface the
      // TYPED unsupported-probe failure the verification service turns into a
      // `verification_unsupported` 400, rather than letting a bare Error
      // escape as a 500 (PR #2527 review, finding 8).
      throw new UnsupportedVerificationCredentialError(
        'subscription sign-in can only be verified in the desktop app'
      );
    }
    const result = await engine.getFreshAccessToken(providerId);
    // The access token itself NEVER leaves the engine (gate constraint 3) —
    // only the verdict crosses into the verification result.
    return result.ok ? { ok: true } : { ok: false, status: result.status };
  },
});

/**
 * Newest-N bound on rediscovered suspend() pauses per thread open (BST-1084,
 * #2223 review). Suspends are the common abandonment case (no Decline settles
 * them), so hydration cards must not grow monotonically with every ignored
 * question/plan. Ten keeps any realistic backlog visible while bounding a
 * pathological one; truncation is logged, never silent.
 */
const MAX_REDISCOVERED_SUSPENDS = 10;

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
      // BST-1070: the live approval's executionContext is a transient stream
      // field, so a rediscovered run_python approval RECOMPUTES it from the
      // durable args — the same helper the live chunk uses, exactly where
      // riskCategory is recomputed. Unparseable args yield no context, and the
      // card falls to its fail-safe (no fact rows, grants suppressed).
      const executionContext =
        approval.toolName === RUN_PYTHON_TOOL_ID
          ? resolveRunPythonExecutionContext(approval.args)
          : undefined;
      return {
        runId: approval.runId,
        stale: now - Date.parse(approval.suspendedAt) > staleThresholdMs,
        suspendedAt: approval.suspendedAt,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        ...(approval.args === undefined ? {} : { args: approval.args }),
        ...(riskCategory ? { policyDecision: 'ask' as const, riskCategory } : {}),
        ...(executionContext === undefined ? {} : { executionContext }),
      };
    });

    // BST-1084: rediscovered suspend() pauses ride the same response. An
    // UNREGISTERED tool's pause is flagged resumeSupported:false and NEVER
    // dropped. The flag is WIRE HONESTY, not a renderer input: the notice
    // picks its dead-end branch from hasRegisteredSuspendResumeUi(toolName)
    // against the same REGISTERED_SUSPEND_RESUME_TOOL_IDS constant this
    // process reads (same build, same answer) — the field exists so the
    // payload states what this build concluded, and for any future consumer
    // that is NOT the same build (logs, debug bundles, version-skewed
    // clients).
    //
    // BOUNDED (#2223 review): abandoned suspends accumulate — a user who
    // ignores an askUser/submitPlan card and types a new message leaves that
    // run suspended in workflow storage permanently, and unlike approvals
    // there is no Decline that settles them. Without a cap every thread open
    // would append one card per abandoned question/plan, forever. Keep the
    // NEWEST N (discovery sorts oldest-first) and log the dropped count —
    // truncation is visible in the log, and the dropped runs stay resumable
    // in storage if a later build adds a management surface.
    const cappedSuspends = discovery.suspends.slice(-MAX_REDISCOVERED_SUSPENDS);
    if (cappedSuspends.length < discovery.suspends.length) {
      logger.warn('Capping rediscovered suspend pauses for thread hydration', {
        code: 'assistant_suspended_pause_cap_applied',
        droppedCount: discovery.suspends.length - cappedSuspends.length,
        keptCount: cappedSuspends.length,
        threadId,
      });
    }
    const suspends: RediscoveredToolSuspend[] = cappedSuspends.map((pause) => {
      const resumable = hasRegisteredSuspendResumeUi(pause.toolName);
      if (!resumable) {
        logger.warn('Rediscovered suspend pause has no registered resume UI in this build', {
          code: 'assistant_suspended_pause_resume_unregistered',
          runId: pause.runId,
          toolName: pause.toolName,
        });
      }
      return {
        runId: pause.runId,
        stale: now - Date.parse(pause.suspendedAt) > staleThresholdMs,
        suspendedAt: pause.suspendedAt,
        toolCallId: pause.toolCallId,
        toolName: pause.toolName,
        ...(pause.suspendPayload === undefined ? {} : { suspendPayload: pause.suspendPayload }),
        ...(resumable ? {} : { resumeSupported: false as const }),
      };
    });

    const payload: SuspendedRunsResponse = { approvals, suspends };
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
