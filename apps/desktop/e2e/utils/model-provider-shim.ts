/**
 * A local, throwaway model-provider HTTP server for desktop E2E (BST-1392 W5),
 * and the E2E provider egress boundary (BST-1931, #3543 ruling 6052594658).
 *
 * This is the counterpart to setupAssistantMock for tests that need REAL
 * native-tool execution: setupAssistantMock replaces the app's OWN internal
 * /assistant endpoint, while this shim replaces the TRUE external boundary —
 * the model PROVIDER'S API — through the base-URL knobs the host's vendor SDKs
 * read from the environment:
 *
 * - `OPENROUTER_BASE_URL`: Mastra's models.dev gateway (`ModelsDevGateway.buildUrl`,
 *   `${PROVIDER}_BASE_URL`) and openrouter-strict-content.ts's `buildUrl()`
 *   (`qwen/*`). Served wire: chat completions (`POST /chat/completions`). The
 *   OpenRouter model-metadata lookup (`GET /model/<provider>/<model>`) is served
 *   only for a recorded fixture's exact model identity.
 * - `OPENAI_BASE_URL`: `@ai-sdk/openai`'s `createOpenAI`. Served wire: the
 *   OpenAI Responses API (`POST /responses`).
 * - `ANTHROPIC_BASE_URL`: `@ai-sdk/anthropic`'s `createAnthropic`. No Anthropic
 *   wire is scripted, so every request through it is refused.
 *
 * DEFAULT DENY: a shim with no script refuses every request with a
 * terminal 401 naming the request, and records it in `refusals()`. The
 * desktop launch fixture points every knob at one such boundary unless a spec
 * supplies a live shim of its own, so an unscripted provider request is refused
 * on loopback instead of reaching a real provider. The shim never redirects.
 *
 * Precedent: gh-shim.ts fakes `gh` at ITS external boundary via a real
 * executable on PATH; this is the same idea for the model provider via a
 * real local HTTP server. A durable E2E asset — reuse it, don't fork it.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { json } from 'node:stream/consumers';
import { AWS_CHAIN_ACTIVATION_ENV_NAMES } from '@brainstrike/assistant-contract';
import {
  listProviders,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_ENV_KEYS } from '@brainstrike/assistant-contract/tavily-env-keys';
import type {
  ProviderCassetteExchange,
  ProviderCassetteReplay,
} from '@brainstrike/test-utils/provider-cassette';
import {
  type CassetteRouteScript,
  cassetteReplayFor,
  isCassetteRouteScript,
  serveCassetteRoute,
} from './model-provider-cassette-route';
import { recordedOpenRouterMetadata } from './model-provider-metadata';
import { writeContextOverflow, writeRefusal } from './model-provider-refusal';

export interface ScriptedToolCall {
  readonly arguments: Record<string, unknown>;
  readonly name: string;
}

export interface ModelProviderScript {
  /** Hold a final response at the external-provider boundary for reload tests. */
  readonly beforeFinalText?: Promise<void>;
  /** Hold a streaming tool finish at a deterministic external-provider boundary. */
  readonly beforeToolFinish?: Promise<void>;
  /**
   * Refuse the request as a provider refuses one that does not fit: HTTP 400
   * with OpenAI's `context_length_exceeded` error, before any stream opens.
   */
  readonly contextOverflow?: true;
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
  /** Responses API usage classes as emitted by the OpenAI adapter (including automatic cache writes). */
  /** Recorded Luna reasoning shape: encrypted state without a visible summary. */
  readonly emptyResponsesReasoning?: true;
  readonly finalText: string;
  /** For a selector that begins a new scripted stage in an existing model turn. */
  readonly ignorePriorToolResults?: true;
  readonly responsesUsage?: {
    readonly ['input_tokens']: number;
    readonly ['input_tokens_details']: {
      readonly ['cached_tokens']: number;
      readonly ['cache_write_tokens']: number;
    };
    readonly ['output_tokens']: number;
    readonly ['total_tokens']: number;
  };
  /**
   * Fail a streaming turn mid-stream: the response opens, then the provider's
   * own stream error event carries this message, as a provider outage does.
   */
  readonly streamError?: string;
  /**
   * Text a streaming final turn sends BEFORE `beforeFinalText` holds it: a
   * reply already streaming when the user stops or the app quits. A
   * non-streaming request refuses it.
   */
  readonly streamedBeforeHold?: string;
  /** Omit for a response-only turn, including native background wakeups. */
  readonly toolCall?: ScriptedToolCall;
  /** Emit successive tool turns as each preceding stage's results arrive. */
  readonly toolCallStages?: readonly (readonly ScriptedToolCall[])[];
  /** Emit one model turn containing independent parallel tool calls. */
  readonly toolCalls?: readonly ScriptedToolCall[];
  /** Opt in to the recorded OpenRouter Settings key-verification response. */
  readonly verifyOpenRouterKey?: true;
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

/** The provider wire a scripted request arrived on. */
export type ModelProviderWire = 'chat-completions' | 'responses';

/** Parsed provider request available to parent/child test script routing. */
export interface ModelProviderRequest {
  /** Chat-completions `messages`, or Responses API `input` items. */
  readonly messages: readonly unknown[];
  /** Actual parsed wire payload for generation-setting assertions. */
  readonly requestBody: unknown;
  readonly requestIndex: number;
  readonly toolNames: readonly string[];
  readonly wire: ModelProviderWire;
}

export type ModelProviderScriptSelector = (request: ModelProviderRequest) => ModelProviderScript;

type ShimScript = ModelProviderScript | ModelProviderScriptSelector | CassetteRouteScript;

/** The host provider base-URL knobs and the provider whose SDK reads each one. */
const PROVIDER_BASE_URL_KNOBS = {
  ['ANTHROPIC_BASE_URL']: 'anthropic',
  ['OPENAI_BASE_URL']: 'openai',
  ['OPENROUTER_BASE_URL']: 'openrouter',
} as const;

export type ProviderBaseUrlKnob = keyof typeof PROVIDER_BASE_URL_KNOBS;

const PROVIDER_BASE_URL_KNOB_NAMES = Object.keys(PROVIDER_BASE_URL_KNOBS) as ProviderBaseUrlKnob[];

/** A provider request the shim refused instead of answering. */
export interface ModelProviderRefusal {
  /** For `unrecorded-exchange`: the request's key and the keys the cassette still held. */
  readonly cassette?: { readonly key: string; readonly unserved: readonly string[] };
  /** The knob whose boundary path received it, when it arrived through one. */
  readonly knob: ProviderBaseUrlKnob | null;
  readonly method: string;
  /**
   * `unscripted`: no script is set. `unsupported-route`: no scripted wire serves
   * it. `unrecorded-model-metadata`: model metadata with no recorded fixture.
   * `unrecorded-exchange`: the active cassette holds no unserved exchange for it.
   */
  readonly reason:
    | 'unscripted'
    | 'unsupported-route'
    | 'unrecorded-model-metadata'
    | 'unrecorded-exchange';
  readonly requestIndex: number;
  readonly route: string;
  /** Whether its JSON body asks to stream (runs do, titles do not); `null` without one. */
  readonly stream: boolean | null;
}

export interface ModelProviderShim {
  readonly baseUrl: string;
  /** The base URL the launch fixture assigns to one knob; refusals name the knob. */
  readonly baseUrlFor: (knob: ProviderBaseUrlKnob) => string;
  readonly close: () => Promise<void>;
  /** Client-aborted cassette exchanges fully served and held open (a Stop scenario waits on one). */
  readonly heldExchanges: () => number;
  /** Every refused request, oldest first by arrival (`requestIndex`). */
  readonly refusals: () => readonly ModelProviderRefusal[];
  readonly requestCount: () => number;
  /** Every scripted request, oldest first, with its parsed wire payload. */
  readonly requests: () => readonly ModelProviderRequest[];
  /** Model identities whose recorded OpenRouter metadata was served, oldest first. */
  readonly servedMetadata: () => readonly string[];
  /** Configure what the next tool-call/follow-up cycle returns, or the cassette to replay. */
  readonly setScript: (script: ShimScript) => void;
  /** Every decided request, oldest first — failure diagnostics only. */
  readonly transcript: () => readonly ModelProviderTurnRecord[];
  /** The active cassette's exchanges no request has claimed yet; empty without a cassette. */
  readonly unservedExchanges: () => readonly ProviderCassetteExchange[];
}

interface ParsedRequestBody {
  readonly items: readonly unknown[] | undefined;
  readonly model: string | undefined;
  readonly requestBody: unknown;
  readonly stream: boolean | undefined;
  readonly tools: readonly unknown[] | undefined;
}

type ResolvedTurn = { calls: readonly ScriptedToolCall[] } | { finalText: string };

/** Origins of every shim this worker is serving; only these may stand in for a provider. */
const liveShimOrigins = new Set<string>();

/** True when `value` addresses a live canonical shim in this worker. */
export function isLiveModelProviderShimUrl(value: string): boolean {
  return URL.canParse(value) && liveShimOrigins.has(new URL(value).origin);
}

function providerCredentialEnvNames(provider: ReturnType<typeof listProviders>[number]['id']) {
  return [...providerEnvKeys(provider), ...providerDeprecatedEnvKeys(provider)];
}

/**
 * Every credential env name the desktop resolves: the provider registry's
 * names (including deprecated ones), Tavily's, the AWS chain activation names,
 * and the AWS SDK's static secret names. This is the registry derivation
 * apps/desktop/src/desktop-env.ts uses for its scrub set; E2E cannot import
 * that module because its bare imports would cross the BST-1217 module-format
 * boundary.
 */
export const E2E_CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set([
  ...listProviders().flatMap((definition) => providerCredentialEnvNames(definition.id)),
  ...TAVILY_ENV_KEYS,
  ...AWS_CHAIN_ACTIVATION_ENV_NAMES,
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/** Credentials for providers whose requests a knob pins to the boundary. */
const REDIRECTED_CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set(
  Object.values(PROVIDER_BASE_URL_KNOBS).flatMap(providerCredentialEnvNames)
);

/**
 * Environment the launch fixture applies over everything a spec or the worker
 * supplied (BST-1931 deny design D2):
 *
 * - each base-URL knob keeps a supplied value only when it addresses a live
 *   canonical shim; anything else — unset, inherited, an arbitrary server — is
 *   replaced by `boundary`, which refuses unscripted requests on loopback;
 * - `MASTRA_OFFLINE` keeps Mastra's models.dev registry refresh off;
 * - a credential for a provider with no knob (Google, Bedrock, Cohere, Voyage,
 *   Tavily, the AWS chain) refuses the launch: its requests could only leave
 *   loopback.
 *
 * `sources` are in precedence order, the highest first.
 */
export function resolveProviderEgressEnvironment(
  boundary: ModelProviderShim,
  sources: readonly Readonly<Record<string, string | undefined>>[]
): Record<string, string> {
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      const canonical = name.toUpperCase();
      if (
        value?.trim() &&
        E2E_CREDENTIAL_ENV_NAMES.has(canonical) &&
        !REDIRECTED_CREDENTIAL_ENV_NAMES.has(canonical)
      ) {
        throw new Error(
          `E2E egress boundary refused the launch: ${name} is a credential for a provider with no base-URL knob, so a request with it could only leave loopback.`
        );
      }
    }
  }
  const environment: Record<string, string> = { ['MASTRA_OFFLINE']: 'true' };
  for (const knob of PROVIDER_BASE_URL_KNOB_NAMES) {
    const supplied = sources.map((source) => source[knob]).find((value) => value !== undefined);
    if (supplied !== undefined && isLiveModelProviderShimUrl(supplied)) {
      environment[knob] = supplied;
      continue;
    }
    if (supplied !== undefined) {
      // The name only: a replaced URL may carry userinfo or query credentials.
      console.warn(`[provider-egress] replaced ${knob} with the E2E egress boundary.`);
    }
    environment[knob] = boundary.baseUrlFor(knob);
  }
  return environment;
}

/** A launch-owned egress boundary lives exactly as long as its app process. */
export function closeModelProviderShimWithProcess(
  boundary: ModelProviderShim,
  appProcess: ChildProcess
): void {
  const close = (): void => {
    boundary.close().catch((error: unknown) => {
      console.error('Failed to close the launch-owned provider egress boundary:', error);
    });
  };
  if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
    close();
    return;
  }
  appProcess.once('exit', close);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function readJsonBody(
  request: IncomingMessage,
  wire: ModelProviderWire
): Promise<ParsedRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {
      items: undefined,
      model: undefined,
      requestBody: undefined,
      stream: undefined,
      tools: undefined,
    };
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Model provider shim expected a JSON object request body.');
  }
  const items = parsed[wire === 'responses' ? 'input' : 'messages'];
  return {
    items: Array.isArray(items) ? items : undefined,
    model: typeof parsed['model'] === 'string' ? parsed['model'] : undefined,
    requestBody: parsed,
    stream: typeof parsed['stream'] === 'boolean' ? parsed['stream'] : undefined,
    tools: Array.isArray(parsed['tools']) ? parsed['tools'] : undefined,
  };
}

/**
 * Counts messages carrying a tool RESULT (not a tool CALL) since the LAST user
 * message — the turn signal. Scoping to the current turn lets one shim serve a
 * second scripted exchange on the same thread (via `setScript`) without the
 * previous turn's tool results short-circuiting it to `finalText`. On the
 * Responses wire a result is a `function_call_output` input item.
 */
function countToolResultMessages(
  messages: readonly unknown[] | undefined,
  wire: ModelProviderWire
): number {
  const history = messages ?? [];
  const lastUserIndex = history.reduce<number>(
    (found, message, index) => (isRecord(message) && message['role'] === 'user' ? index : found),
    -1
  );
  return history
    .slice(lastUserIndex + 1)
    .filter((message) =>
      wire === 'responses'
        ? isRecord(message) && message['type'] === 'function_call_output'
        : isRecord(message) &&
          (message['role'] === 'tool' || typeof message['tool_call_id'] === 'string')
    ).length;
}

/**
 * Decide what this turn emits from the observed tool results. Staged scripts
 * advance after each stage's complete results. Ordinary scripts retain their
 * single tool-call turn; a deferred script first calls `load_tool` so Mastra
 * advertises the requested tool on the following model turn.
 */
function resolveStagedTurn(
  stages: readonly (readonly ScriptedToolCall[])[],
  toolResultCount: number,
  finalText: string
): ResolvedTurn {
  let completedCalls = 0;
  for (const calls of stages) {
    if (calls.length === 0) {
      throw new Error('Model provider shim tool-call stages cannot be empty.');
    }
    if (toolResultCount === completedCalls) {
      return { calls };
    }
    if (toolResultCount < completedCalls + calls.length) {
      throw new Error('Model provider shim requires all stage tool results before continuing.');
    }
    completedCalls += calls.length;
  }
  return { finalText };
}

function resolveTurn(script: ModelProviderScript, toolResultCount: number): ResolvedTurn {
  const observedResults = script.ignorePriorToolResults ? 0 : toolResultCount;
  if ([script.toolCall, script.toolCalls, script.toolCallStages].filter(Boolean).length > 1) {
    throw new Error('Model provider shim scripts must select one tool-call shape.');
  }
  if (script.toolCallStages) {
    return resolveStagedTurn(script.toolCallStages, observedResults, script.finalText);
  }
  const calls = script.toolCalls ?? (script.toolCall ? [script.toolCall] : []);
  if (script.deferredTool && calls.length !== 1) {
    throw new Error('Deferred model provider scripts support exactly one tool call.');
  }
  if (calls.length === 0) {
    return { finalText: script.finalText };
  }
  if (!script.deferredTool) {
    if (observedResults > 0 && observedResults < calls.length) {
      throw new Error('Model provider shim requires all parallel tool results before continuing.');
    }
    return observedResults === 0 ? { calls } : { finalText: script.finalText };
  }
  if (observedResults === 0) {
    return { calls: [{ arguments: { toolName: calls[0]?.name }, name: 'load_tool' }] };
  }
  if (observedResults === 1) {
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
      function: { arguments: JSON.stringify(call.arguments), name: call.name },
      id: toolCallIds[index],
      type: 'function',
    })),
  };
}

function writeEventStreamHead(response: ServerResponse): void {
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
  });
}

/**
 * One call's arguments as OpenRouter streams them for chat-completions models
 * (GLM, Muse, Qwen; recorded 2026-10-16): the call opens with its name and
 * EMPTY arguments, a continuation carries no argument text yet, then the JSON
 * arrives in fragments. The provider turns this into `tool-input-start`, an
 * empty `tool-input-delta`, then one delta per fragment.
 */
function openRouterArgumentFrames(call: ScriptedToolCall): readonly string[] {
  const json = JSON.stringify(call.arguments);
  return ['', json.slice(0, 1), json.slice(1)];
}

async function writeStreamingToolCall(
  response: ServerResponse,
  calls: readonly ScriptedToolCall[],
  beforeFinish?: Promise<void>
): Promise<void> {
  const { created, id } = completionIdentity();
  const toolCallIds = calls.map(() => `call_e2e_${randomUUID()}`);
  const delta = (value: Record<string, unknown>) =>
    sseChunk({
      choices: [{ delta: value, ['finish_reason']: null, index: 0 }],
      created,
      id,
      model: 'e2e-scripted-model',
      object: 'chat.completion.chunk',
    });
  writeEventStreamHead(response);
  for (const [index, call] of calls.entries()) {
    response.write(
      delta({
        role: 'assistant',
        ['tool_calls']: [
          {
            function: { arguments: '', name: call.name },
            id: toolCallIds[index],
            index,
            type: 'function',
          },
        ],
      })
    );
    for (const fragment of openRouterArgumentFrames(call)) {
      response.write(delta({ ['tool_calls']: [{ function: { arguments: fragment }, index }] }));
    }
  }
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

async function writeStreamingFinalText(
  response: ServerResponse,
  finalText: string,
  script: ModelProviderScript
): Promise<void> {
  const { created, id } = completionIdentity();
  const content = (text: string) =>
    sseChunk({
      choices: [
        {
          delta: { content: text, role: 'assistant' },
          ['finish_reason']: null,
          index: 0,
        },
      ],
      created,
      id,
      model: 'e2e-scripted-model',
      object: 'chat.completion.chunk',
    });
  if (script.streamedBeforeHold === undefined) {
    await script.beforeFinalText;
    writeEventStreamHead(response);
  } else {
    writeEventStreamHead(response);
    response.write(content(script.streamedBeforeHold));
    await script.beforeFinalText;
  }
  response.write(content(finalText));
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

function writeJsonCompletion(response: ServerResponse, turn: ResolvedTurn): void {
  const { created, id } = completionIdentity();
  const finalTurn = 'finalText' in turn;
  const message = finalTurn
    ? { content: turn.finalText, role: 'assistant' }
    : toolCallMessage(
        turn.calls,
        turn.calls.map(() => `call_e2e_${randomUUID()}`)
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

/**
 * OpenAI Responses API frames for one scripted turn. The event shapes are the
 * recorded in-repo SDK 7 fixture shapes: text from
 * packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts
 * (`responsesApiStream`), function calls from
 * packages/agent-host/__tests__/fixtures/standalone-production-http.mjs.
 * Parallel calls repeat the recorded per-item frames at successive
 * `output_index` values.
 */
function responsesTurn(
  turn: ResolvedTurn,
  model: string,
  usage?: ModelProviderScript['responsesUsage']
): {
  readonly completed: Record<string, unknown>;
  items: readonly Record<string, unknown>[];
  readonly response: Record<string, unknown>;
} {
  const response = {
    ['created_at']: Math.floor(Date.now() / 1000),
    id: `resp_e2e_${randomUUID()}`,
    model,
    object: 'response',
    output: [] as unknown[],
    status: 'in_progress',
  };
  if ('finalText' in turn) {
    const itemId = `msg_e2e_${randomUUID()}`;
    const part = { annotations: [], text: turn.finalText, type: 'output_text' };
    const item = {
      content: [part],
      id: itemId,
      role: 'assistant',
      status: 'completed',
      type: 'message',
    };
    const position = { ['content_index']: 0, ['item_id']: itemId, ['output_index']: 0 };
    return {
      completed: {
        ...response,
        output: [item],
        status: 'completed',
        usage: usage ?? { ['input_tokens']: 4, ['output_tokens']: 3, ['total_tokens']: 7 },
      },
      items: [
        {
          item: { ...item, content: [], status: 'in_progress' },
          ['output_index']: 0,
          type: 'response.output_item.added',
        },
        { ...position, part: { ...part, text: '' }, type: 'response.content_part.added' },
        { ...position, delta: turn.finalText, type: 'response.output_text.delta' },
        { ...position, text: turn.finalText, type: 'response.output_text.done' },
        { ...position, part, type: 'response.content_part.done' },
        { item, ['output_index']: 0, type: 'response.output_item.done' },
      ],
      response,
    };
  }
  const calls = turn.calls.map((call) => ({
    arguments: JSON.stringify(call.arguments),
    ['call_id']: `call_e2e_${randomUUID()}`,
    id: `fc_e2e_${randomUUID()}`,
    name: call.name,
    status: 'completed',
    type: 'function_call',
  }));
  return {
    completed: {
      ...response,
      output: calls,
      status: 'completed',
      usage: { ['input_tokens']: 4, ['output_tokens']: 0, ['total_tokens']: 4 },
    },
    items: calls.flatMap((call, index) => [
      {
        item: { ...call, arguments: '', status: 'in_progress' },
        ['output_index']: index,
        type: 'response.output_item.added',
      },
      {
        delta: call.arguments,
        ['item_id']: call.id,
        ['output_index']: index,
        type: 'response.function_call_arguments.delta',
      },
      {
        arguments: call.arguments,
        ['item_id']: call.id,
        ['output_index']: index,
        type: 'response.function_call_arguments.done',
      },
      { item: call, ['output_index']: index, type: 'response.output_item.done' },
    ]),
    response,
  };
}

/** Answer one decided turn on its wire, streaming or not. */
async function writeTurn(
  response: ServerResponse,
  wire: ModelProviderWire,
  turn: ResolvedTurn,
  model: string,
  stream: boolean | undefined,
  script: ModelProviderScript
): Promise<void> {
  if (wire === 'responses') {
    await writeResponsesTurn(response, turn, model, stream, script);
    return;
  }
  if (stream !== true) {
    if (script.streamedBeforeHold !== undefined && 'finalText' in turn) {
      throw new Error('streamedBeforeHold is served on a streaming turn only.');
    }
    writeJsonCompletion(response, turn);
    return;
  }
  if ('finalText' in turn) {
    await writeStreamingFinalText(response, turn.finalText, script);
    return;
  }
  await writeStreamingToolCall(response, turn.calls, script.beforeToolFinish);
}

/** A streaming turn that opens, then fails with the provider's own error event. */
function writeStreamError(
  response: ServerResponse,
  wire: ModelProviderWire,
  model: string,
  message: string
): void {
  writeEventStreamHead(response);
  if (wire === 'responses') {
    const opened = responsesTurn({ finalText: '' }, model).response;
    response.write(sseChunk({ response: opened, type: 'response.created' }));
    response.end(
      sseChunk({
        code: 'server_error',
        message,
        param: null,
        ['sequence_number']: 1,
        type: 'error',
      })
    );
    return;
  }
  response.end(sseChunk({ error: { code: 'server_error', message, type: 'server_error' } }));
}

async function writeResponsesTurn(
  response: ServerResponse,
  turn: ResolvedTurn,
  model: string,
  stream: boolean | undefined,
  script: ModelProviderScript
): Promise<void> {
  const prefix = 'finalText' in turn ? script.streamedBeforeHold : undefined;
  if (prefix !== undefined && stream !== true) {
    throw new Error('streamedBeforeHold is served on a streaming turn only.');
  }
  if ('finalText' in turn && prefix === undefined) {
    await script.beforeFinalText;
  }
  // A held reply is one message: its streamed prefix, then the rest after the hold.
  const frames = responsesTurn(
    prefix === undefined || !('finalText' in turn)
      ? turn
      : { finalText: `${prefix}${turn.finalText}` },
    model,
    script.responsesUsage
  );
  if (script.emptyResponsesReasoning) {
    const item = {
      ['encrypted_content']: 'opaque-fixture-state',
      id: `rs_e2e_${randomUUID()}`,
      summary: [],
      type: 'reasoning',
    };
    frames.completed['output'] = [item, ...(frames.completed['output'] as unknown[])];
    // Preserve the provider's item ordering and indexes, including tool frames.
    for (const frame of frames.items) {
      frame['output_index'] = Number(frame['output_index']) + 1;
    }
    frames.items = [
      { item, ['output_index']: 0, type: 'response.output_item.added' },
      { item, ['output_index']: 0, type: 'response.output_item.done' },
      ...frames.items,
    ];
  }
  if (stream !== true) {
    if (!('finalText' in turn)) {
      await script.beforeToolFinish;
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(frames.completed));
    return;
  }
  writeEventStreamHead(response);
  response.write(sseChunk({ response: frames.response, type: 'response.created' }));
  for (const frame of frames.items) {
    if (
      prefix !== undefined &&
      'finalText' in turn &&
      frame['type'] === 'response.output_text.delta'
    ) {
      response.write(sseChunk({ ...frame, delta: prefix }));
      await script.beforeFinalText;
      response.write(sseChunk({ ...frame, delta: turn.finalText }));
      continue;
    }
    response.write(sseChunk(frame));
  }
  if (!('finalText' in turn)) {
    await script.beforeToolFinish;
  }
  response.end(sseChunk({ response: frames.completed, type: 'response.completed' }));
}

function messageRoles(
  messages: readonly unknown[] | undefined,
  wire: ModelProviderWire
): readonly string[] {
  return (messages ?? []).map((message) => {
    if (!isRecord(message)) {
      return 'unknown';
    }
    if (wire === 'responses' && typeof message['type'] === 'string' && !message['role']) {
      const name = typeof message['name'] === 'string' ? `(${message['name']})` : '';
      return `${message['type']}${name}`;
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

function toolNames(tools: readonly unknown[] | undefined, wire: ModelProviderWire): string[] {
  return (tools ?? []).flatMap((tool) => {
    if (!isRecord(tool)) {
      return [];
    }
    if (wire === 'responses') {
      return tool['type'] === 'function' && typeof tool['name'] === 'string' ? [tool['name']] : [];
    }
    return isRecord(tool['function']) && typeof tool['function']['name'] === 'string'
      ? [tool['function']['name']]
      : [];
  });
}

/** Splits `/<KNOB>/route` into the knob that assigned the path and the provider route. */
function parseRequestPath(url: string | undefined): {
  knob: ProviderBaseUrlKnob | null;
  route: string;
} {
  const segments = new URL(url ?? '/', 'http://127.0.0.1').pathname.split('/').filter(Boolean);
  const [first, ...rest] = segments;
  const knob = PROVIDER_BASE_URL_KNOB_NAMES.find((name) => name === first) ?? null;
  return { knob, route: `/${(knob ? rest : segments).join('/')}` };
}

function wireForRoute(method: string | undefined, route: string): ModelProviderWire | null {
  if (method !== 'POST') {
    return null;
  }
  if (route === '/chat/completions') {
    return 'chat-completions';
  }
  return route === '/responses' ? 'responses' : null;
}

export async function startModelProviderShim(
  initialScript?: ShimScript
): Promise<ModelProviderShim> {
  let script = initialScript;
  let replay: ProviderCassetteReplay | undefined = cassetteReplayFor(initialScript);
  let requestCount = 0;
  const transcript: ModelProviderTurnRecord[] = [];
  const refusals: ModelProviderRefusal[] = [];
  const requests: ModelProviderRequest[] = [];
  const servedMetadata: string[] = [];

  const server: Server = createServer((request, response) => {
    requestCount += 1;
    // Captured here, not read inside the async body: the body settles later, by
    // which time concurrent requests may have advanced the counter.
    const requestOrdinal = requestCount;
    const { knob, route } = parseRequestPath(request.url);
    const refuse = async (reason: ModelProviderRefusal['reason']): Promise<void> => {
      const body: unknown = await json(request).catch(() => null);
      const refusal: ModelProviderRefusal = {
        knob,
        method: request.method ?? 'UNKNOWN',
        reason,
        requestIndex: requestOrdinal,
        route,
        stream: isRecord(body) ? body['stream'] === true : null,
      };
      refusals.push(refusal);
      writeRefusal(response, refusal);
    };
    // Read once: a later setScript must not change how this request is served.
    const recordedScript = script;
    if (isCassetteRouteScript(recordedScript)) {
      if (!knob) {
        void refuse('unsupported-route');
        return;
      }
      void serveCassetteRoute({
        knob,
        replay,
        request,
        response,
        route,
        script: recordedScript,
      }).then((cassette) => {
        if (cassette) {
          const unrecorded: ModelProviderRefusal = {
            cassette: { key: cassette.key, unserved: cassette.unserved },
            knob,
            method: request.method ?? 'GET',
            reason: 'unrecorded-exchange',
            requestIndex: requestOrdinal,
            route,
            stream: cassette.stream,
          };
          refusals.push(unrecorded);
          writeRefusal(response, unrecorded);
        }
      });
      return;
    }
    if (
      request.method === 'GET' &&
      knob === 'OPENROUTER_BASE_URL' &&
      route === '/key' &&
      typeof recordedScript === 'object' &&
      recordedScript.verifyOpenRouterKey
    ) {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // Same provider response fixture as provider-verification.test.ts.
      response.end(
        JSON.stringify({
          data: { ['is_free_tier']: false, label: 'sk-or-v1-abc', limit: 10, usage: 1.25 },
        })
      );
      return;
    }
    const metadata = recordedOpenRouterMetadata(request.method, knob, route);
    if (metadata === 'unrecorded') {
      void refuse('unrecorded-model-metadata');
      return;
    }
    if (metadata) {
      servedMetadata.push(metadata.identity);
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(metadata.body);
      return;
    }
    const wire = wireForRoute(request.method, route);
    const activeScript = recordedScript;
    if (!(wire && activeScript)) {
      void refuse(activeScript ? 'unsupported-route' : 'unscripted');
      return;
    }

    void readJsonBody(request, wire)
      .then(async ({ items, model, requestBody, stream, tools }) => {
        const toolResultCount = countToolResultMessages(items, wire);
        const decided: ModelProviderRequest = {
          messages: items ?? [],
          requestBody,
          requestIndex: requestOrdinal,
          toolNames: toolNames(tools, wire),
          wire,
        };
        requests.push(decided);
        const selectedScript =
          typeof activeScript === 'function' ? activeScript(decided) : activeScript;
        if (selectedScript.contextOverflow) {
          transcript.push({
            decision: 'context-overflow',
            requestIndex: requestOrdinal,
            roles: messageRoles(items, wire),
            toolResultCount,
          });
          writeContextOverflow(response);
          return;
        }
        if (selectedScript.streamError !== undefined && stream === true) {
          transcript.push({
            decision: 'stream-error',
            requestIndex: requestOrdinal,
            roles: messageRoles(items, wire),
            toolResultCount,
          });
          writeStreamError(
            response,
            wire,
            model ?? 'e2e-scripted-model',
            selectedScript.streamError
          );
          return;
        }
        const turn = resolveTurn(selectedScript, toolResultCount);
        transcript.push({
          decision:
            'finalText' in turn
              ? 'final-text'
              : `tool:${turn.calls.map((call) => call.name).join('+')}`,
          requestIndex: requestOrdinal,
          roles: messageRoles(items, wire),
          toolResultCount,
        });
        await writeTurn(
          response,
          wire,
          turn,
          model ?? 'e2e-scripted-model',
          stream,
          selectedScript
        );
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  liveShimOrigins.add(baseUrl);

  return {
    baseUrl,
    baseUrlFor: (knob) => `${baseUrl}/${knob}`,
    async close(): Promise<void> {
      liveShimOrigins.delete(baseUrl);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    heldExchanges: () => replay?.holding() ?? 0,
    refusals: () => [...refusals].sort((a, b) => a.requestIndex - b.requestIndex),
    requestCount: () => requestCount,
    requests: () => [...requests],
    servedMetadata: () => [...servedMetadata],
    setScript: (nextScript) => {
      script = nextScript;
      replay = cassetteReplayFor(nextScript);
    },
    transcript: () => [...transcript],
    unservedExchanges: () => replay?.unserved() ?? [],
  };
}
