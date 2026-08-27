/**
 * A local, throwaway OpenAI/OpenRouter-compatible chat-completions HTTP
 * server for desktop E2E (BST-1392 W5). This is the counterpart to
 * setupAssistantMock for tests that need REAL native-tool execution:
 * setupAssistantMock replaces the app's OWN internal /assistant endpoint
 * (short-circuiting before the real Mastra tool-execution loop ever runs);
 * this shim instead replaces the TRUE external boundary — the model
 * PROVIDER'S API — via OPENROUTER_BASE_URL, a real production config knob:
 * openrouter-strict-content.ts's buildUrl() honors it for qwen/*-routed
 * models specifically, and Mastra's own general provider-registry gateway
 * (ModelsDevGateway.buildUrl, `${PROVIDER}_BASE_URL` by convention) honors it
 * for every other OpenRouter model, which is the path this shim's default
 * model (openai/gpt-5.4, see assistant-mock.ts's DEFAULT_MODELS) actually
 * takes. The real assistant server, real Mastra agent loop, real permission
 * engine, and real native tool execute() functions all run unmodified.
 *
 * Precedent: gh-shim.ts fakes `gh` at ITS external boundary via a real
 * executable on PATH; this is the same idea for the model provider via a
 * real local HTTP server. A durable E2E asset — reuse it, don't fork it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ScriptedToolCall {
  readonly arguments: Record<string, unknown>;
  readonly name: string;
}

export interface ModelProviderScript {
  /**
   * Set when `toolCall` targets a Mastra-deferred tool (present in
   * `deferredToolIds`, not `coreToolIds` — see the `mastra_tool_discovery_surface`
   * log). Deferred tools are not in the model's active tool definitions until
   * Mastra's own `search_tools` meta-tool loads them for the NEXT turn
   * (`tool-search-runtime.ts`'s `processInputStep`); calling one directly
   * fails fast with no execution. When set, the shim emits a `search_tools`
   * call FIRST — Mastra's runtime resolves the match and produces the
   * tool-result server-side, no shim-authored content needed — then emits
   * `toolCall` once a tool-result for that turn comes back.
   */
  readonly discoveryQuery?: string;
  readonly finalText: string;
  readonly toolCall: ScriptedToolCall;
}

export interface ModelProviderShim {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly requestCount: () => number;
  /** Configure what the next tool-call/follow-up cycle returns. */
  readonly setScript: (script: ModelProviderScript) => void;
}

interface ChatCompletionsRequestBody {
  readonly messages?: unknown[];
  readonly stream?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function readJsonBody(request: IncomingMessage): Promise<ChatCompletionsRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Model provider shim expected a JSON object request body.');
  }
  return {
    ...(Array.isArray(parsed['messages']) ? { messages: parsed['messages'] } : {}),
    ...(typeof parsed['stream'] === 'boolean' ? { stream: parsed['stream'] } : {}),
  };
}

/** Counts messages carrying a tool RESULT (not a tool CALL) — the turn signal. */
function countToolResultMessages(messages: unknown[] | undefined): number {
  return (messages ?? []).filter(
    (message) =>
      isRecord(message) &&
      (message['role'] === 'tool' || typeof message['tool_call_id'] === 'string')
  ).length;
}

/**
 * Decide what this turn emits from the number of tool-result messages seen
 * so far. Without `discoveryQuery` this is the original 2-turn shape
 * (toolCall, then finalText). With it, a `search_tools` call is inserted
 * first so Mastra loads the deferred `toolCall` target before it is called.
 */
function resolveTurn(
  script: ModelProviderScript,
  toolResultCount: number
): { call: ScriptedToolCall } | { finalText: string } {
  if (!script.discoveryQuery) {
    return toolResultCount === 0 ? { call: script.toolCall } : { finalText: script.finalText };
  }
  if (toolResultCount === 0) {
    return { call: { arguments: { query: script.discoveryQuery }, name: 'search_tools' } };
  }
  if (toolResultCount === 1) {
    return { call: script.toolCall };
  }
  return { finalText: script.finalText };
}

function completionIdentity(): { created: number; id: string } {
  const now = Date.now();
  return { created: Math.floor(now / 1000), id: `chatcmpl-e2e-${now}` };
}

function toolCallMessage(call: ScriptedToolCall, toolCallId: string): Record<string, unknown> {
  return {
    content: null,
    role: 'assistant',
    ['tool_calls']: [
      {
        function: {
          arguments: JSON.stringify(call.arguments),
          name: call.name,
        },
        id: toolCallId,
        type: 'function',
      },
    ],
  };
}

function writeStreamingToolCall(response: ServerResponse, call: ScriptedToolCall): void {
  const { created, id } = completionIdentity();
  const toolCallId = `call_e2e_${Date.now()}`;
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
  });
  response.write(
    sseChunk({
      choices: [
        {
          delta: {
            role: 'assistant',
            ['tool_calls']: [
              {
                function: {
                  arguments: JSON.stringify(call.arguments),
                  name: call.name,
                },
                id: toolCallId,
                index: 0,
                type: 'function',
              },
            ],
          },
          ['finish_reason']: null,
          index: 0,
        },
      ],
      created,
      id,
      model: 'e2e-scripted-model',
      object: 'chat.completion.chunk',
    })
  );
  response.write(
    sseChunk({
      choices: [{ delta: {}, ['finish_reason']: 'tool_calls', index: 0 }],
      created,
      id,
      model: 'e2e-scripted-model',
      object: 'chat.completion.chunk',
      usage: { ['completion_tokens']: 0, ['prompt_tokens']: 0, ['total_tokens']: 0 },
    })
  );
  response.end('data: [DONE]\n\n');
}

function writeStreamingFinalText(response: ServerResponse, finalText: string): void {
  const { created, id } = completionIdentity();
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
  });
  response.write(
    sseChunk({
      choices: [
        {
          delta: { content: finalText, role: 'assistant' },
          ['finish_reason']: null,
          index: 0,
        },
      ],
      created,
      id,
      model: 'e2e-scripted-model',
      object: 'chat.completion.chunk',
    })
  );
  response.write(
    sseChunk({
      choices: [{ delta: {}, ['finish_reason']: 'stop', index: 0 }],
      created,
      id,
      model: 'e2e-scripted-model',
      object: 'chat.completion.chunk',
      usage: { ['completion_tokens']: 3, ['prompt_tokens']: 4, ['total_tokens']: 7 },
    })
  );
  response.end('data: [DONE]\n\n');
}

function writeJsonCompletion(
  response: ServerResponse,
  turn: { call: ScriptedToolCall } | { finalText: string }
): void {
  const { created, id } = completionIdentity();
  const finalTurn = 'finalText' in turn;
  const message = finalTurn
    ? { content: turn.finalText, role: 'assistant' }
    : toolCallMessage(turn.call, `call_e2e_${Date.now()}`);
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(
    JSON.stringify({
      choices: [
        {
          ['finish_reason']: finalTurn ? 'stop' : 'tool_calls',
          index: 0,
          message,
        },
      ],
      created,
      id,
      model: 'e2e-scripted-model',
      object: 'chat.completion',
      usage: {
        ['completion_tokens']: finalTurn ? 3 : 0,
        ['prompt_tokens']: 4,
        ['total_tokens']: finalTurn ? 7 : 4,
      },
    })
  );
}

export async function startModelProviderShim(
  initialScript: ModelProviderScript
): Promise<ModelProviderShim> {
  let script = initialScript;
  let requestCount = 0;

  const server: Server = createServer((request, response) => {
    requestCount += 1;
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    void readJsonBody(request)
      .then(({ messages, stream }) => {
        const turn = resolveTurn(script, countToolResultMessages(messages));
        if (stream === false) {
          writeJsonCompletion(response, turn);
          return;
        }
        if ('finalText' in turn) {
          writeStreamingFinalText(response, turn.finalText);
          return;
        }
        writeStreamingToolCall(response, turn.call);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('Expected an assigned model-provider-shim port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    requestCount: () => requestCount,
    setScript: (nextScript) => {
      script = nextScript;
    },
  };
}
