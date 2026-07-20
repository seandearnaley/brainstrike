import { createHash } from 'node:crypto';
import http from 'node:http';
import { homedir } from 'node:os';
import type {
  AgentMessage,
  AssistantRunEvent,
  AssistantTaskItem,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  AssistantUiMessageConversionResult,
  AssistantUiMessageStrict,
  McpConfig,
  RuntimeAssistantMemorySettings,
  RuntimeData,
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
  convertAssistantUiMessagesWithFinalInput,
  createEmbeddingProvider,
  createLocalHostEmbeddingModel,
  createProvider,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  hasAssistantPromptContent,
  isSupportedProvider,
  listSuspendedMastraRuns,
  PROVIDER_DEFAULT_MODELS,
  parseAssistantRequestPayloadText,
  type RediscoveredToolApproval,
  readToolApprovalRunConfigAction,
  readToolResumeRunConfigAction,
  resolveApprovalStaleMs,
  resolveAssistantRequestBodyLimitBytes,
  resolveDataStreamSession,
  resolveRequestPermissionPolicy,
  type SuspendedApprovalsResponse,
  sanitizeAssistantRunEventMetadata,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { ASSISTANT_AUTH_HEADER_NAME } from '@brainstrike/assistant-contract';
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
  requestRunSteer,
  unregisterSteerableRun,
} from './assistant-server/run-steering-registry';
import { scanUserPersonas } from './assistant-server/user-personas-loader';
import { createNodeFsScanDeps } from './ipc-user-commands-handlers';

type AssistantUiMessage = AssistantUiMessageStrict;

type AssistantRoute = 'status' | 'assistant' | 'steer' | 'suspended-runs' | 'not-found';
interface AssistantRequestPayload {
  assistantMessageId?: string;
  data: RuntimeData | undefined;
  rawMessages: AssistantUiMessage[];
  toolApprovalAction?: AssistantToolApprovalAction;
  toolApprovalActionInvalid?: boolean;
  toolResumeAction?: AssistantToolResumeAction;
  toolResumeActionInvalid?: boolean;
}
interface AgentStreamSuccess {
  ok: true;
  stream: AsyncIterable<StreamChunk>;
  terminalError?: string | null;
  /**
   * Terminal run-row status to record after the stream is served. Defaults to
   * `completed`; a turn that streams a visible failure BEFORE the model runs
   * (e.g. a UserPromptSubmit hook block) sets `failed` so the persisted run row
   * matches the visible `run.failed` event instead of a contradictory
   * `completed`.
   */
  terminalStatus?: 'cancelled' | 'completed' | 'failed';
}
interface AgentStreamFailure {
  ok: false;
  payload: { error: string; message: string };
  status: number;
}
type AgentStreamResult = AgentStreamSuccess | AgentStreamFailure;

import type { DesktopAssistantToolDependencies } from './assistant-server/assistant-tools';
import {
  buildDesktopAssistantTools,
  readWorkspaceTextFile,
} from './assistant-server/assistant-tools';
import type { HookRunVerdict } from './assistant-server/hooks/run-verdict';
import {
  finalizeHookedStream,
  hookRunEventToAssistant,
  makeHookBlockedStream,
  prepareRequestHooks,
  runUserPromptSubmitGate,
} from './assistant-server/hooks/server-integration';
import { readRequestBody, streamResponse } from './assistant-server/http';
import {
  type AssistantLlmHostManager,
  createMainLlmHostClient,
} from './assistant-server/local-llm-host-client';
import { injectReferencedFilesContext } from './assistant-server/referenced-files-context';
import { prepareRequestSkills } from './assistant-server/request-skills';
import { injectActivatedSkillsContext } from './assistant-server/skills-activation-context';
import { createSecureSkillsFs } from './assistant-server/skills-fs-deps';
import { readThreadTaskList } from './assistant-server/task-list-repository';
import { injectWorkspaceInstructionsContext } from './assistant-server/workspace-instructions-context';
import { enrichRuntimeDataWithWorkspaceRoots } from './assistant-server/workspace-roots';
import { getDatabase } from './db-main';
import { DESKTOP_DEV_RENDERER_URL } from './desktop-renderer-url';
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

const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';
const ASSISTANT_RUN_EVENTS_TABLE = 'brainstrike_assistant_run_events';
const ASSISTANT_RUN_OUTCOMES_TABLE = 'brainstrike_assistant_run_outcomes';

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
  readonly cachedPromise?: DesktopMastraMemoryPromise | undefined;
  readonly observationalMemoryDescriptor?: DesktopMemoryModelTargetDescriptor | undefined;
  readonly observationalMemoryTarget?: DesktopObservationalMemoryModelTarget | undefined;
  readonly semanticRecallEmbeddingDescriptor?: DesktopMemoryModelTargetDescriptor | undefined;
  readonly semanticRecallEmbeddingTarget?: DesktopSemanticRecallEmbeddingModelTarget | undefined;
}

export interface AssistantServerOptions {
  /**
   * Request auth. `startAssistantServer` mints a per-boot token when unset;
   * `handleAssistantRequest` throws when unset (misconfiguration must be loud).
   * `'disabled'` is the explicit opt-out for routing/CORS-focused tests.
   */
  auth?: AssistantServerAuth;
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  host?: string;
  listen?: boolean;
  llmHostManager?: AssistantLlmHostManager | null | undefined;
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
    await handleAssistantStatus(res);
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
  const { signal, cleanup } = registerRequestAbort(req);
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
      runtimeData.steering = registerSteerableRun(runId);
      registeredSteerableRun = true;
    }
    await streamAssistantPostResponse({
      apiKey,
      assistantMessageId,
      messages,
      res,
      runId,
      runtimeData,
      signal,
      toolApprovalAction,
      toolDependencies: {
        embeddingHostManager: options.embeddingHostManager,
        llmHostManager: options.llmHostManager,
      },
      toolResumeAction,
    });
  } catch (error) {
    await handleAssistantPostStreamError({ error, res, runId, signal });
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
  signal,
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
  readonly signal: AbortSignal;
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
    signal,
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
  const response = session.createResponse();
  await streamResponse(res, response, signal);
  if (runId) {
    await recordDesktopAssistantThreadRunStatus(
      runId,
      streamResult.terminalStatus ?? 'completed',
      streamResult.terminalError ?? null
    );
  }
}

export async function* observeDesktopAssistantRunEvents(
  stream: AsyncIterable<StreamChunk>,
  runId: string,
  queuedEvents: AssistantRunEvent[]
): AsyncIterable<StreamChunk> {
  let sequence = 0;
  let persistenceErrorCount = 0;
  let persistenceError: unknown;
  let persistenceQueue: Promise<void> = Promise.resolve();
  const persistEvent = (event: AssistantRunEvent): void => {
    persistenceQueue = persistenceQueue
      .then(() => recordDesktopAssistantRunEvent(runId, event))
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
          failureCount: persistenceErrorCount,
          firstError: persistenceError,
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
      yield { event, type: 'run-event' };
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
      yield { event, type: 'run-event' };
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
  await database.query(
    `UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}
     SET status = $2, error = $3, completed_at = $4, updated_at = $5
     WHERE id = $1`,
    [runId, status, error, now, now]
  );
}

/**
 * Minimal structural DB surface for the hook-run-outcome writer, so the paired
 * integration test can drive a real PGlite handle without the remote client.
 */
interface HookRunOutcomeDatabase {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Task Ledger source 'hook': persist a Stop-hook-reported verdict for a run.
 *
 * DUPLICATION NOTE (same precedent as the repository's bootstrap-SQL mirror of
 * migration 060): this upsert's column set + SET list are kept byte-consistent
 * with `recordRunOutcome` in packages/app-shell/src/assistant-memory-repository.ts.
 * Two deliberate differences: thread/resource ids are derived from the runs row
 * (mirrors recordDesktopAssistantRunEvent — the main process trusts its own
 * bookkeeping, not hook-adjacent input), and the conflict clause carries the
 * precedence rule `source <> 'user'` — a hook label must NEVER overwrite an
 * explicit user verdict, while a later user verdict (plain repository upsert)
 * still replaces a hook label. Keep the three writers' semantics in sync.
 *
 * Zero affected rows is disambiguated loudly: a missing runs row THROWS (a
 * verdict for an unknown run is a caller bug, never a silent no-op); an
 * existing user label logs the skip (expected precedence).
 */
export async function recordDesktopAssistantHookRunOutcome(
  database: HookRunOutcomeDatabase,
  runId: string,
  verdict: HookRunVerdict
): Promise<void> {
  const result = await database.query(
    `INSERT INTO ${ASSISTANT_RUN_OUTCOMES_TABLE}
      (run_id, thread_id, resource_id, verdict, source, detail, labeled_at, created_at, updated_at)
     SELECT runs.id, runs.thread_id, runs.resource_id, $2, 'hook', $3, NOW(), NOW(), NOW()
     FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
     WHERE runs.id = $1
     ON CONFLICT (run_id) DO UPDATE SET
      thread_id = EXCLUDED.thread_id,
      resource_id = EXCLUDED.resource_id,
      verdict = EXCLUDED.verdict,
      source = EXCLUDED.source,
      detail = EXCLUDED.detail,
      labeled_at = EXCLUDED.labeled_at,
      updated_at = NOW()
     WHERE ${ASSISTANT_RUN_OUTCOMES_TABLE}.source <> 'user'
     RETURNING run_id`,
    [runId, verdict.verdict, verdict.detail ?? null]
  );
  if (result.rows.length === 1) {
    return;
  }
  const run = await database.query(`SELECT 1 FROM ${ASSISTANT_THREAD_RUNS_TABLE} WHERE id = $1`, [
    runId,
  ]);
  if (run.rows.length === 0) {
    throw new Error(
      `Cannot record hook run verdict: assistant run ${runId} has no thread-run row.`
    );
  }
  logger.info('Hook run verdict skipped: an existing user label takes precedence', {
    runId,
    verdict: verdict.verdict,
  });
}

async function recordDesktopAssistantRunEvent(
  runId: string,
  event: AssistantRunEvent
): Promise<void> {
  const now = new Date();
  const metadata = sanitizeAssistantRunEventMetadata(event.metadata);
  const database = await getDatabase();
  await database.query(
    `INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}
      (
        id,
        run_id,
        resource_id,
        thread_id,
        sequence,
        kind,
        status,
        label,
        detail,
        metadata,
        duration_ms,
        occurred_at,
        created_at,
        updated_at
      )
     SELECT
        $1,
        runs.id,
        runs.resource_id,
        runs.thread_id,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9,
        $10,
        $11,
        $12
     FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
     WHERE runs.id = $2
     ON CONFLICT (id) DO UPDATE SET
        sequence = EXCLUDED.sequence,
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        label = EXCLUDED.label,
        detail = EXCLUDED.detail,
        metadata = EXCLUDED.metadata,
        duration_ms = EXCLUDED.duration_ms,
        occurred_at = EXCLUDED.occurred_at,
        updated_at = EXCLUDED.updated_at`,
    [
      event.id,
      runId,
      event.sequence ?? 0,
      event.kind,
      event.status,
      event.label,
      event.detail ?? null,
      metadata ? JSON.stringify(metadata) : null,
      event.durationMs ?? null,
      new Date(event.timestamp),
      now,
      now,
    ]
  );
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
    if (
      error instanceof AssistantInvalidJsonError ||
      error instanceof AssistantMessageValidationError ||
      error instanceof AssistantRequestEnvelopeValidationError
    ) {
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
  const apiKey = provider === 'local' ? '' : await resolveProviderApiKey(provider);

  const runtimeData: RuntimeData = hydrateRuntimeDataWithLocalRuntimeToken(
    withTrustedAssistantMessageId(data, provider, assistantMessageId),
    provider,
    apiKey
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

async function handleAssistantStatus(res: http.ServerResponse): Promise<void> {
  try {
    const providers = await collectAvailableProviders();
    const enabled = providers.length > 0;
    const payload = enabled
      ? { enabled, providers }
      : { enabled, providers: [] as string[], reason: 'no_providers_configured' };
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
      DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
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
    cleanup: () => {
      req.removeListener('close', onAbort);
      req.removeListener('aborted', onAbort);
    },
    signal: abortController.signal,
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
  if (req.method === 'POST' && (requestPath === '/assistant/steer' || requestPath === '/steer')) {
    return 'steer';
  }
  if (
    req.method === 'GET' &&
    (requestPath === '/assistant/suspended-runs' || requestPath === '/suspended-runs')
  ) {
    return 'suspended-runs';
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
  payload: { error: string; message: string; reason?: string }
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
  const toolResumeActionResult = readToolResumeRunConfigAction(payload.runConfig);
  const parsedPayload: AssistantRequestPayload = { ...payload };

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

function buildInitialStreamMemoryOptions(
  memoryResult: DesktopMastraMemoryResult | undefined,
  toolOutputArtifactStore: ToolOutputArtifactSettlementStore | undefined
): InitialStreamMemoryOptions {
  return {
    ...(memoryResult ? { memory: memoryResult.memory, storage: memoryResult.storage } : {}),
    ...(toolOutputArtifactStore ? { toolOutputArtifactStore } : {}),
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
  workspaceSkills?: NonNullable<RuntimeData['workspaceSkills']>;
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
  const runtimeData = await enrichRuntimeDataWithWorkspaceRoots(incomingRuntimeData, rootsDatabase);

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
    const runtime: RuntimeData = {
      ...runtimeWithoutMcpConfig,
      // The execute-risk shell tool is registered like every other native tool;
      // the permission gate (enforce-on-by-default → execute:ask) suspends the
      // run for per-call approval before it executes, so it is no longer gated at
      // registration time.
      mastraTools: buildDesktopAssistantTools(
        runtimeData,
        withToolOutputArtifactReader(
          toolDependencies,
          artifactCapabilities.toolOutputArtifactReader
        )
      ),
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
      runId ? observeDesktopAssistantRunEvents(source, runId, queuedRunEvents) : source;

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
    logger.error('Failed to initialize assistant stream', { error });
    return {
      ok: false,
      payload: {
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed.',
      },
      status: 502,
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
      observationalMemoryDescriptor: cacheState.observationalMemoryDescriptor,
      semanticRecallEmbeddingDescriptor: cacheState.semanticRecallEmbeddingDescriptor,
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
  const observationalMemoryTarget = resolveRuntimeMemoryModelTarget(
    observationalMemoryDescriptor,
    runtimeData
  );
  const semanticRecallEmbeddingTarget = resolveRuntimeMemoryModelTarget(
    semanticRecallEmbeddingDescriptor,
    runtimeData
  );
  if (
    runId ||
    (observationalMemoryDescriptor && !observationalMemoryTarget) ||
    (semanticRecallEmbeddingDescriptor && !semanticRecallEmbeddingTarget)
  ) {
    return {
      observationalMemoryDescriptor,
      observationalMemoryTarget,
      semanticRecallEmbeddingDescriptor,
      semanticRecallEmbeddingTarget,
    };
  }

  const cacheKey = buildDesktopMastraMemoryCacheKey({
    memoryOptions,
    memorySettings,
    observationalMemoryTarget,
    semanticRecallEmbeddingTarget,
  });
  return {
    cachedPromise: desktopMastraMemoryPromises.get(cacheKey),
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
