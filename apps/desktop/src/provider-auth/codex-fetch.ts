import { CODEX_RESPONSES_ENDPOINT, extractCodexResidency } from './descriptors/openai-codex';

/**
 * Codex request rewriting (BST-1356).
 *
 * The AI SDK builds a standard OpenAI Responses request against
 * `api.openai.com` and signs it with the dummy `apiKey` the factory was handed.
 * This closure is the ONLY place the real subscription bearer is applied:
 *
 * 1. Strip the SDK's authorization header (whatever shape it arrived in).
 * 2. Ask the provider-auth engine for a fresh access token — the engine owns
 *    single-flight refresh, so this is a cheap read in the common case and
 *    never replays a rotating refresh token.
 * 3. Attach the subscription bearer, the ChatGPT account, and honest client
 *    identification (`originator: brainstrike` — gate constraint 5).
 * 4. Redirect responses/chat traffic onto the Codex backend and pin
 *    `store: false`, matching the Codex CLI.
 *
 * Gate constraint 2: the rewrite target is OpenAI's OWN host. No Brainstrike
 * server sits in this path — the request goes device -> OpenAI directly.
 * Gate constraint 3: the token exists only in this closure's local scope for
 * the duration of one request. It is never logged, never returned, and never
 * placed on any object that outlives the call.
 */

/** Header OpenAI uses to route region-constrained accounts (upstream #42432). */
const RESIDENCY_HEADER = 'x-openai-internal-codex-residency';

export interface CodexFetchDeps {
  /** Injectable for tests; defaults to the platform fetch. */
  readonly baseFetch?: typeof globalThis.fetch;
  /** Fresh-token accessor, wired to `engine.getFreshAccessToken`. MUST throw
   * (never return a stale or empty token) when the provider is not connected. */
  readonly getAccessToken: () => Promise<string>;
  /** ChatGPT account for the connected credential, when known. */
  readonly getAccountId?: () => string | undefined;
  readonly sessionId: string;
  readonly userAgent: string;
}

/**
 * Only `string` and `URL` inputs are supported.
 *
 * A `Request` carries its own method, headers and body, and this layer
 * rebuilds the outgoing request from `init` alone — so accepting one would
 * silently drop the payload and send a bodiless GET to the Codex backend.
 * The AI SDK never passes a `Request` here; if that ever changes, this must
 * fail loudly rather than mangle the turn (NO SILENT FALLBACKS).
 */
function resolveUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === 'string') {
    return new URL(input);
  }
  throw new TypeError(
    'Codex fetch received a Request object; only string and URL inputs are supported, because a Request carries method/headers/body this layer would silently drop.'
  );
}

/** Codex serves both the Responses API and chat-completions traffic from one
 * endpoint; the AI SDK may emit either path shape. */
function shouldRewrite(url: URL): boolean {
  return url.pathname.includes('/v1/responses') || url.pathname.includes('/chat/completions');
}

/**
 * Normalize any `HeadersInit` into a `Headers` and drop the SDK's
 * authorization. `new Headers()` accepts all three shapes (instance, tuple
 * array, plain object) and `delete` is case-insensitive, so `Authorization`
 * and `authorization` are both removed regardless of how they arrived.
 */
function headersWithoutAuthorization(init: HeadersInit | undefined): Headers {
  const headers = new Headers();
  if (init !== undefined) {
    for (const [key, value] of new Headers(init).entries()) {
      headers.set(key, value);
    }
  }
  headers.delete('authorization');
  return headers;
}

/**
 * Pin `store: false` the way the Codex CLI does. A rewritten request whose
 * body cannot be parsed as a JSON object is a real defect (the Codex backend
 * only accepts JSON payloads) — it throws rather than shipping a request whose
 * storage behavior we could not control.
 */
function withStoreDisabled(
  body: BodyInit | null | undefined,
  url: URL
): BodyInit | null | undefined {
  if (typeof body !== 'string' || body.length === 0) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `Codex request body for ${url.pathname} is not valid JSON, so store:false could not be enforced.`,
      { cause: error }
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Codex request body for ${url.pathname} is not a JSON object, so store:false could not be enforced.`
    );
  }
  return JSON.stringify({ ...(parsed as Record<string, unknown>), store: false });
}

export function createCodexFetch(deps: CodexFetchDeps): typeof globalThis.fetch {
  const baseFetch = deps.baseFetch ?? globalThis.fetch;

  return async function codexFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const requestUrl = resolveUrl(input);
    const rewrite = shouldRewrite(requestUrl);

    // Acquire the token BEFORE touching the request: a failure here must never
    // fall through to an unauthenticated send.
    const accessToken = await deps.getAccessToken();

    const headers = headersWithoutAuthorization(init?.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    headers.set('originator', 'brainstrike');
    headers.set('session-id', deps.sessionId);
    headers.set('user-agent', deps.userAgent);
    const accountId = deps.getAccountId?.();
    if (accountId !== undefined && accountId.length > 0) {
      headers.set('ChatGPT-Account-Id', accountId);
    }

    if (!rewrite) {
      return await baseFetch(requestUrl, { ...init, headers });
    }

    const residency = extractCodexResidency(accessToken);
    if (residency !== undefined) {
      headers.set(RESIDENCY_HEADER, residency);
    }

    // Spread conditionally: `...init` already carries the original body, and
    // an absent body must stay absent rather than become an explicit
    // `undefined` (which the RequestInit overloads reject).
    const body = withStoreDisabled(init?.body, requestUrl);
    return await baseFetch(new URL(CODEX_RESPONSES_ENDPOINT), {
      ...init,
      ...(body === undefined ? {} : { body }),
      headers,
    });
  };
}
