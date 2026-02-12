import http from 'node:http';
import type {
  AgentMessage,
  AssistantUiMessageStrict,
  McpConfig,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import {
  assistantDataStreamSessions,
  convertAssistantUiMessages,
  isSupportedProvider,
  resolveDataStreamSession,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/utils';

type AssistantUiMessage = AssistantUiMessageStrict;

type AssistantRoute = 'status' | 'assistant' | 'not-found';
interface AssistantRequestPayload {
  rawMessages: AssistantUiMessage[];
  data: RuntimeData | undefined;
}
interface AgentStreamSuccess {
  ok: true;
  stream: AsyncIterable<StreamChunk>;
}
interface AgentStreamFailure {
  ok: false;
  status: number;
  payload: { error: string; message: string };
}
type AgentStreamResult = AgentStreamSuccess | AgentStreamFailure;

import { buildDesktopAssistantTools } from './assistant-server/assistant-tools';
import { readRequestBody, streamResponse } from './assistant-server/http';
import { buildAssistantTools } from './assistant-server/retrieval-tool';
import { loadMcpConfig } from './mcp-loader';
import { readOpenAIApiKey } from './openai-api-key';
import {
  listConfiguredProviders,
  readProviderSecretKey,
  resolveProviderEnvKey,
} from './provider-api-key';

const logger = createLogger('DesktopAssistantServer');
export const desktopAssistantServerLogger = logger;

export interface AssistantServerOptions {
  listen?: boolean;
  host?: string;
}

export function startAssistantServer(portHint?: number, options: AssistantServerOptions = {}) {
  const server = http.createServer(async (req, res) => {
    await handleAssistantRequest(req, res).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
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
  res: http.ServerResponse
): Promise<void> {
  applyAssistantCorsHeaders(req, res);

  if (isAssistantCorsPreflight(req)) {
    if (hasDisallowedAssistantOrigin(req)) {
      respondForbiddenOrigin(res);
      return;
    }

    res.writeHead(204);
    res.end();
    return;
  }

  if (hasDisallowedAssistantOrigin(req)) {
    respondForbiddenOrigin(res);
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

  await handleAssistantPost(req, res);
}

async function handleAssistantPost(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const { rawMessages, data } = await parseAssistantRequestPayload(req);
  const messages = convertAssistantUiMessages(rawMessages);
  const provider = resolveRequestedProvider(data);

  if (!provider) {
    respondJson(res, 400, {
      error: 'missing_provider',
      message: 'No provider specified or provider is not supported.',
    });
    return;
  }

  const runtimeData = data ? { ...data, provider } : { provider };

  // Local provider runs entirely client-side and doesn't need an API key
  const isLocalProvider = provider === 'local';
  const apiKey = isLocalProvider ? '' : await resolveProviderApiKey(provider);

  logger.info('Assistant request received', {
    messageCount: messages.length,
    provider,
    hasApiKey: Boolean(apiKey) || isLocalProvider,
  });

  if (!(apiKey || isLocalProvider)) {
    respondJson(res, 400, {
      error: 'missing_api_key',
      message: `No API key configured for provider "${provider}".`,
    });
    return;
  }

  if (!hasNonEmptyPrompt(messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'empty_prompt' }));
    return;
  }

  const lastEventId = readLastEventId(req);
  if (await resumeStreamIfAvailable(res, lastEventId)) {
    return;
  }
  const { signal, cleanup } = registerRequestAbort(req);
  try {
    const mcpConfig = (await loadMcpConfig()).config;
    const streamResult = await initializeAgentStream(
      messages,
      runtimeData,
      apiKey,
      mcpConfig,
      signal
    );
    if (!streamResult.ok) {
      respondJson(res, streamResult.status, streamResult.payload);
      return;
    }

    const session = assistantDataStreamSessions.create(streamResult.stream);
    const response = session.createResponse();
    await streamResponse(res, response, signal);
  } catch (error) {
    if (!signal.aborted) {
      logger.error('Assistant stream error', { error });
    }
  } finally {
    cleanup();
  }
}

async function handleAssistantStatus(res: http.ServerResponse): Promise<void> {
  try {
    const providers = await collectAvailableProviders();
    const enabled = providers.length > 0;
    const payload = enabled
      ? { enabled, providers }
      : { enabled, reason: 'no_providers_configured', providers: [] as string[] };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'assistant_status_failed',
        message: error instanceof Error ? error.message : String(error),
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
  res.setHeader('Access-Control-Allow-Origin', resolveRequestOrigin(req));
  res.setHeader('Access-Control-Allow-Headers', ASSISTANT_CORS_ALLOWED_HEADERS);
  res.setHeader('Access-Control-Allow-Methods', ASSISTANT_CORS_ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Credentials', ASSISTANT_CORS_ALLOW_CREDENTIALS);
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

function hasNonEmptyPrompt(messages: AgentMessage[]): boolean {
  const lastUser = messages.length > 0 ? messages.at(-1) : undefined;
  const lastText =
    lastUser?.parts.find((part: AgentMessage['parts'][number]) => part.type === 'text')?.text ?? '';
  return Boolean(lastText && lastText.trim().length > 0);
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function respondForbiddenOrigin(res: http.ServerResponse): void {
  respondJson(res, 403, {
    error: 'forbidden_origin',
    message: 'Requests from this origin are not allowed.',
  });
}

async function parseAssistantRequestPayload(
  req: http.IncomingMessage
): Promise<AssistantRequestPayload> {
  const body = await readRequestBody(req);
  const parsed: unknown = JSON.parse(body || '{}');
  const maybePayload = parsed as Partial<{ messages: AssistantUiMessage[]; data: RuntimeData }>;
  const rawMessages = Array.isArray(maybePayload?.messages)
    ? (maybePayload.messages as AssistantUiMessage[])
    : [];
  const data = maybePayload?.data ?? undefined;
  return { rawMessages, data };
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

async function initializeAgentStream(
  messages: AgentMessage[],
  runtimeData: RuntimeData | undefined,
  apiKey: string | undefined,
  mcpConfig: McpConfig | undefined,
  signal: AbortSignal
): Promise<AgentStreamResult> {
  // Build runtime context with abort signal for cancellation support
  // The signal is embedded in RuntimeData and flows through to:
  // - toAiSdkStyleStream -> streamMastraAgent -> readableStreamIterator
  // - AssistantDataStreamSession (via cancel() on Response stream)
  const runtime: RuntimeData = {
    ...runtimeData,
    mcpEnabled: true,
    mastraTools: buildAssistantTools(runtimeData, buildDesktopAssistantTools(runtimeData)),
    signal, // ← AbortSignal passed here, used by stream iterator
    ...(mcpConfig ? { mcpConfig } : {}),
    ...(apiKey ? { apiKey } : {}),
  };

  try {
    const stream = await toAiSdkStyleStream(messages, runtime);
    logger.info('Assistant stream initialized');
    return { ok: true, stream };
  } catch (error) {
    logger.error('Failed to initialize assistant stream', { error });
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 502,
      payload: { error: 'agent_stream_init_failed', message },
    };
  }
}
