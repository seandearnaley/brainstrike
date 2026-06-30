import { createHash } from 'node:crypto';
import http from 'node:http';
import type {
  AgentMessage,
  AssistantRunEvent,
  AssistantRunPersistenceRuntimeEngine,
  AssistantToolApprovalAction,
  AssistantUiMessageStrict,
  McpConfig,
  RuntimeAssistantMemorySettings,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantInvalidJsonError,
  AssistantRequestBodyTooLargeError,
  assistantDataStreamSessions,
  buildAppendAssistantRunEventQuery,
  buildCompleteAssistantThreadRunQuery,
  convertAssistantUiMessages,
  createEmbeddingProvider,
  createLocalHostEmbeddingModel,
  createProvider,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  hasNonEmptyAssistantPrompt,
  isSupportedProvider,
  PROVIDER_DEFAULT_MODELS,
  parseAssistantRequestPayloadText,
  readToolApprovalRunConfigAction,
  resolveAssistantRequestBodyLimitBytes,
  resolveDataStreamSession,
  resolveRequestPermissionPolicy,
  sanitizeAssistantRunEventMetadata,
  streamMastraToolApprovalAction,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import type { DatabaseDiagnosticsSnapshot } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';

type AssistantUiMessage = AssistantUiMessageStrict;

type AssistantRoute = 'status' | 'assistant' | 'not-found';
interface AssistantRequestPayload {
  data: RuntimeData | undefined;
  rawMessages: AssistantUiMessage[];
  toolApprovalAction?: AssistantToolApprovalAction;
  toolApprovalActionInvalid?: boolean;
}
interface AgentStreamSuccess {
  ok: true;
  stream: AsyncIterable<StreamChunk>;
}
interface AgentStreamFailure {
  ok: false;
  payload: { error: string; message: string };
  status: number;
}
type AgentStreamResult = AgentStreamSuccess | AgentStreamFailure;

import {
  buildDesktopAssistantTools,
  readWorkspaceTextFile,
} from './assistant-server/assistant-tools';
import { readRequestBody, streamResponse } from './assistant-server/http';
import {
  type AssistantLlmHostManager,
  createMainLlmHostClient,
} from './assistant-server/local-llm-host-client';
import { injectReferencedFilesContext } from './assistant-server/referenced-files-context';
import type { ManagedCacheBatchApplier } from './assistant-server/reindex-edited-file';
import { enrichRuntimeDataWithWorkspaceRoots } from './assistant-server/workspace-roots';
import { getDatabase, getDatabaseRuntimeDiagnostics } from './db-main';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { loadMcpConfig } from './mcp-loader';
import { readOpenAIApiKey } from './openai-api-key';
import {
  listConfiguredProviders,
  readProviderSecretKey,
  resolveProviderEnvKey,
} from './provider-api-key';

const logger = createLogger('DesktopAssistantServer');
export const desktopAssistantServerLogger = logger;
const assistantRequestBodyLimitBytes = resolveAssistantRequestBodyLimitBytes(
  process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]
);
type DesktopMastraMemoryResult =
  | import('@brainstrike/agent/pglite-mastra-memory').PgliteMastraMemoryResult
  | import('@brainstrike/agent/turso-mastra-memory').TursoMastraMemoryResult;
type DesktopMastraMemoryPromise = Promise<DesktopMastraMemoryResult>;
type DesktopMastraMemoryRuntimeEngine = 'pglite' | 'turso';
type DesktopAssistantPersistenceRuntimeEngine = AssistantRunPersistenceRuntimeEngine;

const DESKTOP_MEMORY_CACHE_LIMIT = 16;
// Fully resolved memory instances are keyed by provider/model plus hashed API
// keys. Pending keychain resolutions are keyed by unresolved descriptors so
// concurrent desktop requests dedupe before the concrete cache key exists.
// Each map is independently bounded to the same small desktop cache limit.
const desktopMastraMemoryPromises = new Map<string, DesktopMastraMemoryPromise>();
const desktopMastraMemoryResolutionPromises = new Map<string, DesktopMastraMemoryPromise>();
let desktopMastraMemoryDatabaseContextPromise:
  | Promise<DesktopMastraMemoryDatabaseContext>
  | undefined;
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

type RuntimeMemoryOptions = NonNullable<RuntimeData['memory']>['memoryOptions'];

interface DesktopMastraMemoryCacheState {
  readonly observationalMemoryDescriptor?: DesktopMemoryModelTargetDescriptor | undefined;
  readonly observationalMemoryTarget?: DesktopObservationalMemoryModelTarget | undefined;
  readonly semanticRecallEmbeddingDescriptor?: DesktopMemoryModelTargetDescriptor | undefined;
  readonly semanticRecallEmbeddingTarget?: DesktopSemanticRecallEmbeddingModelTarget | undefined;
}

interface DesktopMastraMemoryDatabaseContext {
  readonly database: Awaited<ReturnType<typeof getDatabase>>;
  readonly runtimeCacheKey: string;
  readonly runtimeEngine: DesktopMastraMemoryRuntimeEngine;
}

export interface AssistantServerOptions {
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  host?: string;
  listen?: boolean;
  llmHostManager?: AssistantLlmHostManager | null | undefined;
  managedCacheBatchApplier?: ManagedCacheBatchApplier | null | undefined;
}

export function startAssistantServer(portHint?: number, options: AssistantServerOptions = {}) {
  const server = http.createServer(async (req, res) => {
    await handleAssistantRequest(req, res, options).catch(() => {
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
      url: `http://${host}:${port}`,
      stop: async () => {},
    });
  }
  return new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;
      resolve({
        url,
        stop: async () => await new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export async function handleAssistantRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions = {}
): Promise<void> {
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

  const route = resolveAssistantRoute(req);
  if (route === 'status') {
    await handleAssistantStatus(res);
    return;
  }

  if (route === 'not-found') {
    respondNotFound(res);
    return;
  }

  await handleAssistantPost(req, res, options);
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
  const { messages, runtimeData, apiKey, toolApprovalAction } = prepared;

  const lastEventId = readLastEventId(req);
  if (await resumeStreamIfAvailable(res, lastEventId)) {
    return;
  }
  const { signal, cleanup } = registerRequestAbort(req);
  const runId = runtimeData.memory?.runId;
  try {
    await streamAssistantPostResponse({
      res,
      messages,
      runtimeData,
      apiKey,
      signal,
      runId,
      toolApprovalAction,
      toolDependencies: {
        embeddingHostManager: options.embeddingHostManager,
        llmHostManager: options.llmHostManager,
        managedCacheBatchApplier: options.managedCacheBatchApplier,
      },
    });
  } catch (error) {
    await handleAssistantPostStreamError({ res, runId, signal, error });
  } finally {
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
  signal,
  runId,
  toolApprovalAction,
  toolDependencies,
}: {
  readonly res: http.ServerResponse;
  readonly messages: AgentMessage[];
  readonly runtimeData: RuntimeData;
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
  readonly runId: string | undefined;
  readonly toolApprovalAction?: AssistantToolApprovalAction;
  readonly toolDependencies: {
    readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
    readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
    readonly managedCacheBatchApplier?: ManagedCacheBatchApplier | null | undefined;
  };
}): Promise<void> {
  const mcpConfig = (await loadMcpConfig()).config;
  const streamResult = await initializeAgentStream(
    messages,
    runtimeData,
    apiKey,
    mcpConfig,
    signal,
    runId,
    toolApprovalAction,
    toolDependencies
  );
  if (!streamResult.ok) {
    if (runId) {
      await recordDesktopAssistantThreadRunStatus(runId, 'failed', streamResult.payload.message);
    }
    respondJson(res, streamResult.status, streamResult.payload);
    return;
  }

  const session = assistantDataStreamSessions.create(streamResult.stream);
  const response = session.createResponse();
  await streamResponse(res, response, signal);
  if (runId) {
    await recordDesktopAssistantThreadRunStatus(runId, 'completed', null);
  }
}

async function* observeDesktopAssistantRunEvents(
  stream: AsyncIterable<StreamChunk>,
  runId: string,
  queuedEvents: AssistantRunEvent[],
  runtimeEngine: DesktopAssistantPersistenceRuntimeEngine
): AsyncIterable<StreamChunk> {
  let sequence = 0;
  let persistenceErrorCount = 0;
  let persistenceError: unknown;
  let persistenceQueue: Promise<void> = Promise.resolve();
  const persistEvent = (event: AssistantRunEvent): void => {
    persistenceQueue = persistenceQueue
      .then(() => recordDesktopAssistantRunEvent(runId, event, runtimeEngine))
      .catch((error: unknown) => {
        persistenceErrorCount += 1;
        persistenceError ??= error;
        logger.error('Failed to persist assistant run event', {
          error,
          eventId: event.id,
          runId,
        });
      });
  };
  const flushPersistedEvents = async (): Promise<void> => {
    await persistenceQueue;
    if (persistenceError) {
      if (persistenceErrorCount > 1) {
        logger.error('Multiple assistant run events failed to persist', {
          firstError: persistenceError,
          failureCount: persistenceErrorCount,
          runId,
          suppressedFailureCount: persistenceErrorCount - 1,
        });
      }
      throw persistenceError;
    }
  };
  const drainQueuedEvents = async function* (): AsyncIterable<StreamChunk> {
    while (queuedEvents.length > 0) {
      const queuedEvent = queuedEvents.shift();
      if (!queuedEvent) {
        continue;
      }
      const event: AssistantRunEvent = {
        ...queuedEvent,
        runId,
        sequence: queuedEvent.sequence ?? sequence,
      };
      sequence = Math.max(sequence, (event.sequence ?? sequence) + 1);
      persistEvent(event);
      yield { type: 'run-event', event };
    }
  };
  let sourceError: unknown;
  let persistenceFlushError: unknown;
  try {
    yield* drainQueuedEvents();
    for await (const chunk of stream) {
      yield* drainQueuedEvents();
      if (chunk.type !== 'run-event') {
        yield chunk;
        continue;
      }
      const event: AssistantRunEvent = {
        ...chunk.event,
        runId,
        sequence: chunk.event.sequence ?? sequence,
      };
      sequence = Math.max(sequence, (event.sequence ?? sequence) + 1);
      persistEvent(event);
      yield { type: 'run-event', event };
    }
    yield* drainQueuedEvents();
  } catch (error) {
    sourceError = error;
  } finally {
    try {
      await flushPersistedEvents();
    } catch (error) {
      persistenceFlushError = error;
    }
  }

  if (persistenceFlushError) {
    if (!sourceError) {
      throw persistenceFlushError;
    }
    logger.error('Failed to flush assistant run event persistence after stream error', {
      error: persistenceFlushError,
      runId,
      sourceError,
    });
  }
  if (sourceError) {
    throw sourceError;
  }
}

async function wrapDesktopAssistantRunEventPersistence(
  stream: AsyncIterable<StreamChunk>,
  runId: string | undefined,
  queuedEvents: AssistantRunEvent[]
): Promise<AsyncIterable<StreamChunk>> {
  if (!runId) {
    return stream;
  }
  const runtimeEngine = await resolveDesktopAssistantPersistenceRuntimeEngine();
  return observeDesktopAssistantRunEvents(stream, runId, queuedEvents, runtimeEngine);
}

async function recordDesktopAssistantThreadRunStatus(
  runId: string,
  status: 'cancelled' | 'completed' | 'failed',
  error: string | null
): Promise<void> {
  try {
    await completeDesktopAssistantThreadRun(runId, status, error);
  } catch (statusError) {
    logger.error('Failed to update assistant thread run status', {
      error: statusError,
      runId,
      status,
    });
  }
}

async function completeDesktopAssistantThreadRun(
  runId: string,
  status: 'cancelled' | 'completed' | 'failed',
  error: string | null
): Promise<void> {
  const now = new Date();
  const database = await getDatabase();
  const runtimeEngine = await resolveDesktopAssistantPersistenceRuntimeEngine();
  const query = buildCompleteAssistantThreadRunQuery({
    error,
    now,
    runId,
    runtimeEngine,
    status,
  });
  await database.query(query.sql, query.params);
}

async function recordDesktopAssistantRunEvent(
  runId: string,
  event: AssistantRunEvent,
  runtimeEngine: DesktopAssistantPersistenceRuntimeEngine
): Promise<void> {
  const now = new Date();
  const metadata = sanitizeAssistantRunEventMetadata(event.metadata);
  const database = await getDatabase();
  const query = buildAppendAssistantRunEventQuery({
    detail: event.detail ?? null,
    durationMs: event.durationMs ?? null,
    eventId: event.id,
    kind: event.kind,
    label: event.label,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
    now,
    occurredAt: new Date(event.timestamp),
    runId,
    runtimeEngine,
    sequence: event.sequence ?? 0,
    status: event.status,
  });
  await database.query(query.sql, query.params);
}

async function resolveDesktopAssistantPersistenceRuntimeEngine(): Promise<DesktopAssistantPersistenceRuntimeEngine> {
  const diagnostics = await getDatabaseRuntimeDiagnostics();
  const report = diagnostics.profileBootstrapReport;
  if (!report) {
    throw new Error('Desktop assistant persistence requires database bootstrap diagnostics.');
  }
  if (!report.ready) {
    throw new Error(
      `Desktop assistant persistence requires a ready database bootstrap report; current phase is "${report.phase}".`
    );
  }
  if (report.runtime.engine === 'pglite' || report.runtime.engine === 'turso') {
    return report.runtime.engine;
  }
  throw new Error(
    `Desktop assistant persistence does not support database runtime "${report.runtime.engine}".`
  );
}

interface PreparedAssistantPostRequest {
  apiKey: string;
  messages: AgentMessage[];
  runtimeData: RuntimeData;
  toolApprovalAction?: AssistantToolApprovalAction;
}

async function prepareAssistantPostRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<PreparedAssistantPostRequest | undefined> {
  let rawMessages: AssistantUiMessage[];
  let data: RuntimeData | undefined;
  let toolApprovalAction: AssistantToolApprovalAction | undefined;
  let toolApprovalActionInvalid = false;
  try {
    const payload = await parseAssistantRequestPayload(req);
    rawMessages = payload.rawMessages;
    data = payload.data;
    toolApprovalAction = payload.toolApprovalAction;
    toolApprovalActionInvalid = Boolean(payload.toolApprovalActionInvalid);
  } catch (error) {
    if (error instanceof AssistantInvalidJsonError) {
      respondJson(res, 400, {
        error: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof AssistantRequestBodyTooLargeError) {
      res.setHeader('Connection', 'close');
      respondJson(res, 413, {
        error: error.code,
        message: error.message,
      });
      return;
    }
    throw error;
  }

  const messages = convertAssistantUiMessages(rawMessages);
  const provider = resolveRequestedProvider(data);

  if (toolApprovalActionInvalid) {
    respondJson(res, 400, {
      error: 'invalid_tool_approval_action',
      message: 'Tool approval action must include action, runId, and toolCallId.',
    });
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
  const apiKey = provider === 'local' ? '' : await resolveProviderApiKey(provider);

  const runtimeData: RuntimeData = hydrateRuntimeDataWithLocalRuntimeToken(
    data ? { ...data, provider } : { provider },
    provider,
    apiKey
  );

  logger.info('Assistant request received', {
    messageCount: messages.length,
    provider,
    hasApiKey: Boolean(apiKey) || providerAllowsMissingAuth,
  });

  if (!(apiKey || providerAllowsMissingAuth)) {
    respondJson(res, 400, {
      error: 'missing_api_key',
      message: `No API key configured for provider "${provider}".`,
    });
    return;
  }

  if (!(toolApprovalAction || hasNonEmptyPrompt(messages))) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'empty_prompt' }));
    return;
  }

  return {
    messages,
    runtimeData,
    apiKey: apiKey ?? '',
    ...(toolApprovalAction ? { toolApprovalAction } : {}),
  };
}

async function handleAssistantStatus(res: http.ServerResponse): Promise<void> {
  try {
    const providers = await collectAvailableProviders();
    const enabled = providers.length > 0;
    const payload = enabled
      ? { enabled, providers }
      : { enabled, reason: 'no_providers_configured', providers: [] as string[] };
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

const ASSISTANT_CORS_ALLOWED_HEADERS = 'Accept, Content-Type, Last-Event-ID';
const ASSISTANT_CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ASSISTANT_CORS_ALLOW_CREDENTIALS = 'true';
const ASSISTANT_CORS_NULL_ORIGIN = 'null';
const ASSISTANT_CORS_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isAllowedAssistantOrigin(origin: string): boolean {
  // Packaged Electron loads from file:// and sends Origin: null.
  // This is a deliberate trade-off for desktop compatibility while the server
  // remains loopback-only. If this server is ever exposed beyond loopback,
  // remove this allowance and require explicit origin whitelisting.
  if (origin === ASSISTANT_CORS_NULL_ORIGIN) {
    return true;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  const isHttpProtocol = parsedOrigin.protocol === 'http:';
  if (!isHttpProtocol) {
    return false;
  }

  // Intentionally allow any localhost port to support custom dev port mappings.
  return ASSISTANT_CORS_ALLOWED_HOSTS.has(parsedOrigin.hostname);
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

function resolveRequestedProvider(data: RuntimeData | undefined): string | undefined {
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

  return { provider, model };
}

function parseObservationalMemoryModelTarget(
  modelTarget: string
): DesktopMemoryModelTargetDescriptor {
  return parseModelTarget(modelTarget, {
    allowedProviders: DESKTOP_OBSERVATIONAL_MEMORY_PROVIDERS,
    formatLabel: 'Observational memory model target',
    unsupportedProviderLabel: 'observational memory',
    disallowedProviderMessage: (provider) =>
      `Desktop observational memory requires a hosted model provider or the built-in local model; received "${provider}" in "${modelTarget}".`,
  });
}

function parseSemanticRecallEmbeddingModelTarget(
  modelTarget: string
): DesktopMemoryModelTargetDescriptor {
  return parseModelTarget(modelTarget, {
    allowedProviders: DESKTOP_SEMANTIC_RECALL_EMBEDDING_PROVIDERS,
    formatLabel: 'Semantic recall embedding model target',
    unsupportedProviderLabel: 'semantic recall embedding',
    disallowedProviderMessage: (provider) =>
      `Desktop Mastra semantic recall supports hosted OpenAI/Google embedders or the built-in local embedder; received "${provider}" in "${modelTarget}".`,
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

async function collectAvailableProviders(): Promise<string[]> {
  const providers = new Set(await listConfiguredProviders());

  // Local provider is always available (runs in-browser, no API key needed)
  providers.add('local');

  try {
    const legacy = await readOpenAIApiKey();
    if (legacy) {
      providers.add('openai');
    }
  } catch (error) {
    logger.error('Failed to read legacy OpenAI key', { error });
    throw error;
  }
  return Array.from(providers);
}

function registerRequestAbort(req: http.IncomingMessage): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  // Propagate HTTP connection cancellation into the agent stream
  const abortController = new AbortController();
  const onAbort = () => {
    abortController.abort();
  };

  req.on('close', onAbort);
  req.on('aborted', onAbort);

  return {
    signal: abortController.signal,
    cleanup: () => {
      req.removeListener('close', onAbort);
      req.removeListener('aborted', onAbort);
    },
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

function hasNonEmptyPrompt(messages: AgentMessage[]): boolean {
  return hasNonEmptyAssistantPrompt(messages);
}

function readLastEventId(req: http.IncomingMessage): string | undefined {
  const header = req.headers['last-event-id'];
  if (!header) {
    return;
  }
  if (Array.isArray(header)) {
    return header.at(-1);
  }
  return header;
}

function resolveAssistantRoute(req: http.IncomingMessage): AssistantRoute {
  const requestPath = resolveRequestPath(req);
  if (req.method === 'GET' && (requestPath === '/assistant/status' || requestPath === '/status')) {
    return 'status';
  }
  if (req.method === 'POST' && (requestPath === '/assistant' || requestPath === '/')) {
    return 'assistant';
  }
  return 'not-found';
}

function resolveRequestPath(req: http.IncomingMessage): string {
  const rawUrl = req.url ?? '/';
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return rawUrl;
  }
}

function respondNotFound(res: http.ServerResponse): void {
  res.writeHead(404).end('not found');
}

function respondJson(
  res: http.ServerResponse,
  status: number,
  payload: { error: string; message: string }
): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(payload));
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
  if (!toolApprovalActionResult) {
    return payload;
  }
  if ('invalid' in toolApprovalActionResult) {
    return { ...payload, toolApprovalActionInvalid: true };
  }
  return { ...payload, toolApprovalAction: toolApprovalActionResult.action };
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

async function initializeAgentStream(
  messages: AgentMessage[],
  incomingRuntimeData: RuntimeData | undefined,
  apiKey: string | undefined,
  mcpConfig: McpConfig | undefined,
  signal: AbortSignal,
  runId: string | undefined,
  toolApprovalAction: AssistantToolApprovalAction | undefined,
  toolDependencies: {
    readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
    readonly llmHostManager?: AssistantLlmHostManager | null | undefined;
    readonly managedCacheBatchApplier?: ManagedCacheBatchApplier | null | undefined;
  }
): Promise<AgentStreamResult> {
  // Multi-root: resolve the active workspace roots from the DB `roots` table so
  // the assistant's file/search tools can disambiguate paths across roots. The
  // helper falls back to the single focused root on an empty/failed lookup.
  const rootsDatabase = await getDatabase().catch((error: unknown) => {
    logger.warn('Workspace roots DB unavailable; tools fall back to the focused root.', { error });
    return null;
  });
  const runtimeData = await enrichRuntimeDataWithWorkspaceRoots(incomingRuntimeData, rootsDatabase);

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
    ...runtimeWithoutMcpConfig
  } = runtimeData ?? {};
  const permissionPolicy = resolveRequestPermissionPolicy(permissionPolicyRequest);

  try {
    const localLlmHostClient = resolveLocalLlmHostClient(runtimeData, toolDependencies);
    const runtime: RuntimeData = {
      ...runtimeWithoutMcpConfig,
      mcpEnabled: true,
      // The execute-risk shell tool is registered like every other native tool;
      // the permission gate (enforce-on-by-default → execute:ask) suspends the
      // run for per-call approval before it executes, so it is no longer gated at
      // registration time.
      mastraTools: buildDesktopAssistantTools(runtimeData, toolDependencies),
      signal, // ← AbortSignal passed here, used by stream iterator
      ...(mcpConfig ? { mcpConfig } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(localLlmHostClient ? { localLlmHostClient } : {}),
      ...(permissionPolicy ? { permissionPolicy } : {}),
    };
    // Cold model loads (multi-GB download) exceed the generate request's hard
    // 5-minute ceiling, so warm the host (20-minute ceiling, progress-aware)
    // before the Mastra loop or observational memory issues a generation.
    if (localLlmHostClient) {
      for (const modelId of collectLocalLlmWarmupModelIds(runtimeData)) {
        await localLlmHostClient.warmup(modelId, { signal });
      }
    }
    const queuedRunEvents: AssistantRunEvent[] = [];
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
        status: 400,
        payload: {
          error: 'tool_approval_memory_required',
          message: 'Tool approval resume requires Mastra memory context with workflow storage.',
        },
      };
    }
    // @file context-insert: resolve any `:file[…]{name=…}` directives in the
    // current turn's user message into a prepended `system` context message
    // carrying the referenced files' content. Uses the same containment/size/
    // binary-guarded reader as the read tools; unresolvable references surface a
    // visible note rather than being silently dropped. Skipped on the approval-
    // resume path (no new user turn to scan).
    const stream = toolApprovalAction
      ? await streamMastraToolApprovalAction(toolApprovalAction, {
          ...(memoryResult ? { memory: memoryResult.memory, storage: memoryResult.storage } : {}),
          requireToolApproval: true,
          runtime,
        })
      : await toAiSdkStyleStream(
          await injectReferencedFilesContext(messages, runtime, readWorkspaceTextFile),
          runtime,
          memoryResult ? { memory: memoryResult.memory, storage: memoryResult.storage } : {}
        );
    logger.info('Assistant stream initialized');
    return {
      ok: true,
      stream: await wrapDesktopAssistantRunEventPersistence(stream, runId, queuedRunEvents),
    };
  } catch (error) {
    logger.error('Failed to initialize assistant stream', { error });
    return {
      ok: false,
      status: 502,
      payload: {
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed.',
      },
    };
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
  const databaseContext = await getDesktopMastraMemoryDatabaseContext();
  const cacheState = createDesktopMastraMemoryCacheState({
    memorySettings,
    runtimeData,
  });

  if (!(runId || eventSink) && needsAsyncDesktopMemoryResolution(cacheState)) {
    const resolutionKey = buildDesktopMastraMemoryResolutionKey({
      databaseRuntimeCacheKey: databaseContext.runtimeCacheKey,
      memoryOptions,
      memorySettings,
      observationalMemoryDescriptor: cacheState.observationalMemoryDescriptor,
      semanticRecallEmbeddingDescriptor: cacheState.semanticRecallEmbeddingDescriptor,
    });
    const pendingResolution = desktopMastraMemoryResolutionPromises.get(resolutionKey);
    if (pendingResolution) {
      return pendingResolution;
    }
    const pendingMemory = createDesktopMastraMemoryFromCacheState({
      cacheState,
      databaseContext,
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
    databaseContext,
    eventSink,
    memoryDependencies,
    memoryOptions,
    memorySettings,
    runId,
    runtimeData,
  });
}

function createDesktopMastraMemoryCacheState({
  memorySettings,
  runtimeData,
}: {
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly runtimeData: RuntimeData | undefined;
}): DesktopMastraMemoryCacheState {
  const observationalMemoryDescriptor =
    resolveDesktopObservationalMemoryModelTargetDescriptor(memorySettings);
  const semanticRecallEmbeddingDescriptor =
    resolveDesktopSemanticRecallEmbeddingModelTargetDescriptor(memorySettings);
  const observationalMemoryTarget = resolveRuntimeMemoryModelTarget(
    observationalMemoryDescriptor,
    runtimeData
  );
  const semanticRecallEmbeddingTarget = resolveRuntimeMemoryModelTarget(
    semanticRecallEmbeddingDescriptor,
    runtimeData
  );
  return {
    observationalMemoryDescriptor,
    observationalMemoryTarget,
    semanticRecallEmbeddingDescriptor,
    semanticRecallEmbeddingTarget,
  };
}

function needsAsyncDesktopMemoryResolution(cacheState: DesktopMastraMemoryCacheState): boolean {
  return Boolean(
    (cacheState.observationalMemoryDescriptor && !cacheState.observationalMemoryTarget) ||
      (cacheState.semanticRecallEmbeddingDescriptor && !cacheState.semanticRecallEmbeddingTarget)
  );
}

async function getDesktopMastraMemoryDatabaseContext(): Promise<DesktopMastraMemoryDatabaseContext> {
  if (desktopMastraMemoryDatabaseContextPromise) {
    return await desktopMastraMemoryDatabaseContextPromise;
  }
  const pendingContext = resolveDesktopMastraMemoryDatabaseContext();
  desktopMastraMemoryDatabaseContextPromise = pendingContext;
  try {
    return await pendingContext;
  } catch (error) {
    if (desktopMastraMemoryDatabaseContextPromise === pendingContext) {
      desktopMastraMemoryDatabaseContextPromise = undefined;
    }
    throw error;
  }
}

async function resolveDesktopMastraMemoryDatabaseContext(): Promise<DesktopMastraMemoryDatabaseContext> {
  // Initialize the database before reading diagnostics so the bootstrap report
  // reflects the ready runtime that memory construction will actually use.
  const database = await getDatabase();
  const diagnostics = await getDatabaseRuntimeDiagnostics();
  const runtimeEngine = resolveDesktopMastraMemoryRuntimeEngine(diagnostics);
  return {
    database,
    runtimeCacheKey: buildDesktopMastraMemoryRuntimeCacheKey(diagnostics),
    runtimeEngine,
  };
}

function resolveDesktopMastraMemoryRuntimeEngine(
  diagnostics: DatabaseDiagnosticsSnapshot
): DesktopMastraMemoryRuntimeEngine {
  const report = diagnostics.profileBootstrapReport;
  if (!report) {
    throw new Error('Desktop Mastra memory requires database bootstrap diagnostics.');
  }
  if (!report.ready) {
    throw new Error(
      `Desktop Mastra memory requires a ready database bootstrap report; current phase is "${report.phase}".`
    );
  }
  if (report.runtime.engine === 'pglite' || report.runtime.engine === 'turso') {
    return report.runtime.engine;
  }
  throw new Error(
    `Desktop Mastra memory does not support database runtime "${report.runtime.engine}".`
  );
}

function buildDesktopMastraMemoryRuntimeCacheKey(diagnostics: DatabaseDiagnosticsSnapshot): string {
  const report = diagnostics.profileBootstrapReport;
  if (!report) {
    throw new Error('Desktop Mastra memory requires database bootstrap diagnostics.');
  }
  return stableJsonStringify({
    appDataDir: diagnostics.appDataDir,
    databaseProfile: diagnostics.databaseProfile ?? null,
    dataDir: diagnostics.dataDir,
    profileId: report.profileId,
    runtime: report.runtime,
  });
}

async function createDesktopMastraMemoryFromCacheState({
  cacheState,
  databaseContext,
  eventSink,
  memoryDependencies,
  memoryOptions,
  memorySettings,
  runId,
  runtimeData,
}: {
  readonly cacheState: DesktopMastraMemoryCacheState;
  readonly databaseContext: DesktopMastraMemoryDatabaseContext;
  readonly eventSink: ((event: AssistantRunEvent) => void) | undefined;
  readonly memoryDependencies: DesktopMemoryDependencies | undefined;
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData | undefined;
}): Promise<DesktopMastraMemoryResult> {
  const observationalMemoryTarget =
    cacheState.observationalMemoryTarget ??
    (cacheState.observationalMemoryDescriptor
      ? await resolveDesktopMemoryModelTarget(
          cacheState.observationalMemoryDescriptor,
          runtimeData,
          'Observational memory model'
        )
      : undefined);
  const semanticRecallEmbeddingTarget =
    cacheState.semanticRecallEmbeddingTarget ??
    (cacheState.semanticRecallEmbeddingDescriptor
      ? await resolveDesktopMemoryModelTarget(
          cacheState.semanticRecallEmbeddingDescriptor,
          runtimeData,
          'Semantic recall embedding model'
        )
      : undefined);
  const { embedder, observationalMemoryModel } = createDesktopMastraMemoryProviderBindings({
    memoryDependencies,
    observationalMemoryTarget,
    runtimeData,
    semanticRecallEmbeddingTarget,
  });
  if (runId) {
    // Run-scoped memory instances intentionally bypass the shared cache so the
    // per-run event sink cannot leak observability events across concurrent runs.
    return createDesktopMastraMemoryForDatabaseRuntime({
      databaseContext,
      ...(embedder ? { embedder } : {}),
      ...(eventSink ? { eventSink } : {}),
      ...(memoryOptions ? { memoryOptions } : {}),
      ...(memorySettings ? { memorySettings } : {}),
      ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
      runId,
    });
  }
  const cacheKey = buildDesktopMastraMemoryCacheKey({
    databaseRuntimeCacheKey: databaseContext.runtimeCacheKey,
    memoryOptions,
    memorySettings,
    observationalMemoryTarget,
    semanticRecallEmbeddingTarget,
  });
  const cachedPromise = desktopMastraMemoryPromises.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }
  const memoryPromise = (async () =>
    createDesktopMastraMemoryForDatabaseRuntime({
      databaseContext,
      ...(embedder ? { embedder } : {}),
      ...(memoryOptions ? { memoryOptions } : {}),
      ...(memorySettings ? { memorySettings } : {}),
      ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
    }))();
  evictOldestDesktopMastraMemoryPromise();
  desktopMastraMemoryPromises.set(cacheKey, memoryPromise);
  memoryPromise.catch(() => {
    if (desktopMastraMemoryPromises.get(cacheKey) === memoryPromise) {
      desktopMastraMemoryPromises.delete(cacheKey);
    }
  });
  return memoryPromise;
}

async function createDesktopMastraMemoryForDatabaseRuntime({
  databaseContext,
  embedder,
  eventSink,
  memoryOptions,
  memorySettings,
  observationalMemoryModel,
  runId,
}: {
  readonly databaseContext: DesktopMastraMemoryDatabaseContext;
  readonly embedder?: ReturnType<typeof createEmbeddingProvider> | undefined;
  readonly eventSink?: ((event: AssistantRunEvent) => void) | undefined;
  readonly memoryOptions?: RuntimeMemoryOptions | undefined;
  readonly memorySettings?: RuntimeAssistantMemorySettings | undefined;
  readonly observationalMemoryModel?: ReturnType<typeof createProvider> | undefined;
  readonly runId?: string | undefined;
}): Promise<DesktopMastraMemoryResult> {
  if (databaseContext.runtimeEngine === 'pglite') {
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    return createPgliteMastraMemory({
      database: databaseContext.database,
      ...(embedder ? { embedder } : {}),
      ...(eventSink ? { eventSink } : {}),
      ...(memoryOptions ? { memoryOptions } : {}),
      ...(memorySettings ? { memorySettings } : {}),
      ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
      ...(runId ? { runId } : {}),
    });
  }

  const { createTursoMastraMemory } = await import('@brainstrike/agent/turso-mastra-memory');
  return createTursoMastraMemory({
    database: databaseContext.database,
    ...(embedder ? { embedder } : {}),
    ...(eventSink ? { eventSink } : {}),
    ...(memoryOptions ? { memoryOptions } : {}),
    ...(memorySettings ? { memorySettings } : {}),
    ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
    ...(runId ? { runId } : {}),
  });
}

function resolveDesktopObservationalMemoryModelTargetDescriptor(
  memorySettings: RuntimeAssistantMemorySettings | undefined
): DesktopMemoryModelTargetDescriptor | undefined {
  const effectiveSettings = memorySettings ?? DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
  const observationalMemorySettings = effectiveSettings.observationalMemory;
  if (!observationalMemorySettings.enabled) {
    return;
  }

  return parseObservationalMemoryModelTarget(observationalMemorySettings.modelTarget);
}

function resolveDesktopSemanticRecallEmbeddingModelTargetDescriptor(
  memorySettings: RuntimeAssistantMemorySettings | undefined
): DesktopMemoryModelTargetDescriptor | undefined {
  const effectiveSettings = memorySettings ?? DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
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
  runtimeData: RuntimeData | undefined,
  label: string
): Promise<T & { readonly apiKey: string; readonly cacheKey: string }> {
  const { model, provider } = target;
  if (provider === 'local') {
    return resolveLocalMemoryModelTarget(target);
  }
  const runtimeProvider = resolveRequestedProvider(runtimeData);
  const runtimeApiKey =
    runtimeProvider === provider && runtimeData?.apiKey?.trim()
      ? runtimeData.apiKey.trim()
      : undefined;
  const apiKey = runtimeApiKey ?? (await resolveProviderApiKey(provider));
  if (!apiKey) {
    throw new Error(`${label} "${provider}/${model}" requires a configured ${provider} API key.`);
  }

  return {
    ...target,
    apiKey,
    cacheKey: `${provider}/${model}:${hashSecretForCacheKey(apiKey)}`,
  };
}

function resolveRuntimeMemoryModelTarget<T extends DesktopMemoryModelTargetDescriptor>(
  target: T | undefined,
  runtimeData: RuntimeData | undefined
): (T & { readonly apiKey: string; readonly cacheKey: string }) | undefined {
  if (!target) {
    return;
  }
  if (target.provider === 'local') {
    return resolveLocalMemoryModelTarget(target);
  }
  const runtimeProvider = resolveRequestedProvider(runtimeData);
  const apiKey =
    runtimeProvider === target.provider && runtimeData?.apiKey?.trim()
      ? runtimeData.apiKey.trim()
      : undefined;
  if (!apiKey) {
    return;
  }
  return {
    ...target,
    apiKey,
    cacheKey: `${target.provider}/${target.model}:${hashSecretForCacheKey(apiKey)}`,
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
  readonly observationalMemoryModel: ReturnType<typeof createProvider> | undefined;
} {
  if (observationalMemoryTarget?.provider === 'local' && !runtimeData?.localLlmHostClient) {
    // Without the injected client, createProvider would construct the
    // in-process browser backend, which cannot run in Electron main.
    throw new Error(
      'Local observational memory model requires the llm-host proxy client on the runtime.'
    );
  }
  const observationalMemoryModel = observationalMemoryTarget
    ? createProvider(
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
  databaseRuntimeCacheKey,
  memoryOptions,
  memorySettings,
  observationalMemoryTarget,
  semanticRecallEmbeddingTarget,
}: {
  readonly databaseRuntimeCacheKey: string;
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly observationalMemoryTarget: DesktopObservationalMemoryModelTarget | undefined;
  readonly semanticRecallEmbeddingTarget: DesktopSemanticRecallEmbeddingModelTarget | undefined;
}): string {
  return stableJsonStringify({
    databaseRuntime: databaseRuntimeCacheKey,
    memoryOptions: memoryOptions ?? null,
    memorySettings: memorySettings ?? null,
    observationalMemoryModel: observationalMemoryTarget?.cacheKey ?? null,
    semanticRecallEmbedder: semanticRecallEmbeddingTarget?.cacheKey ?? null,
  });
}

function buildDesktopMastraMemoryResolutionKey({
  databaseRuntimeCacheKey,
  memoryOptions,
  memorySettings,
  observationalMemoryDescriptor,
  semanticRecallEmbeddingDescriptor,
}: {
  readonly databaseRuntimeCacheKey: string;
  readonly memoryOptions: RuntimeMemoryOptions | undefined;
  readonly memorySettings: RuntimeAssistantMemorySettings | undefined;
  readonly observationalMemoryDescriptor: DesktopMemoryModelTargetDescriptor | undefined;
  readonly semanticRecallEmbeddingDescriptor: DesktopMemoryModelTargetDescriptor | undefined;
}): string {
  return stableJsonStringify({
    databaseRuntime: databaseRuntimeCacheKey,
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
  resetDesktopMastraMemoryDatabaseContextForTests();
}

export function resetDesktopMastraMemoryDatabaseContextForTests(): void {
  desktopMastraMemoryDatabaseContextPromise = undefined;
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
