import http from 'node:http';
import type {
  AgentMessage,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  RuntimeData,
} from '@brainstrike/agent';
import { assistantDataStreamSessions } from '@brainstrike/agent';
import {
  ASSISTANT_AUTH_HEADER_NAME,
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
} from '@brainstrike/assistant-contract';
import type { AssistantLlmHostManager } from '@brainstrike/assistant-service/ports';
import { prepareAssistantPostRequest } from '@brainstrike/assistant-service/request';
import {
  registerSteerableRun,
  unregisterSteerableRun,
} from '@brainstrike/assistant-service/steering';
import { initializeAgentStream } from './assistant-server/agent-stream-init';
import {
  type AssistantServerAuth,
  isAuthorizedAssistantToken,
  mintAssistantServerAuthToken,
} from './assistant-server/auth';
import { handleCancelRequest, handleSteerRequest } from './assistant-server/control-endpoints';
import {
  applyAssistantCorsHeaders,
  hasDisallowedAssistantOrigin,
  isAssistantCorsPreflight,
  respondForbiddenOrigin,
} from './assistant-server/cors';
import {
  assistantRequestBodyLimitBytes,
  readRequestBody,
  streamResponse,
} from './assistant-server/http';
import {
  respondAssistantRejection,
  respondJson,
  respondNotFound,
} from './assistant-server/http-responses';
import { desktopAssistantServerLogger } from './assistant-server/logger';
import { resolveProviderApiKey } from './assistant-server/provider-credentials';
import { registerRequestAbort } from './assistant-server/request-abort';
import { readLastEventId, resolveAssistantRoute } from './assistant-server/routing';
import { recordDesktopAssistantThreadRunStatus } from './assistant-server/run-persistence';
import type { AssistantServerOptions } from './assistant-server/server-options';
import {
  handleAssistantStatus,
  handleOpenRouterModelMetadata,
  handleSuspendedRunsRequest,
} from './assistant-server/status-endpoints';
import {
  handleAssistantResumeRequest,
  resumeStreamIfAvailable,
} from './assistant-server/stream-resume';
import { getDatabase } from './db-main';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { loadMcpConfig } from './mcp-loader';

const logger = desktopAssistantServerLogger;

export { desktopAssistantServerLogger };

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

async function handleAssistantPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions
): Promise<void> {
  const prepared = await prepareAssistantPostRequest({
    logger,
    readBody: () => readRequestBody(req, { maxBodyBytes: assistantRequestBodyLimitBytes }),
    resolveProviderApiKey,
  });
  if (!prepared.ok) {
    respondAssistantRejection(res, prepared.rejection);
    return;
  }
  const {
    assistantMessageId,
    messages,
    runtimeData,
    apiKey,
    toolApprovalAction,
    toolResumeAction,
  } = prepared.request;

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
      message,
      getDatabase
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
  const streamResult = await initializeAgentStream({
    apiKey,
    getDatabase,
    mcpConfig,
    messages,
    resolveProviderApiKey,
    runId,
    runtimeData,
    signal: executionSignal,
    toolApprovalAction,
    toolDependencies,
    toolResumeAction,
  });
  if (!streamResult.ok) {
    if (runId) {
      await recordDesktopAssistantThreadRunStatus(
        runId,
        'failed',
        streamResult.payload.message,
        getDatabase
      );
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
        : (streamResult.terminalError ?? sessionOutcome.error),
      getDatabase
    );
  }
}
