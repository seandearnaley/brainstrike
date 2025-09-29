import http from 'node:http';
import {
  assistantDataStreamSessions,
  convertAssistantUiMessages,
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

  const { rawMessages, data } = await parseAssistantRequestPayload(req);
  const apiKey = await readOpenAIApiKey();
  const messages = convertAssistantUiMessages(rawMessages);
  console.info('[assistant-server] request received', {
    messageCount: messages.length,
    hasApiKey: Boolean(apiKey),
  });

  if (!hasNonEmptyPrompt(messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'empty_prompt' }));
    return;
  }

  const lastEventId = readLastEventId(req);
  if (await resumeStreamIfAvailable(res, lastEventId)) {
    return;
  }

  // Create abort controller to propagate cancellation from HTTP request to agent stream
  // When client disconnects or cancels request, this signal flows through:
  // 1. HTTP request events (close/aborted) trigger onAbort
  // 2. Signal passed to initializeAgentStream -> RuntimeData
  // 3. RuntimeData.signal used by Mastra stream iterator
  // 4. Session checks abort flag and stops consuming source
  const abortController = new AbortController();
  const onAbort = () => {
    abortController.abort();
  };
  if (req) {
    req.on('close', onAbort);
    req.on('aborted', onAbort);
  }

  const mcpConfig = (await loadMcpConfig()).config;
  const streamResult = await initializeAgentStream(
    messages,
    data,
    apiKey,
    mcpConfig,
    abortController.signal
  );
  if (!streamResult.ok) {
    if (req) {
      req.removeListener('close', onAbort);
      req.removeListener('aborted', onAbort);
    }
    respondJson(res, streamResult.status, streamResult.payload);
    return;
  }
  try {
    const session = assistantDataStreamSessions.create(streamResult.stream);
    const response = session.createResponse();
    await streamResponse(res, response, abortController.signal);
  } catch (error) {
    if (!abortController.signal.aborted) {
      console.error('[assistant-server] stream error', error);
    }
  } finally {
    if (req) {
      req.removeListener('close', onAbort);
      req.removeListener('aborted', onAbort);
    }
  }
}

async function handleAssistantStatus(res: http.ServerResponse): Promise<void> {
  try {
    const apiKey = await readOpenAIApiKey();
    const enabled = Boolean(apiKey);
    const payload = enabled ? { enabled } : { enabled, reason: 'missing_api_key' };
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
    ...(apiKey ? { apiKey } : {}),
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
