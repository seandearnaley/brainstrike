import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { homedir } from 'node:os';
import type {
  AgentMessage,
  AssistantRunEvent,
  AssistantTaskItem,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  AssistantUiMessageConversionResult,
  McpConfig,
  RuntimeAssistantMemorySettings,
  RuntimeData,
  ScannedWorkspaceSkills,
  ScopedToolOutputArtifactReader,
  StreamChunk,
  ToolOutputArtifactSettlementStore,
} from '@brainstrike/agent';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantAttachmentValidationError,
  AssistantInvalidJsonError,
  AssistantMessageValidationError,
  AssistantRequestBodyTooLargeError,
  AssistantRequestEnvelopeValidationError,
  assistantDataStreamSessions,
  buildNativeToolRiskMap,
  CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  convertAssistantUiMessagesWithFinalInput,
  createEmbeddingProvider,
  createLanguageModelProvider,
  createLocalHostEmbeddingModel,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  hasAssistantPromptContent,
  isSupportedProvider,
  listSuspendedMastraRuns,
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  PROVIDER_DEFAULT_MODELS,
  parseAssistantRequestPayloadText,
  type RediscoveredToolApproval,
  readToolApprovalRunConfigAction,
  readToolResumeRunConfigAction,
  resolveApprovalStaleMs,
  resolveAssistantRequestBodyLimitBytes,
  resolveAutoObservationalMemoryModelTarget,
  resolveDataStreamSession,
  resolveRequestPermissionPolicy,
  type SuspendedApprovalsResponse,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import {
  ASSISTANT_AUTH_HEADER_NAME,
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
  DESKTOP_NATIVE_TOOL_IDS,
  NATIVE_TOOL_ID,
  type ProviderKeySource,
} from '@brainstrike/assistant-contract';
import { ToolOutputArtifactRepository } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { app } from 'electron';
import {
  type AssistantServerAuth,
  isAuthorizedAssistantToken,
  mintAssistantServerAuthToken,
} from './assistant-server/auth';
import { resolveRequestPersonas } from './assistant-server/request-personas';
import {
  registerSteerableRun,
  requestRunCancel,
  requestRunSteer,
  unregisterSteerableRun,
} from './assistant-server/run-steering-registry';
import { scanUserPersonas } from './assistant-server/user-personas-loader';
import { createNodeFsScanDeps } from './ipc-user-commands-handlers';

const DESKTOP_NATIVE_TOOL_ID_SET = new Set<string>(DESKTOP_NATIVE_TOOL_IDS);
const SAFE_NATIVE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;

class InvalidEnabledNativeToolIdsError extends Error {
  readonly invalidValues: readonly unknown[];

  constructor(invalidValues: readonly unknown[]) {
    super('Assistant request contains unknown enabled native tool IDs.');
    this.name = 'InvalidEnabledNativeToolIdsError';
    this.invalidValues = invalidValues;
  }
}

import type { DesktopAssistantToolDependencies } from './assistant-server/assistant-tools';
import { buildDesktopAssistantTools } from './assistant-server/assistant-tools';
import type { HookRunVerdict } from './assistant-server/hooks/run-verdict';
import {
  finalizeHookedStream,
  hookRunEventToAssistant,
  makeHookBlockedStream,
  prepareRequestHooks,
  runUserPromptSubmitGate,
} from './assistant-server/hooks/server-integration';
import { readRequestBody, streamResponse } from './assistant-server/http';
import { respondJson, respondNotFound } from './assistant-server/http-responses';
import {
  type AssistantLlmHostManager,
  createMainLlmHostClient,
} from './assistant-server/local-llm-host-client';
import {
  createOpenRouterModelMetadataService,
  type OpenRouterModelMetadataService,
  requireOpenRouterModelId,
} from './assistant-server/openrouter-model-metadata';
import { injectReferencedFilesContext } from './assistant-server/referenced-files-context';
import { registerRequestAbort } from './assistant-server/request-abort';
import { prepareRequestSkills } from './assistant-server/request-skills';
import { readLastEventId, resolveAssistantRoute } from './assistant-server/routing';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
  recordDesktopAssistantHookRunOutcome,
  recordDesktopAssistantThreadRunStatus,
} from './assistant-server/run-persistence';
import {
  getSecretReadErrorPayload,
  respondToSecretReadError,
} from './assistant-server/secret-error-responses';
import type {
  AgentStreamFailure,
  AgentStreamInitializationStage,
  AgentStreamResult,
  AssistantRequestPayload,
  AssistantUiMessage,
  DesktopMemoryFeature,
} from './assistant-server/server-types';
import { injectActivatedSkillsContext } from './assistant-server/skills-activation-context';
import { createSecureSkillsFs } from './assistant-server/skills-fs-deps';
import { readThreadTaskList } from './assistant-server/task-list-repository';
import { WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS } from './assistant-server/web-extract-model-projection';
import { injectWorkspaceInstructionsContext } from './assistant-server/workspace-instructions-context';
import {
  BoundWorkspaceRootUnavailableError,
  enrichRuntimeDataWithWorkspaceRoots,
} from './assistant-server/workspace-roots';
import { readWorkspaceTextFile } from './assistant-server/workspace-text-file-reader';
import { getDatabase } from './db-main';
import type { DesktopEnvLoadFailure } from './desktop-env';
import { DESKTOP_DEV_RENDERER_URL } from './desktop-renderer-url';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { loadMcpConfig } from './mcp-loader';
import {
  inspectProviderKeys,
  readProviderSecretKey,
  resolveProviderEnvKey,
} from './provider-api-key';

const logger = createLogger('DesktopAssistantServer');
export const desktopAssistantServerLogger = logger;
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
const assistantRequestBodyLimitBytes = resolveAssistantRequestBodyLimitBytes(
  process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]
);
type DesktopMastraMemoryResult =
  import('@brainstrike/agent/pglite-mastra-memory').PgliteMastraMemoryResult;
type DesktopMastraMemoryPromise = Promise<DesktopMastraMemoryResult>;

const DESKTOP_MEMORY_CACHE_LIMIT = 16;
// Fully resolved memory instances are keyed by provider/model plus hashed API
// keys. Pending keychain resolutions are keyed by unresolved descriptors so
// concurrent desktop requests dedupe before the concrete cache key exists.
// Each map is independently bounded to the same small desktop cache limit.
const desktopMastraMemoryPromises = new Map<string, DesktopMastraMemoryPromise>();
const desktopMastraMemoryResolutionPromises = new Map<string, DesktopMastraMemoryPromise>();
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

interface DesktopMemoryModelTargetDescriptor {
  readonly model: string;
  readonly provider: SupportedProvider;
}

interface DesktopObservationalMemoryModelTarget extends DesktopMemoryModelTargetDescriptor {
  readonly apiKey: string;
  readonly cacheKey: string;
}

interface DesktopSemanticRecallEmbeddingModelTarget extends DesktopMemoryModelTargetDescriptor {
  readonly apiKey: string;
  readonly cacheKey: string;
}

type DesktopMemoryModelTargetResolution<T extends DesktopMemoryModelTargetDescriptor> =
  | { readonly kind: 'disabled' }
  | {
      readonly descriptor: T;
      readonly kind: 'needs_async_resolution';
    }
  | {
      readonly kind: 'resolved';
      readonly target: T & { readonly apiKey: string; readonly cacheKey: string };
    };

type RuntimeMemoryOptions = NonNullable<RuntimeData['memory']>['memoryOptions'];

interface DesktopMastraMemoryCacheState {
  readonly cachedPromise?: DesktopMastraMemoryPromise | undefined;
  readonly observationalMemoryResolution: DesktopMemoryModelTargetResolution<DesktopMemoryModelTargetDescriptor>;
  readonly semanticRecallEmbeddingResolution: DesktopMemoryModelTargetResolution<DesktopMemoryModelTargetDescriptor>;
}

class DesktopMemoryCredentialMissingError extends Error {
  readonly feature: DesktopMemoryFeature;
  readonly provider: SupportedProvider;

  constructor(feature: DesktopMemoryFeature, target: DesktopMemoryModelTargetDescriptor) {
    const featureLabel =
      feature === 'observational_memory' ? 'Observational memory' : 'Semantic recall';
    super(
      `${featureLabel} requires an API key for "${target.provider}". Add the key in Settings, then retry.`
    );
    this.name = 'DesktopMemoryCredentialMissingError';
    this.feature = feature;
    this.provider = target.provider;
  }
}

export interface AssistantServerOptions {
  /**
   * Request auth. `startAssistantServer` mints a per-boot token when unset;
   * `handleAssistantRequest` throws when unset (misconfiguration must be loud).
   * `'disabled'` is the explicit opt-out for routing/CORS-focused tests.
   */
  auth?: AssistantServerAuth;
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  envFileFailures?: readonly DesktopEnvLoadFailure[];
  host?: string;
  listen?: boolean;
  llmHostManager?: AssistantLlmHostManager | null | undefined;
  openRouterModelMetadataService?: OpenRouterModelMetadataService;
}

export function startAssistantServer(portHint?: number, options: AssistantServerOptions = {}) {
  const auth: AssistantServerAuth = options.auth ?? { token: mintAssistantServerAuthToken() };
  const authToken = auth === 'disabled' ? undefined : auth.token;
  const requestOptions: AssistantServerOptions = { ...options, auth };
  const server = http.createServer(async (req, res) => {
    await handleAssistantRequest(req, res, requestOptions).catch(() => {
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      applyAssistantCorsHeaders(req, res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'assistant server error' }));
    });
  });

  const port = Number(process.env['BS_ASSISTANT_PORT'] ?? portHint ?? 0) || 0;
  const host = options.host ?? '127.0.0.1';
  if (options.listen === false) {
    return Promise.resolve({
      ...(authToken === undefined ? {} : { authToken }),
      stop: async () => {},
      url: `http://${host}:${port}`,
    });
  }
  return new Promise<{ url: string; stop: () => Promise<void>; authToken?: string }>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;
      resolve({
        ...(authToken === undefined ? {} : { authToken }),
        stop: async () => await new Promise<void>((r) => server.close(() => r())),
        url,
      });
    });
  });
}

export async function handleAssistantRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions = {}
): Promise<void> {
  const auth = options.auth;
  if (auth === undefined) {
    // NO SILENT FALLBACKS: an unconfigured gate must fail loudly, never serve.
    throw new Error(
      'Assistant server auth is not configured. Pass options.auth ({ token } or the explicit "disabled" opt-out).'
    );
  }

  if (hasDisallowedAssistantOrigin(req)) {
    respondForbiddenOrigin(res);
    return;
  }

  applyAssistantCorsHeaders(req, res);

  if (isAssistantCorsPreflight(req)) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (
    auth !== 'disabled' &&
    !isAuthorizedAssistantToken(req.headers[ASSISTANT_AUTH_HEADER_NAME], auth.token)
  ) {
    logger.warn('Rejected assistant request without a valid auth token', {
      method: req.method,
      url: req.url,
    });
    respondJson(res, 401, {
      error: 'unauthorized',
      message: 'Missing or invalid assistant auth token.',
    });
    return;
  }

  const route = resolveAssistantRoute(req);
  if (route === 'status') {
    await handleAssistantStatus(res, options);
    return;
  }

  if (route === 'openrouter-model') {
    await handleOpenRouterModelMetadata(req, res, options);
    return;
  }

  if (route === 'suspended-runs') {
    await handleSuspendedRunsRequest(req, res, options);
    return;
  }

  if (route === 'steer') {
    await handleSteerRequest(req, res);
    return;
  }

  if (route === 'cancel') {
    await handleCancelRequest(req, res);
    return;
  }

  if (route === 'resume') {
    await handleAssistantResumeRequest(req, res);
    return;
  }

  if (route === 'not-found') {
    respondNotFound(res);
    return;
  }

  await handleAssistantPost(req, res, options);
}

/** Transport ceiling shared with approval/resume action identifiers. */
const STEER_RUN_ID_MAX_CHARS = 512;
const STEER_BODY_LIMIT_BYTES = 4096;

/**
 * Mid-run steering control endpoint (BST-588): POST /assistant/steer with
 * exactly `{ runId }`. Flips the registered run's control so the agent loop
 * ends gracefully at the next step boundary; the renderer then dispatches the
 * queued steer message via the follow-up queue's run-end bridge. An unknown
 * run answers a visible 404 — steering a finished run must not pretend
 * success.
 */
async function handleSteerRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let parsed: unknown;
  try {
    const body = await readRequestBody(req, { maxBodyBytes: STEER_BODY_LIMIT_BYTES });
    parsed = JSON.parse(body) as unknown;
  } catch {
    respondJson(res, 400, {
      error: 'invalid_steer_action',
      message: 'Steer request body must be a small JSON object.',
    });
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1
  ) {
    respondJson(res, 400, {
      error: 'invalid_steer_action',
      message: 'Steer request accepts exactly one field: runId.',
    });
    return;
  }
  const runId = (parsed as Record<string, unknown>)['runId'];
  if (
    typeof runId !== 'string' ||
    runId.trim().length === 0 ||
    runId.length > STEER_RUN_ID_MAX_CHARS
  ) {
    respondJson(res, 400, {
      error: 'invalid_steer_action',
      message: `Steer runId must be a non-empty string of at most ${STEER_RUN_ID_MAX_CHARS} characters.`,
    });
    return;
  }
  if (!requestRunSteer(runId)) {
    respondJson(res, 404, {
      error: 'no_active_run',
      message: 'No active steerable run with that id; it may have already finished.',
    });
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({ accepted: true, runId }));
}

/**
 * Explicit hard-stop endpoint. Connection loss is only a subscriber detach;
 * cancellation must arrive through this route so long-running execution
 * survives renderer reloads and transient transport failures.
 */
async function handleCancelRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let parsed: unknown;
  try {
    const body = await readRequestBody(req, { maxBodyBytes: STEER_BODY_LIMIT_BYTES });
    parsed = JSON.parse(body) as unknown;
  } catch {
    respondJson(res, 400, {
      error: 'invalid_cancel_action',
      message: 'Cancel request body must be a small JSON object.',
    });
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1
  ) {
    respondJson(res, 400, {
      error: 'invalid_cancel_action',
      message: 'Cancel request accepts exactly one field: runId.',
    });
    return;
  }
  const runId = (parsed as Record<string, unknown>)['runId'];
  if (
    typeof runId !== 'string' ||
    runId.trim().length === 0 ||
    runId.length > STEER_RUN_ID_MAX_CHARS
  ) {
    respondJson(res, 400, {
      error: 'invalid_cancel_action',
      message: `Cancel runId must be a non-empty string of at most ${STEER_RUN_ID_MAX_CHARS} characters.`,
    });
    return;
  }
  if (!requestRunCancel(runId)) {
    respondJson(res, 404, {
      error: 'no_active_run',
      message: 'No active cancellable run with that id; it may have already finished.',
    });
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({ accepted: true, runId }));
}

async function handleAssistantPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions
): Promise<void> {
  const prepared = await prepareAssistantPostRequest(req, res);
  if (!prepared) {
    return;
  }
  const {
    assistantMessageId,
    messages,
    runtimeData,
    apiKey,
    toolApprovalAction,
    toolResumeAction,
  } = prepared;

  const lastEventId = readLastEventId(req);
  if (await resumeStreamIfAvailable(res, lastEventId)) {
    return;
  }
  const { signal: requestSignal, cleanup } = registerRequestAbort(req, res);
  const executionAbortController = new AbortController();
  const runId = runtimeData.memory?.runId;
  // Only THIS leg's registration may be torn down below: on the defensive
  // duplicate-runId throw the entry belongs to the ORIGINAL still-streaming
  // leg, and unregistering it would make a genuinely active run un-steerable
  // (spurious 404). Review finding, BST-588.
  let registeredSteerableRun = false;
  try {
    // Steering control (BST-588): in-memory only, injected AFTER request
    // validation exactly like `signal`. Every streaming leg with a runId is
    // steerable; the registry entry dies with the stream. Registered INSIDE
    // the try so a defensive duplicate-runId throw still runs cleanup() and
    // answers the request (review P3).
    if (runId) {
      runtimeData.steering = registerSteerableRun(runId, executionAbortController);
      registeredSteerableRun = true;
    }
    await streamAssistantPostResponse({
      apiKey,
      assistantMessageId,
      executionSignal: executionAbortController.signal,
      messages,
      requestSignal,
      res,
      runId,
      runtimeData,
      toolApprovalAction,
      toolDependencies: {
        embeddingHostManager: options.embeddingHostManager,
        llmHostManager: options.llmHostManager,
      },
      toolResumeAction,
    });
  } catch (error) {
    await handleAssistantPostStreamError({
      error,
      res,
      runId,
      signal: executionAbortController.signal,
    });
  } finally {
    if (runId && registeredSteerableRun) {
      unregisterSteerableRun(runId);
    }
    cleanup();
  }
}

async function handleAssistantPostStreamError({
  res,
  runId,
  signal,
  error,
}: {
  readonly res: http.ServerResponse;
  readonly runId: string | undefined;
  readonly signal: AbortSignal;
  readonly error: unknown;
}): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (runId) {
    await recordDesktopAssistantThreadRunStatus(
      runId,
      signal.aborted ? 'cancelled' : 'failed',
      message
    );
  }
  if (signal.aborted) {
    return;
  }
  logger.error('Assistant stream error', { error });
  if (res.headersSent) {
    return;
  }
  respondJson(res, 500, {
    error: 'assistant_stream_failed',
    message: 'Assistant stream failed.',
  });
}

async function streamAssistantPostResponse({
  res,
  messages,
  runtimeData,
  apiKey,
  assistantMessageId,
  executionSignal,
  requestSignal,
  runId,
  toolApprovalAction,
  toolResumeAction,
  toolDependencies,
}: {
  readonly res: http.ServerResponse;
  readonly messages: AgentMessage[];
  readonly runtimeData: RuntimeData;
  readonly apiKey: string | undefined;
  readonly assistantMessageId: string | undefined;
  readonly executionSignal: AbortSignal;
  readonly requestSignal: AbortSignal;
  readonly runId: string | undefined;
  readonly toolApprovalAction?: AssistantToolApprovalAction | undefined;
  readonly toolResumeAction?: AssistantToolResumeAction | undefined;
  readonly toolDependencies: {
    readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
    readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
  };
}): Promise<void> {
  const mcpConfig = (await loadMcpConfig()).config;
  const streamResult = await initializeAgentStream(
    messages,
    runtimeData,
    apiKey,
    mcpConfig,
    executionSignal,
    runId,
    toolApprovalAction,
    toolResumeAction,
    toolDependencies
  );
  if (!streamResult.ok) {
    if (runId) {
      await recordDesktopAssistantThreadRunStatus(runId, 'failed', streamResult.payload.message);
    }
    respondJson(res, streamResult.status, streamResult.payload);
    return;
  }

  const session = assistantDataStreamSessions.create(streamResult.stream, {
    ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
  });
  const response = session.createResponse({
    headers: {
      [ASSISTANT_STREAM_EVENT_ID_HEADER]: `${session.id}:-1`,
      [ASSISTANT_STREAM_MESSAGE_ID_HEADER]: session.messageId,
    },
  });
  await streamResponse(res, response, requestSignal);
  await session.whenClosed();
  if (runId) {
    const sessionOutcome = session.getTerminalOutcome();
    await recordDesktopAssistantThreadRunStatus(
      runId,
      executionSignal.aborted
        ? 'cancelled'
        : (streamResult.terminalStatus ?? sessionOutcome.status),
      executionSignal.aborted
        ? 'Assistant run canceled by user.'
        : (streamResult.terminalError ?? sessionOutcome.error)
    );
  }
}

interface PreparedAssistantPostRequest {
  apiKey: string;
  assistantMessageId?: string;
  messages: AgentMessage[];
  runtimeData: RuntimeData;
  toolApprovalAction?: AssistantToolApprovalAction;
  toolResumeAction?: AssistantToolResumeAction;
}

function withTrustedAssistantMessageId(
  data: RuntimeData | undefined,
  provider: SupportedProvider,
  assistantMessageId: string | undefined
): RuntimeData {
  const { assistantMessageId: _ignoredClientAssistantMessageId, ...clientRuntimeData } = data ?? {};
  return {
    ...clientRuntimeData,
    provider,
    ...(assistantMessageId ? { assistantMessageId } : {}),
  };
}

function convertAssistantMessagesOrRespond(
  rawMessages: readonly AssistantUiMessage[],
  res: http.ServerResponse
): AssistantUiMessageConversionResult | undefined {
  try {
    return convertAssistantUiMessagesWithFinalInput(rawMessages);
  } catch (error) {
    if (!(error instanceof AssistantAttachmentValidationError)) {
      throw error;
    }
    respondJson(res, 400, {
      error: 'invalid_attachment',
      message: 'Assistant attachment payload is invalid.',
      reason: error.reason,
    });
    return;
  }
}

function hasAssistantPromptOrAction(
  finalInputMessage: AgentMessage | null,
  toolApprovalAction: AssistantToolApprovalAction | undefined,
  toolResumeAction: AssistantToolResumeAction | undefined
): boolean {
  if (toolApprovalAction || toolResumeAction) {
    return true;
  }
  return Boolean(finalInputMessage && hasPromptContent([finalInputMessage]));
}

interface ParsedToolContinuationActions {
  readonly toolApprovalAction: AssistantToolApprovalAction | undefined;
  readonly toolApprovalActionInvalid: boolean;
  readonly toolResumeAction: AssistantToolResumeAction | undefined;
  readonly toolResumeActionInvalid: boolean;
}

function respondToToolContinuationInputError(
  res: http.ServerResponse,
  actions: ParsedToolContinuationActions
): boolean {
  if (actions.toolApprovalActionInvalid) {
    respondJson(res, 400, {
      error: 'invalid_tool_approval_action',
      message:
        'Tool approval action must contain only action, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    return true;
  }

  if (actions.toolResumeActionInvalid) {
    respondJson(res, 400, {
      error: 'invalid_tool_resume_action',
      message:
        'Tool resume action must contain only resumeData, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    return true;
  }

  if (actions.toolApprovalAction && actions.toolResumeAction) {
    respondJson(res, 400, {
      error: 'conflicting_tool_continuation_actions',
      message: 'Assistant request must contain at most one tool continuation action.',
    });
    return true;
  }

  return false;
}

async function prepareAssistantPostRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<PreparedAssistantPostRequest | undefined> {
  let rawMessages: AssistantUiMessage[];
  let data: RuntimeData | undefined;
  let assistantMessageId: string | undefined;
  let toolApprovalAction: AssistantToolApprovalAction | undefined;
  let toolApprovalActionInvalid = false;
  let toolResumeAction: AssistantToolResumeAction | undefined;
  let toolResumeActionInvalid = false;
  try {
    const payload = await parseAssistantRequestPayload(req);
    assistantMessageId = payload.assistantMessageId;
    rawMessages = payload.rawMessages;
    data = payload.data;
    toolApprovalAction = payload.toolApprovalAction;
    toolApprovalActionInvalid = Boolean(payload.toolApprovalActionInvalid);
    toolResumeAction = payload.toolResumeAction;
    toolResumeActionInvalid = Boolean(payload.toolResumeActionInvalid);
  } catch (error) {
    if (!respondToAssistantPayloadError(res, error)) {
      throw error;
    }
    return;
  }

  const conversion = convertAssistantMessagesOrRespond(rawMessages, res);
  if (!conversion) {
    return;
  }
  const { finalInputMessage, messages } = conversion;
  const provider = resolveRequestedProvider(data);

  if (
    respondToToolContinuationInputError(res, {
      toolApprovalAction,
      toolApprovalActionInvalid,
      toolResumeAction,
      toolResumeActionInvalid,
    })
  ) {
    return;
  }

  if (!provider) {
    respondJson(res, 400, {
      error: 'missing_provider',
      message: 'No provider specified or provider is not supported.',
    });
    return;
  }

  // Providers that never require a bearer token: the in-browser Gemma runtime
  // and the two local servers (Ollama/LM Studio). Local servers accept an
  // optional token when the user has stored one via the secrets bridge, but
  // the absence of a token is not an error — most setups don't have auth.
  const providerAllowsMissingAuth =
    provider === 'local' || provider === 'ollama' || provider === 'lmstudio';
  const apiKeyResolution =
    provider === 'local' ? { apiKey: '' } : await resolveProviderApiKeyOrRespond(provider, res);
  if (!apiKeyResolution) {
    return;
  }
  const { apiKey } = apiKeyResolution;

  const runtimeData: RuntimeData = resolveServerAutoObservationalMemory(
    hydrateRuntimeDataWithLocalRuntimeToken(
      withTrustedAssistantMessageId(data, provider, assistantMessageId),
      provider,
      apiKey
    )
  );

  logger.info('Assistant request received', {
    hasApiKey: Boolean(apiKey) || providerAllowsMissingAuth,
    messageCount: messages.length,
    provider,
  });

  if (!(apiKey || providerAllowsMissingAuth)) {
    respondJson(res, 400, {
      error: 'missing_api_key',
      message: `No API key configured for provider "${provider}".`,
    });
    return;
  }

  if (!hasAssistantPromptOrAction(finalInputMessage, toolApprovalAction, toolResumeAction)) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'empty_prompt' }));
    return;
  }

  return {
    apiKey: apiKey ?? '',
    ...(assistantMessageId ? { assistantMessageId } : {}),
    messages,
    runtimeData,
    ...(toolApprovalAction ? { toolApprovalAction } : {}),
    ...(toolResumeAction ? { toolResumeAction } : {}),
  };
}

/**
 * Server-side intake resolution of the 'auto' observer sentinel (BST-940).
 * Renderers resolve 'auto' before sending, but a raw client (or a replayed
 * request) may still ship it — and 'auto' must neither reach the target parser
 * (502 on an otherwise-valid stream) nor silently select a provider the chat
 * isn't already using. Same deterministic contract rule as the renderer: the
 * observer comes from the request's OWN chat provider or observation is off
 * for the request. Key presence is implied by the request reaching this seam;
 * a genuinely missing observer credential still fails visibly downstream,
 * exactly like an explicit target.
 */
function resolveServerAutoObservationalMemory(runtimeData: RuntimeData): RuntimeData {
  const memory = runtimeData.memory;
  const memorySettings = memory?.memorySettings;
  const observationalMemory = memorySettings?.observationalMemory;
  if (
    !(memory && memorySettings && observationalMemory) ||
    observationalMemory.modelTarget !== OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET
  ) {
    return runtimeData;
  }
  const chatProvider = typeof runtimeData.provider === 'string' ? runtimeData.provider : null;
  const target = resolveAutoObservationalMemoryModelTarget({
    chatProvider,
    providersWithKeys: chatProvider ? [chatProvider] : [],
  });
  return {
    ...runtimeData,
    memory: {
      ...memory,
      memorySettings: {
        ...memorySettings,
        observationalMemory:
          target === null
            ? { ...observationalMemory, enabled: false }
            : { ...observationalMemory, modelTarget: target },
      },
    },
  };
}

function validateEnabledNativeToolIds(runtimeData: RuntimeData | undefined): void {
  const rawToolIds = runtimeData?.enabledNativeToolIds;
  if (rawToolIds === undefined) {
    return;
  }
  if (!Array.isArray(rawToolIds)) {
    throw new InvalidEnabledNativeToolIdsError([rawToolIds]);
  }
  const invalidValues = rawToolIds.filter(
    (toolId): boolean => typeof toolId !== 'string' || !DESKTOP_NATIVE_TOOL_ID_SET.has(toolId)
  );
  if (invalidValues.length > 0) {
    throw new InvalidEnabledNativeToolIdsError(invalidValues);
  }
}

function respondToInvalidEnabledNativeToolIds(
  res: http.ServerResponse,
  invalidValues: readonly unknown[]
): void {
  const correlationId = randomUUID();
  const identifiers = Array.from(
    new Set(
      invalidValues.map((value) => {
        if (typeof value === 'string' && SAFE_NATIVE_TOOL_ID_PATTERN.test(value)) {
          return value;
        }
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        return `sha256:${createHash('sha256')
          .update(serialized ?? String(value))
          .digest('hex')
          .slice(0, 12)}`;
      })
    )
  );
  logger.warn('Rejected unknown enabled native tool ids', {
    correlationId,
    toolIdentifiers: identifiers,
  });
  respondJson(res, 400, {
    correlationId,
    error: 'invalid_enabled_native_tool_ids',
    message: 'Assistant request contains unknown enabled native tool IDs.',
    stage: 'native_tool_preferences',
  });
}

function respondToAssistantPayloadError(res: http.ServerResponse, error: unknown): boolean {
  if (error instanceof InvalidEnabledNativeToolIdsError) {
    respondToInvalidEnabledNativeToolIds(res, error.invalidValues);
    return true;
  }
  if (
    error instanceof AssistantInvalidJsonError ||
    error instanceof AssistantMessageValidationError ||
    error instanceof AssistantRequestEnvelopeValidationError
  ) {
    respondJson(res, 400, {
      error: error.code,
      message: error.message,
    });
    return true;
  }
  if (error instanceof AssistantRequestBodyTooLargeError) {
    res.setHeader('Connection', 'close');
    respondJson(res, 413, {
      error: error.code,
      message: error.message,
    });
    return true;
  }
  return false;
}

async function handleAssistantStatus(
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

async function handleOpenRouterModelMetadata(
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
async function handleSuspendedRunsRequest(
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

const ASSISTANT_CORS_ALLOWED_HEADERS =
  'Accept, Content-Type, Last-Event-ID, X-Brainstrike-Assistant-Token';
const ASSISTANT_CORS_EXPOSED_HEADERS = [
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
].join(', ');
const ASSISTANT_CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ASSISTANT_CORS_ALLOW_CREDENTIALS = 'true';
const ASSISTANT_CORS_NULL_ORIGIN = 'null';
const ASSISTANT_CORS_ALLOWED_RENDERER_ORIGIN = new URL(DESKTOP_DEV_RENDERER_URL).origin;

function isAllowedAssistantOrigin(origin: string): boolean {
  // Packaged Electron loads from file:// and sends Origin: null.
  // This is a deliberate trade-off for desktop compatibility while the server
  // remains loopback-only. If this server is ever exposed beyond loopback,
  // remove this allowance and require explicit origin whitelisting.
  if (origin === ASSISTANT_CORS_NULL_ORIGIN) {
    return true;
  }

  if (app.isPackaged) {
    return false;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  return parsedOrigin.origin === ASSISTANT_CORS_ALLOWED_RENDERER_ORIGIN;
}

function resolveRequestOrigin(req: http.IncomingMessage): string {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    return ASSISTANT_CORS_NULL_ORIGIN;
  }

  if (isAllowedAssistantOrigin(origin)) {
    return origin;
  }

  return ASSISTANT_CORS_NULL_ORIGIN;
}

function hasDisallowedAssistantOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    return false;
  }

  return !isAllowedAssistantOrigin(origin);
}

function applyAssistantCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = resolveRequestOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', ASSISTANT_CORS_ALLOWED_HEADERS);
  res.setHeader('Access-Control-Allow-Methods', ASSISTANT_CORS_ALLOWED_METHODS);
  res.setHeader('Access-Control-Expose-Headers', ASSISTANT_CORS_EXPOSED_HEADERS);
  if (origin !== ASSISTANT_CORS_NULL_ORIGIN) {
    res.setHeader('Access-Control-Allow-Credentials', ASSISTANT_CORS_ALLOW_CREDENTIALS);
  }
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function isAssistantCorsPreflight(req: http.IncomingMessage): boolean {
  return (
    req.method === 'OPTIONS' && typeof req.headers['access-control-request-method'] === 'string'
  );
}

function resolveRequestedProvider(data: RuntimeData | undefined): SupportedProvider | undefined {
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

function parseObservationalMemoryModelTarget(
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
function resolveDesktopObserverUsageTarget(
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

function parseSemanticRecallEmbeddingModelTarget(
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

async function resolveProviderApiKey(provider: string): Promise<string | undefined> {
  if (!isSupportedProvider(provider)) {
    return;
  }

  const supportedProvider = provider as SupportedProvider;

  const envKey = resolveProviderEnvKey(supportedProvider);
  if (envKey) {
    logger.info('Using environment API key for provider', { provider });
    return envKey;
  }

  const storedKey = await readProviderSecretKey(supportedProvider);
  if (storedKey) {
    logger.info('Retrieved stored API key for provider', { provider });
    return storedKey;
  }
  return;
}

async function collectAvailableProviders(): Promise<{
  providerErrors: Array<{
    code: string;
    error: 'api_key_unreadable';
    message: string;
    provider: SupportedProvider;
  }>;
  providerKeySources: ProviderKeySource<SupportedProvider>[];
  providers: string[];
}> {
  const inspection = await inspectProviderKeys();
  const providers = new Set(inspection.configuredProviders.map(({ provider }) => provider));

  // Local provider is always available (runs in-browser, no API key needed)
  providers.add('local');

  return {
    providerErrors: inspection.readFailures.map((failure) => ({
      code: failure.code,
      error: 'api_key_unreadable' as const,
      message: failure.message,
      provider: failure.provider,
    })),
    providerKeySources: inspection.configuredProviders,
    providers: Array.from(providers),
  };
}

function hydrateRuntimeDataWithLocalRuntimeToken(
  runtimeData: RuntimeData,
  provider: string,
  fetchedApiKey: string | undefined
): RuntimeData {
  // Only local-runtime providers need their `apiToken` injected into
  // providerOptions so the OpenAI-compat factory can forward it as a bearer
  // header. Hosted providers receive the key through the top-level `apiKey`.
  if (!((provider === 'ollama' || provider === 'lmstudio') && fetchedApiKey)) {
    return runtimeData;
  }

  const providerOptions = { ...(runtimeData.providerOptions ?? {}) };
  const existing = providerOptions[provider];
  providerOptions[provider] = {
    ...(existing ?? {}),
    apiToken: fetchedApiKey,
  };

  return {
    ...runtimeData,
    providerOptions,
  };
}

function hasPromptContent(messages: AgentMessage[]): boolean {
  return hasAssistantPromptContent(messages);
}

async function resolveProviderApiKeyOrRespond(
  provider: string,
  res: http.ServerResponse
): Promise<{ apiKey: string | undefined } | undefined> {
  try {
    return { apiKey: await resolveProviderApiKey(provider) };
  } catch (error) {
    if (respondToSecretReadError(res, error)) {
      return;
    }
    throw error;
  }
}

function respondForbiddenOrigin(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', ASSISTANT_CORS_NULL_ORIGIN);
  res.setHeader('Vary', 'Origin');

  respondJson(res, 403, {
    error: 'forbidden_origin',
    message: 'Requests from this origin are not allowed.',
  });
}

async function parseAssistantRequestPayload(
  req: http.IncomingMessage
): Promise<AssistantRequestPayload> {
  const body = await readRequestBody(req, {
    maxBodyBytes: assistantRequestBodyLimitBytes,
  });
  const payload = parseAssistantRequestPayloadText(body);
  const toolApprovalActionResult = readToolApprovalRunConfigAction(payload.runConfig);
  const toolResumeActionResult = readToolResumeRunConfigAction(payload.runConfig);
  const parsedPayload: AssistantRequestPayload = { ...payload };
  validateEnabledNativeToolIds(parsedPayload.data);

  if (toolApprovalActionResult) {
    if ('invalid' in toolApprovalActionResult) {
      parsedPayload.toolApprovalActionInvalid = true;
    } else {
      parsedPayload.toolApprovalAction = toolApprovalActionResult.action;
    }
  }

  if (toolResumeActionResult) {
    if ('invalid' in toolResumeActionResult) {
      parsedPayload.toolResumeActionInvalid = true;
    } else {
      parsedPayload.toolResumeAction = toolResumeActionResult.action;
    }
  }

  return parsedPayload;
}

async function resumeStreamIfAvailable(
  res: http.ServerResponse,
  lastEventId: string | undefined
): Promise<boolean> {
  const session = resolveDataStreamSession(lastEventId);
  if (!session) {
    return false;
  }

  logger.info('Resuming assistant stream', { lastEventId });
  const response = session.createResponse(
    lastEventId ? { resumeFromEventId: lastEventId } : undefined
  );
  await streamResponse(res, response, undefined);
  return true;
}

async function handleAssistantResumeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const lastEventId = readLastEventId(req);
  if (!lastEventId) {
    respondJson(res, 400, {
      error: 'missing_assistant_event_id',
      message: 'Assistant stream resume requires a Last-Event-ID header.',
    });
    return;
  }
  if (await resumeStreamIfAvailable(res, lastEventId)) {
    return;
  }
  respondJson(res, 404, {
    error: 'assistant_stream_unavailable',
    message: 'The assistant stream is no longer available for replay.',
  });
}

function isLocalChatProvider(runtimeData: RuntimeData | undefined): boolean {
  const provider = typeof runtimeData?.provider === 'string' ? runtimeData.provider.trim() : '';
  return provider.toLowerCase() === 'local';
}

/** Model id from a 'local/<modelId>' observational-memory target, if active. */
function resolveLocalObservationalMemoryModelId(
  runtimeData: RuntimeData | undefined
): string | undefined {
  const observationalMemory = runtimeData?.memory?.memorySettings?.observationalMemory;
  if (!observationalMemory?.enabled) {
    return;
  }
  const target = observationalMemory.modelTarget?.trim() ?? '';
  if (!target.toLowerCase().startsWith('local/')) {
    return;
  }
  const modelId = target.slice('local/'.length).trim();
  return modelId.length > 0 ? modelId : undefined;
}

function resolveLocalLlmHostClient(
  runtimeData: RuntimeData | undefined,
  toolDependencies: {
    readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
  }
): ReturnType<typeof createMainLlmHostClient> | undefined {
  const needsClient =
    isLocalChatProvider(runtimeData) ||
    resolveLocalObservationalMemoryModelId(runtimeData) !== undefined;
  if (!needsClient) {
    return;
  }
  const manager = toolDependencies.llmHostManager;
  if (!manager) {
    throw new Error(
      'The built-in local model requires the llm-host manager; the assistant server was started without one.'
    );
  }
  return createMainLlmHostClient(manager);
}

function resolveLocalModelId(runtimeData: RuntimeData | undefined): string {
  const requested = typeof runtimeData?.model === 'string' ? runtimeData.model.trim() : '';
  if (requested.length > 0) {
    return requested;
  }
  const fallback = PROVIDER_DEFAULT_MODELS['local'];
  if (!fallback) {
    throw new Error('No default model is registered for the local provider.');
  }
  return fallback;
}

/**
 * Every local model this request will drive (chat and/or memory), deduped.
 *
 * SINGLE-ENGINE ASSUMPTION: the llm-host backend holds ONE engine, so warming
 * model A then model B unloads A. With today's catalog (one Gemma spec) chat
 * and local-OM targets always dedupe to one id; if the local catalog grows a
 * second spec, differing chat/OM targets would thrash (warm A → warm B
 * unloads A → the chat generation reloads A → the OM observation reloads B…).
 */
function collectLocalLlmWarmupModelIds(runtimeData: RuntimeData | undefined): string[] {
  const modelIds = new Set<string>();
  if (isLocalChatProvider(runtimeData)) {
    modelIds.add(resolveLocalModelId(runtimeData));
  }
  const memoryModelId = resolveLocalObservationalMemoryModelId(runtimeData);
  if (memoryModelId) {
    modelIds.add(memoryModelId);
  }
  return [...modelIds];
}

/**
 * Read the current thread's task list for re-injection this turn. Returns `[]`
 * when there is no thread, no DB, the run targets the built-in local provider,
 * or the read fails (a warn is logged) — an absent plan is a legitimate empty
 * state, not a swallowed policy fallback. The local-provider skip is the
 * DB-read-avoiding gate of the same policy enforced again (defense in depth)
 * by the provider check on `taskListNote` in agent-runtime.ts, and by omitting
 * the manageTaskList tool for local in buildDesktopAssistantTools.
 */
async function readThreadTaskListForTurn(
  runtimeData: RuntimeData | undefined,
  database: Parameters<typeof readThreadTaskList>[0] | null
): Promise<readonly AssistantTaskItem[]> {
  const threadId = runtimeData?.memory?.threadId;
  if (!(threadId && database) || isLocalChatProvider(runtimeData)) {
    return [];
  }
  try {
    return await readThreadTaskList(database, threadId);
  } catch (error) {
    logger.warn('Failed to read thread task list; no task-list block this turn.', { error });
    return [];
  }
}

interface InitialStreamMemoryOptions {
  memory?: DesktopMastraMemoryResult['memory'];
  storage?: DesktopMastraMemoryResult['storage'];
  toolOutputArtifactInlineMaxSerializedCharsByToolName?: ReadonlyMap<string, number>;
  toolOutputArtifactStore?: ToolOutputArtifactSettlementStore;
}

interface ToolOutputArtifactCapabilities {
  toolOutputArtifactReader?: ScopedToolOutputArtifactReader;
  toolOutputArtifactStore?: ToolOutputArtifactSettlementStore;
}

function buildToolOutputArtifactCapabilities(
  runtimeData: RuntimeData | undefined,
  runId: string | undefined
): ToolOutputArtifactCapabilities {
  const resourceId = runtimeData?.memory?.resourceId;
  const threadId = runtimeData?.memory?.threadId;
  if (!(resourceId && threadId)) {
    return {};
  }
  const toolOutputArtifactReader: ScopedToolOutputArtifactReader = {
    readRange: async (input) => {
      const database = await getDatabase();
      return new ToolOutputArtifactRepository(database).readRange({
        ...input,
        resourceId,
        threadId,
      });
    },
  };
  if (!runId) {
    return { toolOutputArtifactReader };
  }
  return {
    toolOutputArtifactReader,
    toolOutputArtifactStore: {
      store: async (input) => {
        const database = await getDatabase();
        return new ToolOutputArtifactRepository(database).store({
          ...input,
          resourceId,
          runId,
          threadId,
        });
      },
    },
  };
}

function withToolOutputArtifactReader(
  dependencies: DesktopAssistantToolDependencies,
  reader: ScopedToolOutputArtifactReader | undefined
): DesktopAssistantToolDependencies {
  if (!reader) {
    return dependencies;
  }
  return { ...dependencies, toolOutputArtifactReader: reader };
}

function withSkillScriptResolver(
  dependencies: DesktopAssistantToolDependencies,
  resolver: ReturnType<typeof prepareRequestSkillsFromDisk>['workspaceSkills']
): DesktopAssistantToolDependencies {
  if (!resolver) {
    return dependencies;
  }
  return { ...dependencies, skillScriptResolver: resolver };
}

function buildInitialStreamMemoryOptions(
  memoryResult: DesktopMastraMemoryResult | undefined,
  toolOutputArtifactStore: ToolOutputArtifactSettlementStore | undefined
): InitialStreamMemoryOptions {
  return {
    ...(memoryResult ? { memory: memoryResult.memory, storage: memoryResult.storage } : {}),
    ...(toolOutputArtifactStore
      ? {
          toolOutputArtifactInlineMaxSerializedCharsByToolName: new Map([
            [NATIVE_TOOL_ID.webExtract, WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS],
          ]),
          toolOutputArtifactStore,
        }
      : {}),
  };
}

/**
 * Pick the initial stream for the turn: approval-resume, suspend-resume
 * (submitPlan/askUser), or a fresh generation. Both resume paths skip
 * `injectReferencedFilesContext` — there is no new user turn to scan — mirroring
 * the approval path's contract.
 */
async function resolveInitialAgentStream(args: {
  messages: AgentMessage[];
  runtime: RuntimeData;
  memoryOptions: InitialStreamMemoryOptions;
  toolApprovalAction: AssistantToolApprovalAction | undefined;
  toolResumeAction: AssistantToolResumeAction | undefined;
}): Promise<AsyncIterable<StreamChunk>> {
  const { messages, runtime, memoryOptions, toolApprovalAction, toolResumeAction } = args;
  if (toolApprovalAction) {
    return streamMastraToolApprovalAction(toolApprovalAction, {
      ...memoryOptions,
      requireToolApproval: true,
      runtime,
    });
  }
  if (toolResumeAction) {
    return streamMastraToolResumeAction(toolResumeAction, { ...memoryOptions, runtime });
  }
  // Prepend the turn's `@file` references (referenced-files), then any explicit
  // `:skill[name]` activations, then the mounted roots' workspace instructions
  // (AGENTS.md/AGENT.md/CLAUDE.md). Instructions are applied LAST so they land
  // at the FRONT of the message array — general workspace conventions precede
  // the turn's skill activations, which precede the turn-specific referenced
  // files and the conversation. All are no-ops (same array identity) when
  // nothing applies.
  const withReferencedFiles = await injectReferencedFilesContext(
    messages,
    runtime,
    readWorkspaceTextFile
  );
  const withSkillActivations = await injectActivatedSkillsContext(
    withReferencedFiles,
    runtime.workspaceSkills
  );
  return toAiSdkStyleStream(
    await injectWorkspaceInstructionsContext(withSkillActivations, runtime, readWorkspaceTextFile),
    runtime,
    memoryOptions
  );
}

/**
 * Build the TRUSTED per-request Agent Skills engine over a SecureRoot fs
 * surface spanning the request's resolved workspace roots + the home dir.
 * Extracted from initializeAgentStream for the cognitive-complexity budget.
 */
function prepareRequestSkillsFromDisk(runtimeData: RuntimeData | undefined): {
  workspaceSkills?: ScannedWorkspaceSkills;
} {
  const { workspaceSkills } = prepareRequestSkills({
    fs: createSecureSkillsFs([
      ...(runtimeData?.workspaceRoots ?? [])
        .map((root) => root.path)
        .filter((rootPath): rootPath is string => Boolean(rootPath)),
      homedir(),
    ]),
    homedir,
    runtimeData,
  });
  // Shaped as a runtime-field fragment (like resolvePersonaRuntimeFields) so
  // the caller spreads it unconditionally.
  return workspaceSkills ? { workspaceSkills } : {};
}

/**
 * Scan user-defined personas from disk over the request's already-resolved
 * workspace roots (SecureRoot-backed fs; disposed after the scan). Extracted
 * from initializeAgentStream for the cognitive-complexity budget.
 */
function scanUserPersonasFromDisk(
  workspaceRoots: RuntimeData['workspaceRoots']
): ReturnType<typeof scanUserPersonas> {
  const filesystem = createNodeFsScanDeps();
  try {
    const scanRoots = (workspaceRoots ?? [])
      .filter((root) => Boolean(root.path))
      .map((root) => ({
        absPath: root.path,
        displayName: root.displayName,
        id: root.rootId,
      }));
    return scanUserPersonas({ homeDir: homedir(), roots: scanRoots }, filesystem);
  } finally {
    filesystem.dispose();
  }
}

/**
 * Resolve the request's persona set (built-in + user-defined, availability
 * preference applied) and any pinned-provider API keys, shaped as the runtime
 * fields to spread onto the request RuntimeData. See request-personas.ts for
 * the trust boundaries.
 */
async function resolvePersonaRuntimeFields(
  runtimeData: RuntimeData | undefined,
  subagentPersonasRequest: RuntimeData['subagentPersonasRequest']
): Promise<Pick<RuntimeData, 'personas' | 'personaProviderApiKeys'>> {
  const resolved = await resolveRequestPersonas({
    logger,
    parentProvider: runtimeData?.provider ?? '',
    request: subagentPersonasRequest,
    resolveApiKey: resolveProviderApiKey,
    scanUserPersonas: () => scanUserPersonasFromDisk(runtimeData?.workspaceRoots),
  });
  return {
    personas: resolved.personas,
    ...(resolved.personaProviderApiKeys
      ? { personaProviderApiKeys: resolved.personaProviderApiKeys }
      : {}),
  };
}

/**
 * The Stop-hook verdict recorder threaded into `finalizeHookedStream`: records
 * a hook-reported Task Ledger verdict for THIS run via the main-process DB
 * handle. Without a runId there is no run to label, so no recorder is threaded
 * (hooks themselves still run).
 */
function buildHookRunVerdictRecorder(runId: string | undefined): {
  onRunVerdict?: (verdict: HookRunVerdict) => Promise<void>;
} {
  if (!runId) {
    return {};
  }
  return {
    onRunVerdict: async (verdict: HookRunVerdict): Promise<void> => {
      const database = await getDatabase();
      await recordDesktopAssistantHookRunOutcome(database, runId, verdict);
    },
  };
}

function buildAgentStreamInitializationFailure(
  error: unknown,
  stage: AgentStreamInitializationStage
): AgentStreamFailure {
  const secretReadErrorPayload = getSecretReadErrorPayload(error);
  if (secretReadErrorPayload) {
    return {
      ok: false,
      payload: secretReadErrorPayload,
      status: 400,
    };
  }
  if (error instanceof DesktopMemoryCredentialMissingError) {
    return {
      ok: false,
      payload: {
        error: 'memory_credential_missing',
        feature: error.feature,
        message: error.message,
        provider: error.provider,
      },
      status: 400,
    };
  }
  const correlationId = randomUUID();
  logger.error('Failed to initialize assistant stream', { correlationId, error, stage });
  return {
    ok: false,
    payload: {
      correlationId,
      error: 'agent_stream_init_failed',
      message: 'Assistant stream initialization failed.',
      stage,
    },
    status: 502,
  };
}

function buildWorkspaceRootResolutionFailure(error: unknown): AgentStreamFailure {
  if (error instanceof BoundWorkspaceRootUnavailableError) {
    return {
      ok: false,
      payload: {
        error: 'bound_workspace_root_unavailable',
        message: error.message,
        stage: 'workspace_root_resolution',
      },
      status: 409,
    };
  }
  return buildAgentStreamInitializationFailure(error, 'workspace_root_resolution');
}

function stripClientWorkspaceRoots(runtimeData: RuntimeData | undefined): RuntimeData | undefined {
  if (!runtimeData) {
    return;
  }
  // `workspaceRoots` is a TRUSTED server-resolved capability inventory: its ids
  // must be the DB `roots.id` values accepted by the native tools. The renderer
  // supplies only Main/Focused ordering hints, never an authoritative root list.
  const { workspaceRoots: _ignoredClientWorkspaceRoots, ...runtimeWithoutWorkspaceRoots } =
    runtimeData;
  return runtimeWithoutWorkspaceRoots;
}

async function initializeAgentStream(
  messages: AgentMessage[],
  incomingRuntimeData: RuntimeData | undefined,
  apiKey: string | undefined,
  mcpConfig: McpConfig | undefined,
  signal: AbortSignal,
  runId: string | undefined,
  toolApprovalAction: AssistantToolApprovalAction | undefined,
  toolResumeAction: AssistantToolResumeAction | undefined,
  toolDependencies: {
    readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
    readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
  }
): Promise<AgentStreamResult> {
  // Multi-root: resolve the active workspace roots from the DB `roots` table so
  // the assistant's file/search tools can disambiguate paths across roots. The
  // helper falls back to the single focused root on an empty/failed lookup.
  const rootsDatabase = await getDatabase().catch((error: unknown) => {
    logger.warn('Workspace roots DB unavailable; tools fall back to the focused root.', { error });
    return null;
  });
  let runtimeData: RuntimeData | undefined;
  try {
    runtimeData = await enrichRuntimeDataWithWorkspaceRoots(
      stripClientWorkspaceRoots(incomingRuntimeData),
      rootsDatabase
    );
  } catch (error) {
    return buildWorkspaceRootResolutionFailure(error);
  }

  // Re-inject the current per-thread task list into the instructions this
  // turn (see readThreadTaskListForTurn for the local-provider skip).
  const taskList = await readThreadTaskListForTurn(runtimeData, rootsDatabase);

  // Build runtime context with abort signal for cancellation support
  // The signal is embedded in RuntimeData and flows through to:
  // - toAiSdkStyleStream -> streamMastraAgent -> readableStreamIterator
  // - AssistantDataStreamSession (via cancel() on Response stream)
  //
  // `permissionPolicyRequest` (renderer-supplied) is stripped here and resolved
  // into the TRUSTED `permissionPolicy` below: only when the user opted in
  // (`enforce: true`) is a snapshot built (with server-owned tool risk
  // classification); otherwise `permissionPolicy` stays unset and the runtime
  // gate is a no-op (passthrough — current production behavior). A malformed
  // policy is NOT repaired here; it surfaces from the runtime resolver.
  const {
    mcpConfig: _ignoredMcpConfig,
    // Strip any client-supplied `permissionPolicy`: the runtime gate TRUSTS this
    // field, so it must only ever be the server-resolved snapshot below — a
    // client must not be able to inject `riskByTool` or bypass the opt-in.
    permissionPolicy: _ignoredClientPermissionPolicy,
    permissionPolicyRequest,
    // Strip any client-supplied `hookRunner` for the same reason: it is the
    // TRUSTED, server-built closure (below). The renderer only ATTESTS approved
    // hashes via `hookTrustRequest`, which the server re-hashes against disk.
    hookRunner: _ignoredClientHookRunner,
    hookTrustRequest,
    // Strip any client-supplied `personaProviderApiKeys`: pinned-persona keys
    // are server-resolved from the secrets bridge below — a client must never
    // inject credentials into the runtime.
    personaProviderApiKeys: _ignoredClientPersonaKeys,
    // Strip any client-supplied `workspaceSkills`: the skills engine is the
    // TRUSTED, server-built object over the SecureRoot scan (below). The
    // renderer only sends the `skillsPreference` wire field, which can only
    // REDUCE the skill set.
    workspaceSkills: _ignoredClientWorkspaceSkills,
    // The renderer's persona availability preference; resolved (with the
    // user-persona disk scan) into `runtime.personas` below.
    subagentPersonasRequest,
    ...runtimeWithoutMcpConfig
  } = runtimeData ?? {};
  const permissionPolicy = resolveRequestPermissionPolicy(permissionPolicyRequest);

  // Subagent personas: built-ins + user-defined (scanned from
  // `.brainstrike/agents` under each mounted root and the home dir), with the
  // renderer's availability preference applied and cross-provider pin keys
  // resolved from the secrets bridge. Set on the shared runtime so BOTH the
  // initial turn and the approval/suspend-resume paths keep the `agent-<id>`
  // delegation tools; the agent runtime skips personas for the built-in local
  // provider (D10).
  const personaRuntimeFields = await resolvePersonaRuntimeFields(
    runtimeData,
    subagentPersonasRequest
  );

  let initializationStage: AgentStreamInitializationStage = 'provider_model_bootstrap';
  try {
    const localLlmHostClient = resolveLocalLlmHostClient(runtimeData, toolDependencies);
    // Tool-lifecycle hooks (desktop): build the per-request manager over the
    // mounted roots + server-resolved trust. Hook run events flow through the
    // same queued sink the memory + stream observer drain, so hook.blocked and
    // hook.notice reach the timeline. The queue is hoisted here (was built with
    // memory below) so the manager can push into it.
    const queuedRunEvents: AssistantRunEvent[] = [];
    // TRUSTED server-built runner (never the client-supplied one, stripped above);
    // present iff valid hooks exist.
    const { manager: hookManager, runner: hookRunner } = prepareRequestHooks({
      emitRunEvent: (event) => queuedRunEvents.push(hookRunEventToAssistant(event)),
      hookTrustRequest,
      logger,
      runId,
      runtimeData,
    });
    // Agent Skills: TRUSTED server-built engine over the SecureRoot scan of the
    // four skills tiers (mounted roots + home dir), with the renderer's
    // preference applied (master toggle / per-skill disables — reduce-only).
    // Undefined when skills are off or the provider is the built-in local model.
    const skillsRuntimeFields = prepareRequestSkillsFromDisk(runtimeData);
    const artifactCapabilities = buildToolOutputArtifactCapabilities(runtimeData, runId);
    initializationStage = 'native_tool_preferences';
    const mastraTools = buildDesktopAssistantTools(
      runtimeData,
      withSkillScriptResolver(
        withToolOutputArtifactReader(
          toolDependencies,
          artifactCapabilities.toolOutputArtifactReader
        ),
        skillsRuntimeFields.workspaceSkills
      )
    );
    initializationStage = 'provider_model_bootstrap';
    const runtime: RuntimeData = {
      ...runtimeWithoutMcpConfig,
      // The execute-risk shell tool is registered like every other native tool;
      // the permission gate (enforce-on-by-default → execute:ask) suspends the
      // run for per-call approval before it executes, so it is no longer gated at
      // registration time.
      mastraTools,
      mcpEnabled: true,
      signal, // ← AbortSignal passed here, used by stream iterator
      // Always set: an empty list yields no <current-task-list> block (the note
      // builder returns null), so no branch is needed here.
      taskList,
      ...(mcpConfig ? { mcpConfig } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(localLlmHostClient ? { localLlmHostClient } : {}),
      ...(permissionPolicy ? { permissionPolicy } : {}),
      ...(hookRunner ? { hookRunner } : {}),
      // TRUSTED server-built skills engine (or nothing when skills are off).
      ...skillsRuntimeFields,
      // Resolved subagent personas (built-in + user-defined, availability
      // preference applied) + pinned-provider keys — see resolvePersonaRuntimeFields.
      ...personaRuntimeFields,
    };
    // Cold model loads (multi-GB download) exceed the generate request's hard
    // 5-minute ceiling, so warm the host (20-minute ceiling, progress-aware)
    // before the Mastra loop or observational memory issues a generation.
    if (localLlmHostClient) {
      for (const modelId of collectLocalLlmWarmupModelIds(runtimeData)) {
        await localLlmHostClient.warmup(modelId, { signal });
      }
    }
    const memoryResult = runtime.memory
      ? await getDesktopMastraMemory(
          runtime.memory.memorySettings,
          runId,
          runId
            ? (event) => {
                queuedRunEvents.push({ ...event, runId });
              }
            : undefined,
          runtime,
          { embeddingHostManager: toolDependencies.embeddingHostManager }
        )
      : undefined;
    if (toolApprovalAction && !memoryResult?.storage) {
      return {
        ok: false,
        payload: {
          error: 'tool_approval_memory_required',
          message: 'Tool approval resume requires Mastra memory context with workflow storage.',
        },
        status: 400,
      };
    }
    if (toolResumeAction && !memoryResult?.storage) {
      return {
        ok: false,
        payload: {
          error: 'tool_resume_memory_required',
          message: 'Tool suspend resume requires Mastra memory context with workflow storage.',
        },
        status: 400,
      };
    }
    // @file context-insert: resolve any `:file[…]{name=…}` directives in the
    // current turn's user message into a prepended `system` context message
    // carrying the referenced files' content. Uses the same containment/size/
    // binary-guarded reader as the read tools; unresolvable references surface a
    // visible note rather than being silently dropped. Skipped on the approval-
    // resume path (no new user turn to scan).
    const memoryOptions = buildInitialStreamMemoryOptions(
      memoryResult,
      artifactCapabilities.toolOutputArtifactStore
    );

    // UserPromptSubmit (blocking): only on a FRESH turn (never the approval/
    // resume path — no new user message to gate). A block short-circuits the
    // turn with a visible message + run.failed and NEVER invokes the model;
    // additionalContext is prepended as a system message (mirrors @file inject).
    // Run-event observer wrapper (a no-op when there is no runId to stamp).
    const observe = (source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> =>
      runId
        ? persistDesktopChildRunUsage(
            observeDesktopAssistantRunEvents(source, runId, queuedRunEvents),
            runId,
            resolveDesktopObserverUsageTarget(runtime.memory?.memorySettings)
          )
        : source;

    const upsGate = await runUserPromptSubmitGate(
      hookManager,
      messages,
      Boolean(toolApprovalAction || toolResumeAction)
    );
    if (upsGate.kind === 'block') {
      // The blocked turn still streams a visible message + run.failed, but it
      // never invokes the model — record the run row as failed (not completed)
      // so persistence matches the visible failure.
      return {
        ok: true,
        stream: observe(makeHookBlockedStream(upsGate.reason)),
        terminalError: upsGate.reason,
        terminalStatus: 'failed',
      };
    }

    initializationStage = 'stream_construction';
    const stream = await resolveInitialAgentStream({
      memoryOptions,
      messages: upsGate.messages,
      runtime,
      toolApprovalAction,
      toolResumeAction,
    });
    logger.info('Assistant stream initialized');
    // Stop (notify-only in v1): fire the terminal Stop hook best-effort when the
    // stream ends (clean/error/abort). Its run events ride the queued sink the
    // observer drains. A Stop hook may additionally report a Task Ledger
    // verdict for the run (source 'hook'): recorded here via the main-process
    // DB handle, awaited in FRONT of the finish yield so it lands before the
    // post-stream terminal bookkeeping. Without a runId there is no run to
    // label, so no recorder is threaded (hooks themselves still run).
    return {
      ok: true,
      stream: finalizeHookedStream(stream, {
        logger,
        manager: hookManager,
        observe,
        ...buildHookRunVerdictRecorder(runId),
        runner: hookRunner,
        signal,
      }),
    };
  } catch (error) {
    return buildAgentStreamInitializationFailure(error, initializationStage);
  }
}

/** Host services memory construction can use (injected from the server options). */
interface DesktopMemoryDependencies {
  readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
}

async function getDesktopMastraMemory(
  memorySettings: RuntimeAssistantMemorySettings | undefined,
  runId?: string | undefined,
  eventSink?: ((event: AssistantRunEvent) => void) | undefined,
  runtimeData?: RuntimeData | undefined,
  memoryDependencies?: DesktopMemoryDependencies | undefined
): Promise<DesktopMastraMemoryResult> {
  const memoryOptions = runtimeData?.memory?.memoryOptions;
  const cacheState = createDesktopMastraMemoryCacheState({
    memoryOptions,
    memorySettings,
    runId,
    runtimeData,
  });
  if (cacheState.cachedPromise) {
    return cacheState.cachedPromise;
  }

  if (!(runId || eventSink) && needsAsyncDesktopMemoryResolution(cacheState)) {
    const resolutionKey = buildDesktopMastraMemoryResolutionKey({
      memoryOptions,
      memorySettings,
      observationalMemoryDescriptor: getDesktopMemoryModelTargetDescriptor(
        cacheState.observationalMemoryResolution
      ),
      semanticRecallEmbeddingDescriptor: getDesktopMemoryModelTargetDescriptor(
        cacheState.semanticRecallEmbeddingResolution
      ),
    });
    const pendingResolution = desktopMastraMemoryResolutionPromises.get(resolutionKey);
    if (pendingResolution) {
      return pendingResolution;
    }
    const pendingMemory = createDesktopMastraMemoryFromCacheState({
      cacheState,
      eventSink,
      memoryDependencies,
      memoryOptions,
      memorySettings,
      runId,
      runtimeData,
    });
    evictOldestDesktopMastraMemoryResolutionPromise();
    desktopMastraMemoryResolutionPromises.set(resolutionKey, pendingMemory);
    void pendingMemory.then(
      () => cleanupDesktopMastraMemoryResolutionPromise(resolutionKey, pendingMemory),
      () => cleanupDesktopMastraMemoryResolutionPromise(resolutionKey, pendingMemory)
    );
    return pendingMemory;
  }

  return createDesktopMastraMemoryFromCacheState({
    cacheState,
    eventSink,
    memoryDependencies,
    memoryOptions,
    memorySettings,
    runId,
    runtimeData,
  });
}

function createDesktopMastraMemoryCacheState({
  memoryOptions,
  memorySettings,
  runId,
  runtimeData,
}: {
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData | undefined;
}): DesktopMastraMemoryCacheState {
  const observationalMemoryDescriptor =
    resolveDesktopObservationalMemoryModelTargetDescriptor(memorySettings);
  const semanticRecallEmbeddingDescriptor =
    resolveDesktopSemanticRecallEmbeddingModelTargetDescriptor(memorySettings);
  const observationalMemoryResolution = resolveRuntimeMemoryModelTarget(
    observationalMemoryDescriptor,
    runtimeData
  );
  const semanticRecallEmbeddingResolution = resolveRuntimeMemoryModelTarget(
    semanticRecallEmbeddingDescriptor,
    runtimeData
  );
  if (
    runId ||
    observationalMemoryResolution.kind === 'needs_async_resolution' ||
    semanticRecallEmbeddingResolution.kind === 'needs_async_resolution'
  ) {
    return {
      observationalMemoryResolution,
      semanticRecallEmbeddingResolution,
    };
  }

  const cacheKey = buildDesktopMastraMemoryCacheKey({
    memoryOptions,
    memorySettings,
    observationalMemoryTarget: getResolvedDesktopMemoryModelTarget(observationalMemoryResolution),
    semanticRecallEmbeddingTarget: getResolvedDesktopMemoryModelTarget(
      semanticRecallEmbeddingResolution
    ),
  });
  return {
    cachedPromise: desktopMastraMemoryPromises.get(cacheKey),
    observationalMemoryResolution,
    semanticRecallEmbeddingResolution,
  };
}

function needsAsyncDesktopMemoryResolution(cacheState: DesktopMastraMemoryCacheState): boolean {
  return (
    cacheState.observationalMemoryResolution.kind === 'needs_async_resolution' ||
    cacheState.semanticRecallEmbeddingResolution.kind === 'needs_async_resolution'
  );
}

async function createDesktopMastraMemoryFromCacheState({
  cacheState,
  eventSink,
  memoryDependencies,
  memoryOptions,
  memorySettings,
  runId,
  runtimeData,
}: {
  readonly cacheState: DesktopMastraMemoryCacheState;
  readonly eventSink: ((event: AssistantRunEvent) => void) | undefined;
  readonly memoryDependencies: DesktopMemoryDependencies | undefined;
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData | undefined;
}): Promise<DesktopMastraMemoryResult> {
  const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
  const observationalMemoryTarget = await resolveDesktopMemoryModelTargetResolution(
    cacheState.observationalMemoryResolution,
    'observational_memory'
  );
  const semanticRecallEmbeddingTarget = await resolveDesktopMemoryModelTargetResolution(
    cacheState.semanticRecallEmbeddingResolution,
    'semantic_recall'
  );
  const { embedder, observationalMemoryModel } = createDesktopMastraMemoryProviderBindings({
    memoryDependencies,
    observationalMemoryTarget,
    runtimeData,
    semanticRecallEmbeddingTarget,
  });
  if (runId) {
    const database = await getDatabase();
    // Run-scoped memory instances intentionally bypass the shared cache so the
    // per-run event sink cannot leak observability events across concurrent runs.
    return createPgliteMastraMemory({
      database,
      ...(embedder ? { embedder } : {}),
      ...(eventSink ? { eventSink } : {}),
      ...(memoryOptions ? { memoryOptions } : {}),
      ...(memorySettings ? { memorySettings } : {}),
      ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
      runId,
    });
  }
  const cacheKey = buildDesktopMastraMemoryCacheKey({
    memoryOptions,
    memorySettings,
    observationalMemoryTarget,
    semanticRecallEmbeddingTarget,
  });
  const cachedPromise = desktopMastraMemoryPromises.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }
  const memoryPromise = (async () => {
    const database = await getDatabase();
    return createPgliteMastraMemory({
      database,
      ...(embedder ? { embedder } : {}),
      ...(memoryOptions ? { memoryOptions } : {}),
      ...(memorySettings ? { memorySettings } : {}),
      ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
    });
  })();
  evictOldestDesktopMastraMemoryPromise();
  desktopMastraMemoryPromises.set(cacheKey, memoryPromise);
  memoryPromise.catch(() => {
    if (desktopMastraMemoryPromises.get(cacheKey) === memoryPromise) {
      desktopMastraMemoryPromises.delete(cacheKey);
    }
  });
  return memoryPromise;
}

function resolveDesktopObservationalMemoryModelTargetDescriptor(
  memorySettings: RuntimeAssistantMemorySettings | undefined
): DesktopMemoryModelTargetDescriptor | undefined {
  // Absent settings must never manufacture an enabled observer — the UI
  // default's 'auto' sentinel is resolved renderer-side; requests without
  // memory settings get the construction-safe (observation-off) defaults.
  const effectiveSettings = memorySettings ?? CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
  const observationalMemorySettings = effectiveSettings.observationalMemory;
  if (!observationalMemorySettings.enabled) {
    return;
  }

  return parseObservationalMemoryModelTarget(observationalMemorySettings.modelTarget);
}

function resolveDesktopSemanticRecallEmbeddingModelTargetDescriptor(
  memorySettings: RuntimeAssistantMemorySettings | undefined
): DesktopMemoryModelTargetDescriptor | undefined {
  const effectiveSettings = memorySettings ?? CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
  const semanticRecallSettings = effectiveSettings.semanticRecall;
  // Observational-memory vector retrieval embeds observations with the SAME
  // configured embedder, so it needs the target resolved even when the
  // semantic-recall toggle itself is off (createPgliteMastraMemory throws
  // without an embedder in that mode).
  const observationalVectorRetrieval =
    effectiveSettings.observationalMemory.enabled &&
    effectiveSettings.observationalMemory.retrievalMode === 'vector';
  if (!(semanticRecallSettings.enabled || observationalVectorRetrieval)) {
    return;
  }
  if (!semanticRecallSettings.embeddingModelTarget?.trim()) {
    throw new Error(
      semanticRecallSettings.enabled
        ? 'Semantic recall requires a configured embedding model target.'
        : 'Observational vector retrieval requires a configured semantic recall embedding model target.'
    );
  }

  return parseSemanticRecallEmbeddingModelTarget(semanticRecallSettings.embeddingModelTarget);
}

function getDesktopMemoryModelTargetDescriptor<T extends DesktopMemoryModelTargetDescriptor>(
  resolution: DesktopMemoryModelTargetResolution<T>
): DesktopMemoryModelTargetDescriptor | undefined {
  if (resolution.kind === 'disabled') {
    return;
  }
  const target = resolution.kind === 'resolved' ? resolution.target : resolution.descriptor;
  return {
    model: target.model,
    provider: target.provider,
  };
}

function getResolvedDesktopMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  resolution: DesktopMemoryModelTargetResolution<T>
): (T & { readonly apiKey: string; readonly cacheKey: string }) | undefined {
  if (resolution.kind === 'disabled') {
    return;
  }
  if (resolution.kind === 'resolved') {
    return resolution.target;
  }
  throw new Error(
    `Desktop memory target "${resolution.descriptor.provider}/${resolution.descriptor.model}" requires async resolution before cache lookup.`
  );
}

/**
 * The built-in local provider needs no API key: its memory models are proxied
 * to the hidden llm-host, so the cache key carries a fixed marker instead of
 * a key hash.
 */
function resolveLocalMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  target: T
): T & { readonly apiKey: string; readonly cacheKey: string } {
  return {
    ...target,
    apiKey: '',
    cacheKey: `${target.provider}/${target.model}:local-llm-host`,
  };
}

async function resolveDesktopMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  target: T,
  feature: DesktopMemoryFeature
): Promise<T & { readonly apiKey: string; readonly cacheKey: string }> {
  const { model, provider } = target;
  if (provider === 'local') {
    return resolveLocalMemoryModelTarget(target);
  }
  const apiKey = await resolveProviderApiKey(provider);
  if (!apiKey) {
    throw new DesktopMemoryCredentialMissingError(feature, target);
  }

  return {
    ...target,
    apiKey,
    cacheKey: `${provider}/${model}:${hashSecretForCacheKey(apiKey)}`,
  };
}

async function resolveDesktopMemoryModelTargetResolution<
  T extends DesktopMemoryModelTargetDescriptor,
>(
  resolution: DesktopMemoryModelTargetResolution<T>,
  feature: DesktopMemoryFeature
): Promise<(T & { readonly apiKey: string; readonly cacheKey: string }) | undefined> {
  if (resolution.kind === 'disabled') {
    return;
  }
  if (resolution.kind === 'resolved') {
    return resolution.target;
  }
  return resolveDesktopMemoryModelTarget(resolution.descriptor, feature);
}

function resolveRuntimeMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  target: T | undefined,
  runtimeData: RuntimeData | undefined
): DesktopMemoryModelTargetResolution<T> {
  if (!target) {
    return { kind: 'disabled' };
  }
  if (target.provider === 'local') {
    return {
      kind: 'resolved',
      target: resolveLocalMemoryModelTarget(target),
    };
  }
  const runtimeProvider = resolveRequestedProvider(runtimeData);
  const apiKey =
    runtimeProvider === target.provider && runtimeData?.apiKey?.trim()
      ? runtimeData.apiKey.trim()
      : undefined;
  if (!apiKey) {
    return {
      descriptor: target,
      kind: 'needs_async_resolution',
    };
  }
  return {
    kind: 'resolved',
    target: {
      ...target,
      apiKey,
      cacheKey: `${target.provider}/${target.model}:${hashSecretForCacheKey(apiKey)}`,
    },
  };
}

/**
 * Build the semantic-recall embedder for a local target: queries are proxied
 * to the hidden embedding-host renderer, and dimensions resolve lazily from
 * the models catalog.
 */
function createLocalSemanticRecallEmbedder(
  modelId: string,
  memoryDependencies: DesktopMemoryDependencies | undefined
): ReturnType<typeof createEmbeddingProvider> {
  const embeddingHostManager = memoryDependencies?.embeddingHostManager;
  if (!embeddingHostManager) {
    throw new Error(
      'Local semantic recall requires the embedding host manager; the assistant server was started without one.'
    );
  }
  // Mastra ships an internal copy of the AI SDK v5 types, so the structurally
  // identical EmbeddingModelV2 needs the same cast provider-factory uses for
  // MastraModelConfig.
  return createLocalHostEmbeddingModel({
    client: embeddingHostManager,
    modelId,
    resolveDimensions: () => resolveLocalEmbeddingDimensions(modelId),
  }) as unknown as ReturnType<typeof createEmbeddingProvider>;
}

async function resolveLocalEmbeddingDimensions(modelId: string): Promise<number> {
  const database = await getDatabase();
  const result = await database.query(
    'SELECT capabilities FROM models WHERE id = $1 AND provider_id = $2 LIMIT 1',
    [modelId, 'local']
  );
  const row = (result.rows as Array<{ capabilities?: unknown }>)[0];
  if (!row) {
    throw new Error(`Local embedding model "${modelId}" is not in the model catalog.`);
  }
  const capabilities =
    typeof row.capabilities === 'string'
      ? (JSON.parse(row.capabilities) as { defaultDimension?: unknown })
      : (row.capabilities as { defaultDimension?: unknown } | null | undefined);
  const dimension = capabilities?.defaultDimension;
  if (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error(
      `Local embedding model "${modelId}" has no valid defaultDimension in the model catalog.`
    );
  }
  return dimension;
}

function createDesktopMastraMemoryProviderBindings({
  memoryDependencies,
  observationalMemoryTarget,
  runtimeData,
  semanticRecallEmbeddingTarget,
}: {
  readonly memoryDependencies: DesktopMemoryDependencies | undefined;
  readonly observationalMemoryTarget: DesktopObservationalMemoryModelTarget | undefined;
  readonly runtimeData: RuntimeData | undefined;
  readonly semanticRecallEmbeddingTarget: DesktopSemanticRecallEmbeddingModelTarget | undefined;
}): {
  readonly embedder: ReturnType<typeof createEmbeddingProvider> | undefined;
  readonly observationalMemoryModel: ReturnType<typeof createLanguageModelProvider> | undefined;
} {
  if (observationalMemoryTarget?.provider === 'local' && !runtimeData?.localLlmHostClient) {
    // Without the injected client, createLanguageModelProvider would construct the
    // in-process browser backend, which cannot run in Electron main.
    throw new Error(
      'Local observational memory model requires the llm-host proxy client on the runtime.'
    );
  }
  const observationalMemoryModel = observationalMemoryTarget
    ? createLanguageModelProvider(
        observationalMemoryTarget.provider,
        observationalMemoryTarget.apiKey,
        observationalMemoryTarget.model,
        runtimeData
      )
    : undefined;
  let embedder: ReturnType<typeof createEmbeddingProvider> | undefined;
  if (semanticRecallEmbeddingTarget) {
    embedder =
      semanticRecallEmbeddingTarget.provider === 'local'
        ? createLocalSemanticRecallEmbedder(semanticRecallEmbeddingTarget.model, memoryDependencies)
        : createEmbeddingProvider(
            semanticRecallEmbeddingTarget.provider,
            semanticRecallEmbeddingTarget.apiKey,
            semanticRecallEmbeddingTarget.model
          );
  }
  return { embedder, observationalMemoryModel };
}

function buildDesktopMastraMemoryCacheKey({
  memoryOptions,
  memorySettings,
  observationalMemoryTarget,
  semanticRecallEmbeddingTarget,
}: {
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly observationalMemoryTarget: DesktopObservationalMemoryModelTarget | undefined;
  readonly semanticRecallEmbeddingTarget: DesktopSemanticRecallEmbeddingModelTarget | undefined;
}): string {
  return stableJsonStringify({
    memoryOptions: memoryOptions ?? null,
    memorySettings: memorySettings ?? null,
    observationalMemoryModel: observationalMemoryTarget?.cacheKey ?? null,
    semanticRecallEmbedder: semanticRecallEmbeddingTarget?.cacheKey ?? null,
  });
}

function buildDesktopMastraMemoryResolutionKey({
  memoryOptions,
  memorySettings,
  observationalMemoryDescriptor,
  semanticRecallEmbeddingDescriptor,
}: {
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly observationalMemoryDescriptor: DesktopMemoryModelTargetDescriptor | undefined;
  readonly semanticRecallEmbeddingDescriptor: DesktopMemoryModelTargetDescriptor | undefined;
}): string {
  return stableJsonStringify({
    memoryOptions: memoryOptions ?? null,
    memorySettings: memorySettings ?? null,
    observationalMemoryDescriptor: observationalMemoryDescriptor ?? null,
    semanticRecallEmbeddingDescriptor: semanticRecallEmbeddingDescriptor ?? null,
  });
}

function cleanupDesktopMastraMemoryResolutionPromise(
  resolutionKey: string,
  pendingMemory: DesktopMastraMemoryPromise
): void {
  if (desktopMastraMemoryResolutionPromises.get(resolutionKey) === pendingMemory) {
    desktopMastraMemoryResolutionPromises.delete(resolutionKey);
  }
}

function evictOldestDesktopMastraMemoryPromise(): void {
  if (desktopMastraMemoryPromises.size < DESKTOP_MEMORY_CACHE_LIMIT) {
    return;
  }
  const oldestKey = desktopMastraMemoryPromises.keys().next().value;
  if (typeof oldestKey === 'string') {
    desktopMastraMemoryPromises.delete(oldestKey);
  }
}

function evictOldestDesktopMastraMemoryResolutionPromise(): void {
  if (desktopMastraMemoryResolutionPromises.size < DESKTOP_MEMORY_CACHE_LIMIT) {
    return;
  }
  const oldestKey = desktopMastraMemoryResolutionPromises.keys().next().value;
  if (typeof oldestKey === 'string') {
    desktopMastraMemoryResolutionPromises.delete(oldestKey);
  }
}

function hashSecretForCacheKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  // Relational operators are significantly faster than localeCompare for ASCII strings
  // which is exactly what object keys are in 99% of these payloads
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => [key, sortJsonValue((value as Record<string, unknown>)[key])])
  );
}

export function resetDesktopMastraMemoryCacheForTests(): void {
  desktopMastraMemoryPromises.clear();
  desktopMastraMemoryResolutionPromises.clear();
}

export async function getDesktopMastraMemoryForTests(
  memorySettings: RuntimeAssistantMemorySettings | undefined,
  runtimeData?: RuntimeData | undefined,
  memoryDependencies?: {
    readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  }
): Promise<DesktopMastraMemoryResult> {
  return getDesktopMastraMemory(
    memorySettings,
    undefined,
    undefined,
    runtimeData,
    memoryDependencies
  );
}
