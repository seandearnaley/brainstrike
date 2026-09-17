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
  /** Hold a streaming tool finish at a deterministic external-provider boundary. */
  readonly beforeToolFinish?: Promise<void>;
  /**
   * Set when `toolCall` targets a Mastra-deferred tool (present in
   * `deferredToolIds`, not `coreToolIds` — see the `mastra_tool_discovery_surface`
   * log). Deferred tools are not in the model's active tool definitions until
   * Mastra's `load_tool` meta-tool loads them for the NEXT turn
   * (`tool-search-runtime.ts`'s `processInputStep`); calling one directly
   * fails fast with no execution. When set, the shim emits a `load_tool`
   * call FIRST with `{ toolName: toolCall.name }` — Mastra's runtime produces
   * the tool-result server-side, no shim-authored content needed — then emits
   * `toolCall` once one tool-result for that turn comes back, then `finalText`.
   */
  readonly deferredTool?: true;
  readonly finalText: string;
  /** Omit for a response-only turn, including native background wakeups. */
  readonly toolCall?: ScriptedToolCall;
  /** Emit one model turn containing independent parallel tool calls. */
  readonly toolCalls?: readonly ScriptedToolCall[];
}

/**
 * One decided request, recorded so a failing proof can show WHY the shim chose
 * a turn instead of leaving the caller to guess. `resolveTurn` is a pure
 * function of the request's own message history, so the recorded inputs
 * (`roles`, `toolResultCount`) plus the `decision` fully explain the response.
 */
export interface ModelProviderTurnRecord {
  /** `final-text`, or `tool:<name>` for a scripted tool call. */
  readonly decision: string;
  readonly requestIndex: number;
  readonly roles: readonly string[];
  readonly toolResultCount: number;
}

/** Parsed provider request available to parent/child test script routing. */
export interface ModelProviderRequest {
  readonly messages: readonly unknown[];
  /** Actual parsed wire payload for generation-setting assertions. */
  readonly requestBody: unknown;
  readonly requestIndex: number;
  readonly toolNames: readonly string[];
}

export type ModelProviderScriptSelector = (request: ModelProviderRequest) => ModelProviderScript;

export interface ModelProviderShim {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly requestCount: () => number;
  /** Configure what the next tool-call/follow-up cycle returns. */
  readonly setScript: (script: ModelProviderScript | ModelProviderScriptSelector) => void;
  /** Every decided request, oldest first — failure diagnostics only. */
  readonly transcript: () => readonly ModelProviderTurnRecord[];
}

interface ChatCompletionsRequestBody {
  readonly messages?: unknown[];
  readonly requestBody?: unknown;
  readonly stream?: boolean;
  readonly tools?: unknown[];
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
    requestBody: parsed,
    ...(Array.isArray(parsed['messages']) ? { messages: parsed['messages'] } : {}),
    ...(Array.isArray(parsed['tools']) ? { tools: parsed['tools'] } : {}),
    ...(typeof parsed['stream'] === 'boolean' ? { stream: parsed['stream'] } : {}),
  };
}

/**
 * Counts messages carrying a tool RESULT (not a tool CALL) since the LAST user
 * message — the turn signal. Scoping to the current turn lets one shim serve a
 * second scripted exchange on the same thread (via `setScript`) without the
 * previous turn's tool results short-circuiting it to `finalText`.
 */
function countToolResultMessages(messages: unknown[] | undefined): number {
  const history = messages ?? [];
  const lastUserIndex = history.reduce<number>(
    (found, message, index) => (isRecord(message) && message['role'] === 'user' ? index : found),
    -1
  );
  return history
    .slice(lastUserIndex + 1)
    .filter(
      (message) =>
        isRecord(message) &&
        (message['role'] === 'tool' || typeof message['tool_call_id'] === 'string')
    ).length;
}

/**
 * Decide what this turn emits from the number of tool-result messages seen
 * so far. Without `deferredTool` this is the original 2-turn shape
 * (toolCall, then finalText). With it, a `load_tool` call is inserted first
 * so Mastra loads the deferred `toolCall` target by exact name before it is
 * called.
 */
function resolveTurn(
  script: ModelProviderScript,
  toolResultCount: number
): { calls: readonly ScriptedToolCall[] } | { finalText: string } {
  if (script.toolCalls && script.toolCall) {
    throw new Error('Model provider shim scripts must use either toolCall or toolCalls.');
  }
  const calls = script.toolCalls ?? (script.toolCall ? [script.toolCall] : []);
  if (script.deferredTool && calls.length !== 1) {
    throw new Error('Deferred model provider scripts support exactly one tool call.');
  }
  if (calls.length === 0) {
    return { finalText: script.finalText };
  }
  if (!script.deferredTool) {
    if (toolResultCount > 0 && toolResultCount < calls.length) {
      throw new Error('Model provider shim requires all parallel tool results before continuing.');
    }
    return toolResultCount === 0 ? { calls } : { finalText: script.finalText };
  }
  if (toolResultCount === 0) {
    return { calls: [{ arguments: { toolName: calls[0]?.name }, name: 'load_tool' }] };
  }
  if (toolResultCount === 1) {
    return { calls };
  }
  return { finalText: script.finalText };
}

function completionIdentity(): { created: number; id: string } {
  const now = Date.now();
  return { created: Math.floor(now / 1000), id: `chatcmpl-e2e-${now}` };
}

function toolCallMessage(
  calls: readonly ScriptedToolCall[],
  toolCallIds: readonly string[]
): Record<string, unknown> {
  return {
    content: null,
    role: 'assistant',
    ['tool_calls']: calls.map((call, index) => ({
      function: {
        arguments: JSON.stringify(call.arguments),
        name: call.name,
      },
      id: toolCallIds[index],
      type: 'function',
    })),
  };
}

async function writeStreamingToolCall(
  response: ServerResponse,
  calls: readonly ScriptedToolCall[],
  beforeFinish?: Promise<void>
): Promise<void> {
  const { created, id } = completionIdentity();
  const toolCallIds = calls.map((_, index) => `call_e2e_${Date.now()}_${index}`);
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
            ['tool_calls']: calls.map((call, index) => ({
              function: {
                arguments: JSON.stringify(call.arguments),
                name: call.name,
              },
              id: toolCallIds[index],
              index,
              type: 'function',
            })),
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
  await beforeFinish;
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
  turn: { calls: readonly ScriptedToolCall[] } | { finalText: string }
): void {
  const { created, id } = completionIdentity();
  const finalTurn = 'finalText' in turn;
  const message = finalTurn
    ? { content: turn.finalText, role: 'assistant' }
    : toolCallMessage(
        turn.calls,
        turn.calls.map((_, index) => `call_e2e_${Date.now()}_${index}`)
      );
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

function messageRoles(messages: unknown[] | undefined): readonly string[] {
  return (messages ?? []).map((message) => {
    if (!isRecord(message)) {
      return 'unknown';
    }
    const role = typeof message['role'] === 'string' ? message['role'] : 'unknown';
    const calls = message['tool_calls'];
    if (!Array.isArray(calls)) {
      return role;
    }
    const names = calls
      .map((call) =>
        isRecord(call) && isRecord(call['function']) && typeof call['function']['name'] === 'string'
          ? call['function']['name']
          : 'unknown'
      )
      .join('+');
    return `${role}(${names})`;
  });
}

export async function startModelProviderShim(
  initialScript: ModelProviderScript | ModelProviderScriptSelector
): Promise<ModelProviderShim> {
  let script = initialScript;
  let requestCount = 0;
  const transcript: ModelProviderTurnRecord[] = [];

  const server: Server = createServer((request, response) => {
    requestCount += 1;
    // Captured here, not read inside the async body: the body settles later, by
    // which time concurrent requests may have advanced the counter.
    const requestOrdinal = requestCount;
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    void readJsonBody(request)
      .then(async ({ messages, stream, tools, requestBody }) => {
        const toolResultCount = countToolResultMessages(messages);
        const selectedScript =
          typeof script === 'function'
            ? script({
                messages: messages ?? [],
                requestBody,
                requestIndex: requestOrdinal,
                toolNames: (tools ?? []).flatMap((tool) =>
                  isRecord(tool) &&
                  isRecord(tool['function']) &&
                  typeof tool['function']['name'] === 'string'
                    ? [tool['function']['name']]
                    : []
                ),
              })
            : script;
        const turn = resolveTurn(selectedScript, toolResultCount);
        transcript.push({
          decision:
            'finalText' in turn
              ? 'final-text'
              : `tool:${turn.calls.map((call) => call.name).join('+')}`,
          requestIndex: requestOrdinal,
          roles: messageRoles(messages),
          toolResultCount,
        });
        if (stream !== true) {
          writeJsonCompletion(response, turn);
          return;
        }
        if ('finalText' in turn) {
          writeStreamingFinalText(response, turn.finalText);
          return;
        }
        await writeStreamingToolCall(response, turn.calls, selectedScript.beforeToolFinish);
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
    transcript: () => [...transcript],
  };
}
