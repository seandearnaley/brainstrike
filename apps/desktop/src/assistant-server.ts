import http from 'node:http';
import {
  assistantDataStreamSessions,
  convertAssistantUiMessages,
  isSupportedProvider,
  resolveDataStreamSession,
  toAiSdkStyleStream,
  webTools,
} from '@brainstrike/agent';

type AgentModule = typeof import('@brainstrike/agent');
type AgentMessage = AgentModule['AgentMessage'];
type AssistantUiMessage = AgentModule['AssistantUiMessageStrict'];
type RuntimeData = AgentModule['RuntimeData'];
type StreamChunk = AgentModule['StreamChunk'];
type McpConfig = AgentModule['McpConfig'];

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

import { readRequestBody, streamResponse } from './assistant-server/http';
import { loadMcpConfig } from './mcp-loader';
import { readOpenAIApiKey } from './openai-api-key';
import { getSecretsService } from './secrets';

export function startAssistantServer(portHint?: number) {
  const server = http.createServer(async (req, res) => {
    await handleAssistantRequest(req, res).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'assistant server error' }));
    });
  });

  const port = Number(process.env['BS_ASSISTANT_PORT'] ?? portHint ?? 0) || 0;
  return new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        url,
        stop: async () => await new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function handleAssistantRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
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
  const apiKey = await resolveProviderApiKey(provider);

  console.info('[assistant-server] request received', {
    messageCount: messages.length,
    provider,
    hasApiKey: Boolean(apiKey),
  });

  if (!apiKey) {
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
      console.error('[assistant-server] stream error', error);
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

function resolveRequestedProvider(data: RuntimeData | undefined): string | undefined {
  const raw = typeof data?.provider === 'string' ? data.provider.trim() : '';
  if (!raw) {
    return undefined;
  }

  const normalized = raw.toLowerCase();
  return isSupportedProvider(normalized) ? normalized : undefined;
}

async function resolveProviderApiKey(provider: string): Promise<string | undefined> {
  if (!isSupportedProvider(provider)) {
    return undefined;
  }

  try {
    const secretsService = getSecretsService();
    const key = await secretsService.getKey(provider);
    const resolvedKey = key ?? undefined;
    console.info(
      `[assistant-server] Retrieved API key for provider "${provider}":`,
      resolvedKey ? 'present' : 'undefined'
    );
    if (resolvedKey) {
      return resolvedKey;
    }
    if (provider !== 'openai') {
      return undefined;
    }
  } catch (error) {
    console.error(`[assistant-server] Error getting API key for provider "${provider}":`, error);
    if (provider !== 'openai') {
      return undefined;
    }
  }

  return await readLegacyOpenAiKey();
}

async function readLegacyOpenAiKey(log = true): Promise<string | undefined> {
  try {
    const legacyKey = await readOpenAIApiKey();
    if (log) {
      console.info(
        '[assistant-server] Using legacy OpenAI key:',
        legacyKey ? 'present' : 'undefined'
      );
    }
    return legacyKey ?? undefined;
  } catch (error) {
    console.error('[assistant-server] Error reading legacy OpenAI key:', error);
    throw error;
  }
}

async function collectAvailableProviders(): Promise<string[]> {
  const providers = new Set<string>();

  try {
    const secretsService = getSecretsService();
    const stored = await secretsService.listProviders();
    for (const provider of stored) {
      if (!isSupportedProvider(provider)) continue;
      const key = await secretsService.getKey(provider);
      if (key && key.trim().length > 0) {
        providers.add(provider);
      }
    }
  } catch (error) {
    console.error('[assistant-server] Failed to inspect stored provider keys:', error);
  }

  const legacyOpenAi = await readLegacyOpenAiKey(false);
  if (legacyOpenAi) {
    providers.add('openai');
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
  const lastUser = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastText =
    lastUser?.parts.find((part: AgentMessage['parts'][number]) => part.type === 'text')?.text ?? '';
  return Boolean(lastText && lastText.trim().length > 0);
}

function readLastEventId(req: http.IncomingMessage): string | undefined {
  const header = req.headers['last-event-id'];
  if (!header) return undefined;
  if (Array.isArray(header)) {
    return header[header.length - 1];
  }
  return header;
}

function resolveAssistantRoute(req: http.IncomingMessage): AssistantRoute {
  const url = req.url ?? '';
  if (req.method === 'GET' && (url.endsWith('/assistant/status') || url === '/status')) {
    return 'status';
  }
  if (req.method === 'POST' && (url.endsWith('/assistant') || url === '/')) {
    return 'assistant';
  }
  return 'not-found';
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

  console.info('[assistant-server] resuming stream', { lastEventId });
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
    mcpConfig,
    mastraTools: webTools,
    signal, // ← AbortSignal passed here, used by stream iterator
    apiKey,
  };

  try {
    const stream = await toAiSdkStyleStream(messages, runtime);
    console.info('[assistant-server] stream initialized');
    return { ok: true, stream };
  } catch (error) {
    console.error('[assistant-server] failed to initialize assistant stream', error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 502,
      payload: { error: 'agent_stream_init_failed', message },
    };
  }
}
