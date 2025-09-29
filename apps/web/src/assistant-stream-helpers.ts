import type http from 'node:http';
import {
  type AssistantUiMessage,
  assistantDataStreamSessions,
  convertAssistantUiMessages,
  type RuntimeData,
  resolveDataStreamSession,
  type StreamChunk,
  sanitizeStreamChunk,
  toAiSdkStyleStream,
  webTools,
} from '@brainstrike/agent';
import type { AssistantProviderConfig } from './server/assistant-config';
import { resolveAssistantProviderConfig } from './server/assistant-config';

export type { StreamChunk };

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
  if (!provider.enabled || !provider.apiKey) {
    sendAssistantDisabledResponse(res, provider);
    return;
  }

  const rawMessages = Array.isArray(body?.messages) ? (body.messages as AssistantUiMessage[]) : [];
  const agentMessages = convertAssistantUiMessages(rawMessages);
  const data = body?.data ?? undefined;

  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await toAiSdkStyleStream(agentMessages, {
      ...(data as RuntimeData | undefined),
      mastraTools: webTools,
      apiKey: provider.apiKey,
    });
  } catch (error) {
    console.error('[web assistant] failed to initialize chat stream', error);
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  for await (const chunk of stream) {
    const safeChunk = sanitizeStreamChunk(chunk);
    res.write(`${JSON.stringify(safeChunk)}\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  res.end();
}

export async function handleAssistantEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: { messages?: unknown; data?: unknown }
): Promise<void> {
  const provider = resolveAssistantProviderConfig();
  if (!provider.enabled || !provider.apiKey) {
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

  const rawMessages = Array.isArray(body?.messages) ? (body.messages as AssistantUiMessage[]) : [];
  const agentMessages = convertAssistantUiMessages(rawMessages);
  const data = (body?.data ?? undefined) as RuntimeData | undefined;

  let agentStream: AsyncIterable<StreamChunk>;
  try {
    agentStream = await toAiSdkStyleStream(agentMessages, {
      ...(data ?? {}),
      mastraTools: webTools,
      apiKey: provider.apiKey,
    });
  } catch (error) {
    console.error('[web assistant] failed to initialize assistant stream', error);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return;
  }

  const session = assistantDataStreamSessions.create(agentStream);
  const response = session.createResponse();
  await streamResponse(res, response, req);
}

export function sendAssistantStatusResponse(res: http.ServerResponse): void {
  const provider = resolveAssistantProviderConfig();
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(assistantStatusPayload(provider)));
}

function sendAssistantDisabledResponse(
  res: http.ServerResponse,
  provider: AssistantProviderConfig
): void {
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
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
  if (!header) return undefined;
  if (Array.isArray(header)) {
    return header[header.length - 1];
  }
  return header;
}

async function streamResponse(
  res: http.ServerResponse,
  response: Response,
  req?: http.IncomingMessage
): Promise<void> {
  const headersObject: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    headersObject[key] = value;
  }
  res.writeHead(response.status, headersObject);
  const body = response.body as unknown as ReadableStream<Uint8Array> | null;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  let aborted = false;
  const abort = () => {
    aborted = true;
  };
  if (req) {
    req.on('close', abort);
    req.on('aborted', abort);
  }
  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        res.write(value);
      }
    }
  } catch (error) {
    if (!aborted) {
      console.error('[assistant-stream] failed to stream response', error);
    }
  } finally {
    res.end();
    if (req) {
      req.removeListener('close', abort);
      req.removeListener('aborted', abort);
    }
  }
}
