/**
 * Provider cassettes: real model-provider HTTP exchanges, recorded once through
 * a loopback proxy and replayed byte for byte, so the real AI SDK provider
 * packages parse what providers actually send instead of what a hand-written
 * emulator assumes they send.
 *
 * - `startProviderCassetteRecorder` is the proxy. A client points a provider's
 *   base-URL knob at `baseUrlFor(knob)`; each request goes to that provider's
 *   real origin with the client's own credentials, and the exchange is kept:
 *   the sanitized request (non-secret headers only, JSON body with the given
 *   substitutions applied) and the response's exact bytes, chunk boundaries
 *   and status. Nothing here ever reads a credential.
 * - `createProviderCassetteReplay` serves a cassette. Each request is matched
 *   to a recorded exchange by its structural key (`providerRequestKey`), never
 *   by prompt wording or tool definitions, which are the host's to change. An
 *   unmatched request is refused, never improvised.
 *
 * This module has no relative imports, so the recorder CLI can load it with
 * Node's own type stripping.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const PROVIDER_CASSETTE_FORMAT = 'brainstrike.provider-cassette/1';

/** Each base-URL knob and its provider's real API base, as the installed SDKs default it. */
export const PROVIDER_CASSETTE_UPSTREAMS = {
  ['ANTHROPIC_BASE_URL']: 'https://api.anthropic.com/v1',
  ['OPENAI_BASE_URL']: 'https://api.openai.com/v1',
  ['OPENROUTER_BASE_URL']: 'https://openrouter.ai/api/v1',
} as const;

export type ProviderCassetteKnob = keyof typeof PROVIDER_CASSETTE_UPSTREAMS;

const KNOBS = Object.keys(PROVIDER_CASSETTE_UPSTREAMS) as ProviderCassetteKnob[];

/**
 * How a request is matched. A streamed or tool-offering request is one step of
 * one conversation: its lane is the conversation's first user message and its
 * position the number of conversation items it carries. A non-streamed request
 * that offers no tools (a thread title) is matched by model and order alone.
 */
export interface ProviderRequestKey {
  readonly knob: ProviderCassetteKnob;
  readonly lane: string;
  readonly method: string;
  readonly model: string;
  readonly position: number;
  readonly route: string;
  readonly stream: boolean;
  readonly tools: boolean;
}

/** One received chunk: its byte length and when it arrived, from the request's arrival. */
export interface ProviderCassetteChunk {
  readonly atMs: number;
  readonly bytes: number;
}

/** One recorded response: its exact bytes, read back in their received `chunks`. */
export interface ProviderCassetteResponse {
  /** UTF-8 text of the complete response body; its bytes are exactly what was received. */
  readonly body: string;
  /** Each received chunk, in order; their bytes sum to the body's byte length. */
  readonly chunks: readonly ProviderCassetteChunk[];
  readonly contentType: string | null;
  /** `client-aborted`: the client hung up mid-response (a Stop); replay holds after the last chunk. */
  readonly ended: 'client-aborted' | 'complete';
  /**
   * Null when the client hung up before the provider answered at all (a Stop
   * that aborts a concurrent request): replay leaves it unanswered until the
   * client hangs up again.
   */
  readonly status: number | null;
}

export interface ProviderCassetteExchange {
  readonly key: ProviderRequestKey;
  readonly request: {
    /** Parsed JSON body after substitutions, or null for a bodiless request. */
    readonly body: unknown;
    /** Non-secret request headers only (`RECORDED_REQUEST_HEADERS`). */
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly route: string;
  };
  readonly response: ProviderCassetteResponse;
  /** Milliseconds from the recording's start to the request's arrival. */
  readonly startedAtMs: number;
}

export interface ProviderCassette {
  readonly exchanges: readonly ProviderCassetteExchange[];
  readonly format: typeof PROVIDER_CASSETTE_FORMAT;
  readonly recordedAt: string;
  readonly scenario: string;
  /**
   * The tool definitions requests offered, each kept once under its digest; a
   * recorded request body's `tools` is `{ "toolSet": "<digest>" }`.
   */
  readonly toolSets: Readonly<Record<string, unknown>>;
}

/**
 * A cassette of `exchanges` (full request bodies, as recorded), with each
 * distinct tool-definition list moved into `toolSets` once.
 */
export function assembleProviderCassette(input: {
  readonly exchanges: readonly ProviderCassetteExchange[];
  readonly recordedAt: string;
  readonly scenario: string;
}): ProviderCassette {
  const toolSets: Record<string, unknown> = {};
  const exchanges = input.exchanges.map((exchange) => {
    const body = exchange.request.body;
    if (!(isRecord(body) && Array.isArray(body['tools']))) {
      return exchange;
    }
    const digest = createHash('sha256')
      .update(JSON.stringify(body['tools']))
      .digest('hex')
      .slice(0, 16);
    toolSets[digest] = body['tools'];
    return {
      ...exchange,
      request: { ...exchange.request, body: { ...body, tools: { toolSet: digest } } },
    };
  });
  return {
    exchanges,
    format: PROVIDER_CASSETTE_FORMAT,
    recordedAt: input.recordedAt,
    scenario: input.scenario,
    toolSets,
  };
}

/** A literal replaced in every recorded request string (a disposable path, a home directory). */
export interface ProviderCassetteSubstitution {
  readonly from: string;
  readonly to: string;
}

/**
 * The only request headers a cassette keeps: protocol selectors with no
 * credential or identity. Authorization, API keys, cookies, organization and
 * attribution headers are never written.
 */
const RECORDED_REQUEST_HEADERS = new Set([
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'openai-beta',
]);

/** Hop-by-hop and framing headers the proxy never forwards. */
const UNFORWARDED_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Splits `/<KNOB>/route` into its knob and the provider route; null for any other path. */
export function parseProviderCassettePath(
  url: string | undefined
): { knob: ProviderCassetteKnob; route: string; search: string } | null {
  const parsed = new URL(url ?? '/', 'http://127.0.0.1');
  const [first, ...rest] = parsed.pathname.split('/').filter(Boolean);
  const knob = KNOBS.find((name) => name === first);
  return knob ? { knob, route: `/${rest.join('/')}`, search: parsed.search } : null;
}

function substitute(text: string, substitutions: readonly ProviderCassetteSubstitution[]): string {
  return substitutions.reduce(
    (value, { from, to }) => (from ? value.split(from).join(to) : value),
    text
  );
}

/** Applies `substitutions` to every string in a parsed JSON value. */
export function substituteJson(
  value: unknown,
  substitutions: readonly ProviderCassetteSubstitution[]
): unknown {
  if (typeof value === 'string') {
    return substitute(value, substitutions);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteJson(item, substitutions));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteJson(item, substitutions)])
    );
  }
  return value;
}

/** Conversation items of a chat-completions, Anthropic messages or Responses request. */
function conversationItems(route: string, body: Record<string, unknown>): readonly unknown[] {
  const items = route === '/responses' ? body['input'] : body['messages'];
  if (!Array.isArray(items)) {
    return [];
  }
  // System instructions are configuration, not conversation (Anthropic sends them apart).
  return items.filter(
    (item) => !(isRecord(item) && (item['role'] === 'system' || item['role'] === 'developer'))
  );
}

function itemText(item: unknown): string {
  if (!isRecord(item)) {
    return '';
  }
  const content = item['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
    .join('');
}

/** The structural key of one request (see `ProviderRequestKey`). `body` is already substituted. */
export function providerRequestKey(input: {
  readonly body: unknown;
  readonly knob: ProviderCassetteKnob;
  readonly method: string;
  readonly route: string;
}): ProviderRequestKey {
  const { body, knob, method, route } = input;
  const json = isRecord(body) ? body : {};
  const stream = json['stream'] === true;
  const tools = Array.isArray(json['tools']) && json['tools'].length > 0;
  const model = typeof json['model'] === 'string' ? json['model'] : '';
  const items = conversationItems(route, json);
  const conversational = stream || tools;
  return {
    knob,
    lane: conversational
      ? itemText(items.find((item) => isRecord(item) && item['role'] === 'user'))
      : '',
    method,
    model,
    position: conversational ? items.length : 0,
    route,
    stream,
    tools,
  };
}

export function sameProviderRequestKey(left: ProviderRequestKey, right: ProviderRequestKey) {
  return (
    left.knob === right.knob &&
    left.lane === right.lane &&
    left.method === right.method &&
    left.model === right.model &&
    left.position === right.position &&
    left.route === right.route &&
    left.stream === right.stream &&
    left.tools === right.tools
  );
}

/** A one-line description of a key for refusals and diagnostics. */
export function describeProviderRequestKey(key: ProviderRequestKey): string {
  const lane = key.lane.length > 80 ? `${key.lane.slice(0, 77)}...` : key.lane;
  return `${key.method} ${key.knob}${key.route} model=${key.model || '-'} ${key.stream ? 'stream' : 'one-shot'}${key.tools ? '+tools' : ''} position=${key.position} lane=${JSON.stringify(lane)}`;
}

function parseRequestJson(raw: Buffer): unknown {
  if (raw.length === 0) {
    return null;
  }
  return JSON.parse(raw.toString('utf8'));
}

function recordedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (RECORDED_REQUEST_HEADERS.has(name) && typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

/** Reads a request's complete body. */
export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function utf8Body(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('A provider response body was not valid UTF-8; a cassette cannot hold it.');
  }
  return text;
}

/** One request to record: its parsed knob path and complete body. */
export interface ProviderCassetteRequest {
  readonly knob: ProviderCassetteKnob;
  readonly method: string;
  readonly rawBody: Buffer;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly route: string;
  readonly search: string;
}

/** Records exchanges for whichever server hands it requests (the proxy, or the E2E shim). */
export interface ProviderCassetteRecording {
  /** Every completed exchange, in request arrival order. */
  readonly exchanges: () => readonly ProviderCassetteExchange[];
  /** Why each request that never reached its provider, or never streamed back, failed: a cassette without them is incomplete. */
  readonly failures: () => readonly string[];
  /** Exchanges still streaming; a cassette is only complete once this is zero. */
  readonly inFlight: () => number;
  /** What each exchange still streaming has received so far, as text (a Stop waits on these). */
  readonly inFlightBodies: () => readonly string[];
  /** Forwards one request to its provider, streams the answer back and keeps the exchange. */
  readonly record: (input: ProviderCassetteRequest) => Promise<void>;
}

export interface ProviderCassetteRecordingOptions {
  readonly substitutions?: readonly ProviderCassetteSubstitution[];
  /** Real provider bases by knob (tests point these at a local stand-in). */
  readonly upstreams?: Readonly<Record<ProviderCassetteKnob, string>>;
}

/** The request headers forwarded upstream: the client's own, minus framing, uncompressed. */
function forwardedHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!UNFORWARDED_REQUEST_HEADERS.has(name) && typeof value === 'string') {
      headers.set(name, value);
    }
  }
  // Uncompressed, so the recorded bytes are the bytes the SDK parses.
  headers.set('accept-encoding', 'identity');
  return headers;
}

/**
 * Streams `upstream` to `response`, keeping each chunk's bytes and arrival
 * time. A client hang-up ends the copy (`clientGone`); any other failure throws.
 */
async function relay(
  upstream: Response,
  response: ServerResponse,
  arrivedAt: number,
  received: Buffer[],
  clientGone: () => boolean
): Promise<ProviderCassetteChunk[]> {
  const chunks: ProviderCassetteChunk[] = [];
  try {
    for await (const piece of upstream.body ?? []) {
      const bytes = Buffer.from(piece);
      received.push(bytes);
      chunks.push({ atMs: Date.now() - arrivedAt, bytes: bytes.length });
      response.write(bytes);
    }
    response.end();
  } catch (error) {
    if (!clientGone()) {
      throw error;
    }
  }
  return chunks;
}

export function createProviderCassetteRecording(
  options: ProviderCassetteRecordingOptions = {}
): ProviderCassetteRecording {
  const upstreams = options.upstreams ?? PROVIDER_CASSETTE_UPSTREAMS;
  const substitutions = options.substitutions ?? [];
  const startedAt = Date.now();
  const exchanges: { exchange: ProviderCassetteExchange; order: number }[] = [];
  let arrivals = 0;
  let inFlight = 0;
  const streaming = new Map<number, Buffer[]>();

  const forward = async (input: ProviderCassetteRequest, order: number): Promise<void> => {
    const { knob, method, rawBody, request, response, route, search } = input;
    const arrivedAt = Date.now();
    const body = substituteJson(parseRequestJson(rawBody), substitutions);
    const abort = new AbortController();
    let clientGone = false;
    response.on('close', () => {
      if (!response.writableFinished) {
        clientGone = true;
        abort.abort();
      }
    });
    const recordedRequest = { body, headers: recordedHeaders(request), method, route };
    const key = providerRequestKey({ body, knob, method, route });
    let upstream: Response;
    try {
      upstream = await fetch(`${upstreams[knob]}${route}${search}`, {
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: new Uint8Array(rawBody) }),
        headers: forwardedHeaders(request),
        method,
        signal: abort.signal,
      });
    } catch (error) {
      if (!clientGone) {
        throw error;
      }
      const unanswered = { body: '', chunks: [], contentType: null, status: null } as const;
      exchanges.push({
        exchange: {
          key,
          request: recordedRequest,
          response: { ...unanswered, ended: 'client-aborted' },
          startedAtMs: arrivedAt - startedAt,
        },
        order,
      });
      return;
    }
    const contentType = upstream.headers.get('content-type');
    response.writeHead(upstream.status, contentType ? { 'Content-Type': contentType } : {});
    const received: Buffer[] = [];
    streaming.set(order, received);
    const chunks = await relay(upstream, response, arrivedAt, received, () => clientGone).finally(
      () => streaming.delete(order)
    );
    exchanges.push({
      exchange: {
        key,
        request: recordedRequest,
        response: {
          body: utf8Body(Buffer.concat(received)),
          chunks,
          contentType,
          ended: clientGone ? 'client-aborted' : 'complete',
          status: upstream.status,
        },
        startedAtMs: arrivedAt - startedAt,
      },
      order,
    });
  };

  const failures: string[] = [];
  return {
    exchanges: () =>
      exchanges.toSorted((left, right) => left.order - right.order).map(({ exchange }) => exchange),
    failures: () => [...failures],
    inFlight: () => inFlight,
    inFlightBodies: () =>
      [...streaming.values()].map((parts) => Buffer.concat(parts).toString('utf8')),
    async record(input) {
      inFlight += 1;
      try {
        await forward(input, arrivals++);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        inFlight -= 1;
      }
    },
  };
}

export interface ProviderCassetteRecorder {
  readonly baseUrlFor: (knob: ProviderCassetteKnob) => string;
  readonly close: () => Promise<void>;
  readonly recording: ProviderCassetteRecording;
}

/** A loopback proxy that forwards each `/<KNOB>/route` to its provider and records the exchange. */
export async function startProviderCassetteRecorder(
  options: ProviderCassetteRecordingOptions = {}
): Promise<ProviderCassetteRecorder> {
  const recording = createProviderCassetteRecording(options);
  const server: Server = createServer((request, response) => {
    const path = parseProviderCassettePath(request.url);
    readBody(request)
      .then((rawBody) => {
        if (!path) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end(`The cassette recorder serves /<KNOB>/<route> only, not ${request.url}.`);
          return;
        }
        return recording.record({
          ...path,
          method: request.method ?? 'GET',
          rawBody,
          request,
          response,
        });
      })
      .catch((error: unknown) => {
        // The client reads the failure as its provider's answer: a 502 naming it.
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        response.end(`Cassette recorder failed: ${message}`);
      });
  });
  const baseUrl = await listen(server);
  return {
    baseUrlFor: (knob) => `${baseUrl}/${knob}`,
    close: () => closeServer(server),
    recording,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('Expected an assigned cassette server port.');
  }
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Why a replay refused a request, with the keys it still held. */
export interface ProviderCassetteRefusal {
  readonly key: ProviderRequestKey;
  readonly unserved: readonly ProviderRequestKey[];
}

export interface ProviderCassetteReplay {
  /** Client-aborted exchanges fully served and now held open, awaiting the client's hang-up. */
  readonly holding: () => number;
  /**
   * Serves the first unserved exchange recorded under this request's key, or
   * returns the refusal (the caller answers it). `rawBody` is the request's
   * complete body; `substitutions` map this run's literals to the recorded ones.
   */
  readonly serve: (input: {
    readonly knob: ProviderCassetteKnob;
    readonly method: string;
    readonly rawBody: Buffer;
    readonly response: ServerResponse;
    readonly route: string;
  }) => Promise<ProviderCassetteRefusal | undefined>;
  /** Recorded exchanges no request has claimed yet, in recorded order. */
  readonly unserved: () => readonly ProviderCassetteExchange[];
}

export interface ProviderCassetteReplayOptions {
  /**
   * 0 (default) serves each chunk on the next task; 1 waits out the recorded
   * times, each response no earlier than its recorded start after the first
   * request, so concurrent conversations (background children) settle in
   * their recorded order. Values between scale those times.
   */
  readonly pace?: number;
  readonly substitutions?: readonly ProviderCassetteSubstitution[];
}

const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Writes a recorded response's head and chunks, paced by `pace` from
 * `notBefore` (or from now, if that has passed). Resolves false when the client
 * hung up first; an unanswered response (status null) writes nothing.
 */
async function writeRecorded(
  recorded: ProviderCassetteResponse,
  response: ServerResponse,
  pace: number,
  notBefore: number
): Promise<boolean> {
  if (recorded.status !== null) {
    response.writeHead(
      recorded.status,
      recorded.contentType ? { 'Content-Type': recorded.contentType } : {}
    );
  }
  const bytes = Buffer.from(recorded.body, 'utf8');
  const servedAt = Math.max(Date.now(), notBefore);
  let offset = 0;
  for (const chunk of recorded.chunks) {
    const wait = chunk.atMs * pace - (Date.now() - servedAt);
    // One chunk per read, as the provider delivered them.
    await (pace > 0 && wait > 0 ? delay(wait) : nextTask());
    if (response.destroyed) {
      return false;
    }
    response.write(bytes.subarray(offset, offset + chunk.bytes));
    offset += chunk.bytes;
  }
  return true;
}

/** Resolves when the client hangs up: the response's own close, not a fully read request. */
function clientHangUp(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    if (response.destroyed) {
      resolve();
      return;
    }
    response.once('close', () => resolve());
  });
}

/** Serves `cassette`; each exchange answers exactly one request. */
export function createProviderCassetteReplay(
  cassette: ProviderCassette,
  options: ProviderCassetteReplayOptions = {}
): ProviderCassetteReplay {
  const substitutions = options.substitutions ?? [];
  const pace = options.pace ?? 0;
  const remaining = [...cassette.exchanges];
  const firstStartedAtMs = Math.min(...cassette.exchanges.map((exchange) => exchange.startedAtMs));
  /** When the first request was served: the recording's first arrival, replayed. */
  let replayStartedAt: number | undefined;
  let holding = 0;
  return {
    holding: () => holding,
    async serve({ knob, method, rawBody, response, route }) {
      const body = substituteJson(parseRequestJson(rawBody), substitutions);
      const key = providerRequestKey({ body, knob, method, route });
      const index = remaining.findIndex((exchange) => sameProviderRequestKey(exchange.key, key));
      const exchange = remaining[index];
      if (!exchange) {
        return { key, unserved: remaining.map((candidate) => candidate.key) };
      }
      remaining.splice(index, 1);
      const recorded = exchange.response;
      replayStartedAt ??= Date.now();
      // Never before its recorded start, so concurrent exchanges finish in their recorded order.
      const notBefore = replayStartedAt + (exchange.startedAtMs - firstStartedAtMs) * pace;
      if (!(await writeRecorded(recorded, response, pace, notBefore))) {
        return;
      }
      if (recorded.ended === 'complete') {
        response.end();
        return;
      }
      // The recorded client hung up here: hold until this client does too. Only
      // an answered exchange counts as held (a Stop waits on streamed output).
      const answered = recorded.status !== null;
      holding += answered ? 1 : 0;
      try {
        await clientHangUp(response);
      } finally {
        holding -= answered ? 1 : 0;
      }
      return;
    },
    unserved: () => [...remaining],
  };
}

/** Stable JSON for a cassette file. */
export function encodeProviderCassette(cassette: ProviderCassette): string {
  return `${JSON.stringify(cassette, null, 2)}\n`;
}

/** Reads a cassette file, refusing any other format or a malformed exchange. */
export function parseProviderCassette(text: string, source: string): ProviderCassette {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed['format'] !== PROVIDER_CASSETTE_FORMAT) {
    throw new Error(`${source} is not a ${PROVIDER_CASSETTE_FORMAT} cassette.`);
  }
  const exchanges = parsed['exchanges'];
  if (!Array.isArray(exchanges) || exchanges.length === 0) {
    throw new Error(`${source} holds no exchanges.`);
  }
  if (!isRecord(parsed['toolSets'])) {
    throw new Error(`${source} has no toolSets table.`);
  }
  for (const [index, exchange] of exchanges.entries()) {
    const response = isRecord(exchange) ? exchange['response'] : undefined;
    if (
      !(isRecord(exchange) && isRecord(exchange['key']) && isRecord(response)) ||
      typeof response['body'] !== 'string' ||
      !Array.isArray(response['chunks']) ||
      response['chunks'].reduce(
        (sum: number, chunk: unknown) =>
          sum + (isRecord(chunk) ? Number(chunk['bytes']) : Number.NaN),
        0
      ) !== Buffer.byteLength(response['body'], 'utf8')
    ) {
      throw new Error(`${source} exchange ${index} is malformed: its chunks must cover its body.`);
    }
  }
  return parsed as unknown as ProviderCassette;
}

/** One reason a cassette must not be written, located without echoing the value. */
export interface ProviderCassetteFinding {
  /** The exchange index, or null for the cassette's shared tool sets. */
  readonly exchange: number | null;
  readonly part: 'request' | 'response' | 'tool-sets';
  readonly rule: string;
}

/** An identifying literal to look for in a cassette. */
export interface ProviderCassetteLiteral {
  /** Found only as a whole path or name, never inside a longer one: `path/root` is not the home `/root`. */
  readonly bounded?: true;
  readonly rule: string;
  readonly value: string;
}

/** As a JSON string holds it: a Windows path's backslashes double. */
const jsonEscaped = (value: string): string => JSON.stringify(value).slice(1, -1);

function containsLiteral(text: string, { bounded, value }: ProviderCassetteLiteral): boolean {
  // Raw, JSON-escaped (a request or an SSE frame), and escaped twice (tool
  // arguments are JSON inside a request's JSON).
  const forms = new Set([value, jsonEscaped(value), jsonEscaped(jsonEscaped(value))]);
  return [...forms].some((form) => {
    if (!bounded) {
      return text.includes(form);
    }
    const pattern = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w.-])${pattern}(?![\\w.-])`, 'u').test(text);
  });
}

/**
 * Identifying literals left in a cassette (the recording machine's home
 * directory, a workspace path, the recorder's key), located without echoing
 * them. Secret-looking strings are the repository secret scanner's to find
 * (`scripts/secret-scan.mjs`); callers run it over the encoded cassette.
 */
export function providerCassetteFindings(
  cassette: Pick<ProviderCassette, 'exchanges' | 'toolSets'>,
  literals: readonly ProviderCassetteLiteral[]
): readonly ProviderCassetteFinding[] {
  const texts: [number | null, ProviderCassetteFinding['part'], string][] = [
    ...cassette.exchanges.flatMap(
      (exchange, index) =>
        [
          [index, 'request', JSON.stringify(exchange.request)],
          [index, 'response', exchange.response.body],
        ] as [number, ProviderCassetteFinding['part'], string][]
    ),
    [null, 'tool-sets', JSON.stringify(cassette.toolSets)],
  ];
  return texts.flatMap(([exchange, part, text]) =>
    literals
      .filter((literal) => literal.value && containsLiteral(text, literal))
      .map(({ rule }) => ({ exchange, part, rule }))
  );
}
