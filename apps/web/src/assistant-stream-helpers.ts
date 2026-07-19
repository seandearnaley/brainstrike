import type http from 'node:http';
import {
  type AssistantUiMessage,
  assistantDataStreamSessions,
  convertAssistantUiMessages,
  readToolApprovalRunConfigAction,
  resolveDataStreamSession,
  type StreamChunk,
  sanitizeStreamChunk,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import type { AssistantProviderConfig } from './server/assistant-config';
import { resolveAssistantProviderConfig } from './server/assistant-config';
import {
  InvalidWebAssistantRuntimeDataError,
  resolveWebAssistantRuntime,
} from './server/web-assistant-runtime';
import { buildWebAssistantStream } from './server/web-mastra-storage';

export type { StreamChunk };

const logger = createLogger('WebAssistantStream');

type ServerResponseWithFlush = http.ServerResponse & {
  flushHeaders?: () => void;
};

export async function readBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

export async function handleChatEndpoint(
  body: { messages?: unknown; data?: unknown },
  res: http.ServerResponse
): Promise<void> {
  const provider = resolveAssistantProviderConfig();
  if (!(provider.enabled && provider.apiKey)) {
    sendAssistantDisabledResponse(res, provider);
    return;
  }

  const rawMessages = Array.isArray(body?.messages) ? (body.messages as AssistantUiMessage[]) : [];
  const agentMessages = convertAssistantUiMessages(rawMessages);
  const data = body?.data ?? undefined;

  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await toAiSdkStyleStream(
      agentMessages,
      resolveWebAssistantRuntime(data, provider.apiKey)
    );
  } catch (error) {
    if (error instanceof InvalidWebAssistantRuntimeDataError) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'invalid_runtime_data', message: error.message }));
      return;
    }
    logger.error('Failed to initialize chat stream', { error });
    res.writeHead(502, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed',
      })
    );
    return;
  }

  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });

  for await (const chunk of stream) {
    const safeChunk = sanitizeStreamChunk(chunk);
    res.write(`${JSON.stringify(safeChunk)}\n`);
  }

  res.end();
}

export async function handleAssistantEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: { messages?: unknown; data?: unknown; runConfig?: unknown }
): Promise<void> {
  const provider = resolveAssistantProviderConfig();
  if (!(provider.enabled && provider.apiKey)) {
    sendAssistantDisabledResponse(res, provider);
    return;
  }

  const lastEventId = readLastEventId(req);
  const existingSession = resolveDataStreamSession(lastEventId);
  if (existingSession) {
    const response = existingSession.createResponse(
      lastEventId ? { resumeFromEventId: lastEventId } : undefined
    );
    await streamResponse(res, response, req);
    return;
  }

  // Validate any approval action up front (400 on malformed). A valid action
  // resumes a SUSPENDED run below with workflow storage — no longer a 501. Only a
  // normal turn carries user messages; the resume path has none.
  const approvalResult = readToolApprovalRunConfigAction(body?.runConfig);
  if (approvalResult && 'invalid' in approvalResult) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'invalid_tool_approval_action',
        message: 'Tool approval action must include action, runId, and toolCallId.',
      })
    );
    return;
  }
  const toolApprovalAction = approvalResult?.action;

  const data = body?.data ?? undefined;
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (req) {
    req.on('close', onAbort);
    req.on('aborted', onAbort);
  }
  const removeAbortListeners = (): void => {
    if (req) {
      req.removeListener('close', onAbort);
      req.removeListener('aborted', onAbort);
    }
  };

  let agentStream: AsyncIterable<StreamChunk>;
  try {
    const rawMessages = Array.isArray(body?.messages)
      ? (body.messages as AssistantUiMessage[])
      : [];
    // The seam admits only explicit request metadata and resolves the trusted
    // permission policy; server-only runtime fields fail visibly.
    agentStream = await buildWebAssistantStream({
      agentMessages: toolApprovalAction ? [] : convertAssistantUiMessages(rawMessages),
      apiKey: provider.apiKey,
      data,
      signal: abortController.signal,
      ...(toolApprovalAction ? { toolApprovalAction } : {}),
    });
  } catch (error) {
    removeAbortListeners();
    if (error instanceof InvalidWebAssistantRuntimeDataError) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'invalid_runtime_data', message: error.message }));
      return;
    }
    logger.error('Failed to initialize assistant stream', { error });
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed',
      })
    );
    return;
  }

  const session = assistantDataStreamSessions.create(agentStream);
  const response = session.createResponse();
  try {
    await streamResponse(res, response, req);
  } finally {
    removeAbortListeners();
  }
}

export function sendAssistantStatusResponse(res: http.ServerResponse): void {
  const provider = resolveAssistantProviderConfig();
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(assistantStatusPayload(provider)));
}

function sendAssistantDisabledResponse(
  res: http.ServerResponse,
  provider: AssistantProviderConfig
): void {
  res.writeHead(503, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(
    JSON.stringify({
      error: 'assistant_disabled',
      reason: assistantStatusPayload(provider).reason,
    })
  );
}

function assistantStatusPayload(provider: AssistantProviderConfig): {
  enabled: boolean;
  reason?: string;
} {
  if (provider.enabled && provider.apiKey) {
    return { enabled: true };
  }
  return {
    enabled: false,
    reason: provider.disabledReason ?? 'missing_api_key',
  };
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

function writeResponseHeaders(res: http.ServerResponse, response: Response): void {
  const headersObject: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    headersObject[key] = value;
  }
  res.writeHead(response.status, headersObject);
}

function flushResponse(res: http.ServerResponse): void {
  const resWithFlush = res as ServerResponseWithFlush;
  if (typeof resWithFlush.flushHeaders === 'function') {
    resWithFlush.flushHeaders();
  }
}

async function writeChunkToResponse(value: Uint8Array, res: http.ServerResponse): Promise<void> {
  const writeResult = res.write(value);
  flushResponse(res);
  if (!writeResult) {
    await new Promise<void>((resolve) => res.once('drain', resolve));
  }
}

async function pipeStreamToResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: http.ServerResponse,
  signal: AbortSignal
): Promise<void> {
  try {
    while (!(signal.aborted || res.destroyed)) {
      const { done, value } = await reader.read();
      if (done || signal.aborted || res.destroyed) {
        break;
      }
      if (value?.length > 0) {
        await writeChunkToResponse(value, res);
      }
    }
  } catch (error) {
    if (!(signal.aborted || res.destroyed)) {
      logger.error('Failed to stream assistant response', { error });
    }
  }
}

async function streamResponse(
  res: http.ServerResponse,
  response: Response,
  req?: http.IncomingMessage
): Promise<void> {
  writeResponseHeaders(res, response);

  const body = response.body as unknown as ReadableStream<Uint8Array> | null;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  const abortController = new AbortController();
  const abort = () => abortController.abort();

  if (req) {
    req.on('close', abort);
    req.on('aborted', abort);
  }

  try {
    await pipeStreamToResponse(reader, res, abortController.signal);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel errors
    }
    res.end();
    if (req) {
      req.removeListener('close', abort);
      req.removeListener('aborted', abort);
    }
  }
}
