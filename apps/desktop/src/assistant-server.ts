import http from 'node:http';
import { convertAssistantUiMessages } from '@brainstrike/agent';
import { readOpenAIApiKey } from './openai-api-key';

type AgentModule = typeof import('@brainstrike/agent');
type AgentMessage = AgentModule['AgentMessage'];
type AssistantUiMessage = AgentModule['AssistantUiMessageStrict'];
type RuntimeData = AgentModule['RuntimeData'];

import { createAssistantStreamResponse } from 'assistant-stream';
import { readRequestBody, streamResponse } from './assistant-server/http';
import {
  processAgentStream,
  type StreamChunk,
  toMessageFinishChunk,
} from './assistant-server/stream-glue';
import { loadMcpConfig } from './mcp-loader';

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
  const url = req.url ?? '';
  if (req.method === 'GET' && (url.endsWith('/assistant/status') || url === '/status')) {
    await handleAssistantStatus(res);
    return;
  }

  if (req.method !== 'POST' || !(req.url?.endsWith('/assistant') || req.url === '/')) {
    res.writeHead(404).end('not found');
    return;
  }

  const body = await readRequestBody(req);
  const parsed = JSON.parse(body || '{}');
  const rawMessages = Array.isArray(parsed?.messages)
    ? (parsed.messages as AssistantUiMessage[])
    : [];
  const data: RuntimeData | undefined = parsed?.data ?? undefined;
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

  const mod = await import('@brainstrike/agent');
  const abortController = new AbortController();
  const mcpConfig = (await loadMcpConfig()).config;
  let agentStream: AsyncIterable<StreamChunk>;
  try {
    agentStream = await mod.toAiSdkStyleStream(messages, {
      ...data,
      mcpEnabled: true,
      ...(apiKey ? { apiKey } : {}),
      signal: abortController.signal,
      mcpConfig,
      mastraTools: mod.webTools,
    });
    console.info('[assistant-server] stream initialized');
  } catch (error) {
    console.error('[assistant-server] failed to initialize assistant stream', error);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return;
  }

  const response = createAssistantStreamResponse(async (ctrl) => {
    const abort = () => abortController.abort();
    req.on('close', abort);
    req.on('aborted', abort);
    abortController.signal.addEventListener(
      'abort',
      () => {
        try {
          ctrl.close();
        } catch {}
      },
      { once: true }
    );
    await processAgentStream(ctrl, agentStream, abortController.signal, false);
  });

  await streamResponse(res, response, undefined);
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

// Internal-only test surface to validate streaming glue behavior.
// Not part of the public API.
export const __assistantServerTest = {
  processAgentStream,
  toMessageFinishChunk,
};
