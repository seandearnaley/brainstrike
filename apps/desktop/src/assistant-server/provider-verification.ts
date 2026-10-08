/**
 * Per-provider credential-verification probes (BST-1357), modeled on
 * openrouter-model-metadata.ts: bounded TTL cache with live/fresh-cache
 * provenance, single-flight per (provider, credential), 10s timeout, no
 * retries — this is an advisory "Test connection" signal, not a run.
 *
 * Each probe is the CHEAPEST authenticated call that proves the credential
 * (see the probe table in docs/agents/assistant-providers.md). Routing is
 * authType-driven from the registry, never a provider-name special case:
 *
 * - authType 'none' (local/ollama/lmstudio) → typed `not_applicable`, ZERO
 *   network calls and ZERO credential reads — runtime liveness belongs to the
 *   ipc-runtime probe family.
 * - authType 'api_key' → per-provider probe table below. An api_key provider
 *   WITHOUT a table entry throws (NO SILENT FALLBACKS — a new provider must
 *   declare its probe, never inherit a guess).
 * - authType 'aws' + bearer credential → the Bedrock foundation-models
 *   listing. Activates whenever a registry provider declares authType 'aws'
 *   (BST-1350). An `api_key` credential counts as a bearer here, because that
 *   is the only shape an env var (or a legacy bare-string key) can produce and
 *   the request projection already treats it as one — its region comes from
 *   the shared `resolveEnvAwsRegion`, so probe and runtime cannot drift
 *   (PR #2529 finding 3).
 * - authType 'aws' + profile_chain credential → CHAIN RESOLUTION itself
 *   (BST-1353), not an HTTP call. This replaced the old `not_applicable`:
 *   the chain is the credential, so resolving it is the most direct possible
 *   proof, and it answers the question the user actually has ("is my SSO
 *   session still good?"). Verdicts: resolved → verified; expired SSO or an
 *   empty chain → invalid, with the actionable `aws sso login --profile
 *   <name>` guidance as the detail; an unrecognized SDK failure →
 *   unreachable, preserving "no verdict obtainable".
 * - 'tavily' is not a chat provider (no registry entry) but owns a settings
 *   slot; it gets a synthetic api_key target and its own credential reader.
 *
 * HTTP verdict mapping (ONE classifier module-wide; #2519 review): 2xx →
 * verified; 401 → invalid; 403 → verified_limited (authenticated but
 * permission-scoped — e.g. an InvokeModel-only Bedrock key — DISTINCT from
 * 401's wrong-key); 429 → verified_limited (a VALID key can be rate limited
 * or out of quota — OpenAI answers 429 insufficient_quota on real keys);
 * Google's documented API_KEY_INVALID 400 → invalid; anything else →
 * unreachable ("no auth verdict obtainable"), keeping `invalid` strictly
 * wrong-key and `unreachable` strictly wifi-down/upstream. Failure `detail`
 * is composed from the HTTP status ONLY — response bodies are never echoed —
 * and the openrouter success detail uses numeric usage figures only (the
 * /key `label` field carries key material).
 *
 * Caching (#2519 review): only `verified`/`verified_limited` earn the 60s
 * success TTL. Failures cache for a separate short `failureTtlMs` (3s) purely
 * to dedup click-storms — the wifi coming back or a corrected upstream must be
 * observable on the next deliberate click. The cache timestamp is sampled
 * AFTER the probe resolves, so a 10s timeout does not pre-burn its own TTL.
 */

import { createHash } from 'node:crypto';
import { verifyAwsCredentialChain } from '@brainstrike/agent';
import {
  findProviderDefinition,
  type ProviderAuthType,
  type ProviderCredential,
  type ProviderVerificationResult,
  type ProviderVerificationSnapshot,
  type ProviderVerificationStatus,
} from '@brainstrike/assistant-contract';
import { resolveEnvAwsRegion } from '@brainstrike/assistant-service/provider-credential-projection';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Effect } from 'effect';
import { resolveProviderBaseUrl } from './provider-base-url';
import { resolveProviderCredential } from './provider-credentials';
import { resolveTavilyApiKeyFromKeychain, TAVILY_SECRET_PROVIDER } from './web-search-tool';

const DEFAULT_SUCCESS_TTL_MS = 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 3 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 32;
const MAX_VISIBLE_ERROR_CHARS = 200;
const AWS_REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

class ProviderProbeRequestError extends Error {
  constructor(error: unknown) {
    super(toVisibleError(error), { cause: error });
    this.name = 'ProviderProbeRequestError';
  }
}

class ProviderProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'ProviderProbeTimeoutError';
  }
}

/** The provider id is not verifiable here (not in the registry, not tavily). */
export class UnknownVerificationProviderError extends Error {
  constructor() {
    super('Provider id is not a verifiable provider.');
    this.name = 'UnknownVerificationProviderError';
  }
}

/** The provider is known but has no configured credential to verify. */
export class MissingProviderCredentialError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`No credential configured for provider "${providerId}".`);
    this.name = 'MissingProviderCredentialError';
    this.providerId = providerId;
  }
}

/**
 * The stored credential's shape does not match any probe for the provider's
 * authType (e.g. an oauth credential on an api_key probe). Static message by
 * contract — never echoes credential fields.
 */
export class UnsupportedVerificationCredentialError extends Error {
  constructor(detail: string) {
    super(`Stored credential cannot be verified: ${detail}.`);
    this.name = 'UnsupportedVerificationCredentialError';
  }
}

export interface ProviderVerificationTarget {
  readonly authType: ProviderAuthType;
}

export interface ProviderVerificationService {
  verify(providerId: string): Promise<ProviderVerificationSnapshot>;
}

interface ProviderVerificationServiceOptions {
  /**
   * Environment the Bedrock region is read from, for the bearer credentials
   * that carry no region of their own (PR #2529 finding 3). Defaults to
   * `process.env` — the same source the request-path projection uses.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Short failure-result TTL — click-storm dedup only, never persistence. */
  readonly failureTtlMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Registry lookup seam; tests inject mock definitions (e.g. bedrock). */
  readonly findProvider?: (providerId: string) => ProviderVerificationTarget | undefined;
  readonly maxCacheEntries?: number;
  readonly now?: () => number;
  /** Typed main-side credential reader; the renderer only ever sends the id. */
  readonly readCredential?: (providerId: string) => Promise<ProviderCredential | undefined>;
  readonly requestTimeoutMs?: number;
  readonly successTtlMs?: number;
  /** AWS profile-chain resolution seam (BST-1353); tests inject verdicts. */
  readonly verifyAwsCredentialChain?: typeof verifyAwsCredentialChain;
  /**
   * Subscription-OAuth freshness seam (BST-1356). Wired to the shared
   * provider-auth engine's single-flight `getFreshAccessToken`. INJECTED, so
   * a host without the engine (web, headless) cannot verify a subscription
   * credential and says so — the same fail-closed shape as the AWS chain.
   */
  readonly verifySubscriptionSession?: (
    providerId: string
  ) => Promise<{ ok: true } | { ok: false; status: 'not_connected' | 'reconnect_required' }>;
}

interface ProbeRequest {
  readonly body?: string;
  readonly classifyHttp?: (response: Response, bodyText: string) => ProviderVerificationStatus;
  readonly describeSuccess?: (bodyText: string) => string | undefined;
  readonly headers: Record<string, string>;
  readonly method: 'GET' | 'POST';
  readonly url: string;
}

/**
 * The ONE HTTP classifier (#2519 review): 401 is the only wrong-key status;
 * 403 and 429 both prove the credential authenticated (permission-scoped and
 * rate-limited/out-of-quota respectively — e.g. an InvokeModel-only Bedrock
 * key's 403, or OpenAI's 429 insufficient_quota on a valid key).
 */
function classifySharedHttp(response: Response): ProviderVerificationStatus {
  if (response.ok) {
    return 'verified';
  }
  if (response.status === 401) {
    return 'invalid';
  }
  if (response.status === 403 || response.status === 429) {
    return 'verified_limited';
  }
  return 'unreachable';
}

function classifyGoogleHttp(response: Response, bodyText: string): ProviderVerificationStatus {
  // Google's Generative Language API rejects a bad key with a documented 400
  // API_KEY_INVALID rather than a 401 — that IS a wrong-key verdict.
  if (response.status === 400 && bodyText.includes('API_KEY_INVALID')) {
    return 'invalid';
  }
  return classifySharedHttp(response);
}

function describeOpenRouterKeyUsage(bodyText: string): string | undefined {
  // Numeric usage figures only: the /key payload's `label` is key material and
  // must never reach the wire.
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return;
  }
  const data = (parsed as Record<string, unknown>)['data'];
  if (typeof data !== 'object' || data === null) {
    return;
  }
  const record = data as Record<string, unknown>;
  const usage = record['usage'];
  if (typeof usage !== 'number' || !Number.isFinite(usage)) {
    return;
  }
  const limit = record['limit'];
  const limitPart =
    typeof limit === 'number' && Number.isFinite(limit) ? `of limit ${limit}` : '(no limit)';
  const freeTierPart = record['is_free_tier'] === true ? ', free tier' : '';
  return `usage ${usage} ${limitPart}${freeTierPart}`;
}

function bearerProbe(url: string, key: string): ProbeRequest {
  return {
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    method: 'GET',
    url,
  };
}

/**
 * Every provider id with a declared api_key probe. A CLOSED literal union is
 * the narrowest key form the current type system allows: `authType` lives on
 * registry VALUES, not per-id types, so "every api_key ProviderId" is not
 * expressible as a compile-time key set. The runtime contract test
 * ("declares a probe for every registry api_key provider plus tavily",
 * provider-verification.test.ts) closes that gap — a new api_key provider
 * without a probe entry is a red build, matching the header's no-silent-
 * fallbacks claim.
 */
type ApiKeyProbeProviderId =
  | 'anthropic'
  | 'cohere'
  | 'google'
  | 'openai'
  | 'openrouter'
  | typeof TAVILY_SECRET_PROVIDER
  | 'voyage';

/**
 * Cheapest authenticated call per api_key provider. Endpoints verified against
 * vendor docs 2026-08-18; voyage publishes NO model-list GET, so its probe is
 * a minimal one-token embeddings POST (the documented minimal call — note it
 * is METERED, unlike the GET probes).
 */
type ProbeEnv = Readonly<Record<string, string | undefined>>;

const API_KEY_PROBES: Record<ApiKeyProbeProviderId, (key: string, env: ProbeEnv) => ProbeRequest> =
  {
    anthropic: (key, env) => ({
      headers: {
        accept: 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
      },
      method: 'GET',
      url: `${resolveProviderBaseUrl('anthropic', env)}/models`,
    }),
    cohere: (key) => bearerProbe('https://api.cohere.com/v1/models', key),
    google: (key) => ({
      classifyHttp: classifyGoogleHttp,
      // Header auth on purpose: the documented `?key=` query param would put the
      // credential in URLs (and any log that records them).
      headers: { accept: 'application/json', 'x-goog-api-key': key },
      method: 'GET',
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
    }),
    openai: (key, env) => bearerProbe(`${resolveProviderBaseUrl('openai', env)}/models`, key),
    openrouter: (key, env) => ({
      ...bearerProbe(`${resolveProviderBaseUrl('openrouter', env)}/key`, key),
      describeSuccess: describeOpenRouterKeyUsage,
    }),
    [TAVILY_SECRET_PROVIDER]: (key) => bearerProbe('https://api.tavily.com/usage', key),
    voyage: (key) => ({
      body: JSON.stringify({ input: ['ping'], model: 'voyage-3' }),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      url: 'https://api.voyageai.com/v1/embeddings',
    }),
  };

function buildAwsBearerProbe(bearerKey: string, region: string): ProbeRequest {
  if (region.length === 0) {
    // DISTINCT from a malformed region: nothing is configured at all. Say so,
    // because the fix is different (set one) and because reporting "invalid
    // region name" for an absent region misdiagnoses the problem.
    throw new UnsupportedVerificationCredentialError(
      'no AWS region is configured for Bedrock — set one in Settings or via AWS_REGION'
    );
  }
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new UnsupportedVerificationCredentialError('the AWS region is not a valid region name');
  }
  return bearerProbe(`https://bedrock.${region}.amazonaws.com/foundation-models`, bearerKey);
}

/** Pinned by the probe-coverage contract test — see {@link ApiKeyProbeProviderId}. */
export function listApiKeyProbeProviderIds(): readonly string[] {
  return Object.keys(API_KEY_PROBES);
}

function findApiKeyProbe(
  providerId: string
): ((key: string, env: ProbeEnv) => ProbeRequest) | undefined {
  return (
    API_KEY_PROBES as Record<string, ((key: string, env: ProbeEnv) => ProbeRequest) | undefined>
  )[providerId];
}

/** A profile-chain verification: resolve the chain itself (BST-1353). */
interface ChainProbe {
  /** `undefined` = the chain's default profile resolution. */
  readonly resolveChain: string | undefined;
}

function isChainProbe(probe: ProbeRequest | ChainProbe | SubscriptionProbe): probe is ChainProbe {
  return 'resolveChain' in probe;
}

/**
 * A subscription-OAuth verification (BST-1356): the credential IS the token
 * pair, so the probe is proving the session can still mint a fresh access
 * token. Mirrors the BST-1353 chain probe, where resolving the credential is
 * itself the most useful answer available without spending a turn.
 */
interface SubscriptionProbe {
  readonly refreshSubscription: string;
}

function isSubscriptionProbe(
  probe: ProbeRequest | ChainProbe | SubscriptionProbe
): probe is SubscriptionProbe {
  return 'refreshSubscription' in probe;
}

function resolveProbe(
  providerId: string,
  target: ProviderVerificationTarget,
  credential: ProviderCredential,
  env: Readonly<Record<string, string | undefined>>
): ProbeRequest | ChainProbe | SubscriptionProbe {
  if (target.authType === 'oauth_subscription') {
    if (credential.type !== 'oauth') {
      throw new UnsupportedVerificationCredentialError(
        'the provider expects a subscription sign-in but a different credential type is stored'
      );
    }
    return { refreshSubscription: providerId };
  }

  if (target.authType === 'aws') {
    // An `api_key` credential on an aws provider IS a Bedrock bearer (PR
    // #2529 review, finding 3): environment variables cannot encode the aws
    // union, so BRAINSTRIKE_BEDROCK_API_KEY / AWS_BEARER_TOKEN_BEDROCK — and
    // every legacy bare-string key stored under bedrock — resolve to this
    // shape. `providerAuthInputFromCredential` deliberately projects it to
    // aws bearer auth with the env region, so the probe MUST do the same:
    // rejecting it reported `verification_unsupported` for a credential that
    // real turns authenticate with successfully.
    if (credential.type === 'api_key') {
      return buildAwsBearerProbe(credential.key, resolveEnvAwsRegion(env));
    }
    if (credential.type !== 'aws') {
      throw new UnsupportedVerificationCredentialError(
        'the provider expects an AWS credential but a different type is stored'
      );
    }
    if (credential.mode === 'profile_chain') {
      // BST-1353: the chain IS the credential, so resolving it is the probe —
      // no network call, and a far more useful verdict than the old
      // `not_applicable`. It answers the question the user actually has
      // ("will my SSO session work?") before they spend a turn finding out.
      return { resolveChain: credential.profile };
    }
    // A STORED aws bearer carries its own region; the environment never
    // overrides it (matching the projection's `credential.region`).
    return buildAwsBearerProbe(credential.bearerKey, credential.region);
  }

  if (credential.type !== 'api_key') {
    throw new UnsupportedVerificationCredentialError(
      'only api_key credentials are verifiable for this provider'
    );
  }
  const buildProbe = findApiKeyProbe(providerId);
  if (!buildProbe) {
    // NO SILENT FALLBACKS: a provider without a declared probe is a loud gap.
    throw new UnsupportedVerificationCredentialError(
      'no verification probe is declared for this provider'
    );
  }
  return buildProbe(credential.key, env);
}

function requirePositiveInteger(value: number, field: string): number {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function toVisibleError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Provider verification probe failed';
  return message.slice(0, MAX_VISIBLE_ERROR_CHARS);
}

async function defaultReadCredential(providerId: string): Promise<ProviderCredential | undefined> {
  if (providerId === TAVILY_SECRET_PROVIDER) {
    const key = await resolveTavilyApiKeyFromKeychain();
    return key === undefined ? undefined : { key, type: 'api_key' };
  }
  return await resolveProviderCredential(providerId);
}

function defaultFindProvider(providerId: string): ProviderVerificationTarget | undefined {
  if (providerId === TAVILY_SECRET_PROVIDER) {
    // Tavily owns a settings key slot but is not a chat provider, so it has no
    // registry definition; it verifies exactly like an api_key provider.
    return { authType: 'api_key' };
  }
  return findProviderDefinition(providerId);
}

export function createProviderVerificationService(
  options: ProviderVerificationServiceOptions = {}
): ProviderVerificationService {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const findProvider = options.findProvider ?? defaultFindProvider;
  const readCredential = options.readCredential ?? defaultReadCredential;
  const successTtlMs = requirePositiveInteger(
    options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS,
    'successTtlMs'
  );
  const failureTtlMs = requirePositiveInteger(
    options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS,
    'failureTtlMs'
  );
  const requestTimeoutMs = requirePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs'
  );
  const maxCacheEntries = requirePositiveInteger(
    options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
    'maxCacheEntries'
  );
  // Injected like fetchImpl so tests can drive every chain verdict without a
  // real ~/.aws (BST-1353).
  const verifyChain = options.verifyAwsCredentialChain ?? verifyAwsCredentialChain;
  const verifySubscription = options.verifySubscriptionSession;

  const cache = new Map<string, { checkedAtMs: number; result: ProviderVerificationResult }>();
  const pending = new Map<string, Promise<ProviderVerificationSnapshot>>();

  const retain = (key: string, checkedAtMs: number, result: ProviderVerificationResult): void => {
    cache.delete(key);
    cache.set(key, { checkedAtMs, result });
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      cache.delete(oldest);
    }
  };

  /**
   * Profile-chain verification (BST-1353): resolving the chain IS the probe.
   *
   * Verdict mapping keeps the module-wide semantics intact — `invalid` stays
   * strictly "this credential will not authenticate", which is exactly what
   * an expired SSO session and an empty chain both mean; `unreachable` stays
   * "no verdict obtainable", which is where an unrecognized SDK failure (a
   * DNS error during an SSO refresh, say) belongs. The failure `detail` is
   * the actionable guidance from the agent's classifier, so an expired
   * session shows the `aws sso login --profile <name>` command right in the
   * settings row.
   */
  /**
   * Subscription-OAuth probe (BST-1356). Refreshing proves the stored refresh
   * token is still honored by OpenAI — the question a user actually has
   * ("is my ChatGPT sign-in still good?") — WITHOUT spending subscription
   * quota on a model call.
   *
   * `verified_limited`, never `verified`: module-wide, `verified` means the
   * provider's API accepted the credential, and this never touches the Codex
   * backend. Same rung the AWS chain probe earns, for the same reason
   * (#2525 finding 5).
   *
   * NOTE on caching: the cache key hashes the credential, and an oauth
   * credential's `access`/`expires` rotate on refresh, so a successful probe
   * is effectively never served from cache. That is deliberate here — a
   * freshness check the user explicitly asked for should be live.
   */
  const runSubscriptionProbe = async (providerId: string): Promise<ProviderVerificationResult> => {
    const checkedAt = new Date(now()).toISOString();
    if (!verifySubscription) {
      // Fail closed: a host without the provider-auth engine cannot answer.
      throw new UnsupportedVerificationCredentialError(
        'subscription sign-in can only be verified in the desktop app'
      );
    }
    const outcome = await verifySubscription(providerId);
    if (outcome.ok) {
      return {
        checkedAt,
        detail: 'Refreshed the subscription sign-in; model access was not exercised.',
        status: 'verified_limited',
      };
    }
    return {
      checkedAt,
      detail:
        outcome.status === 'reconnect_required'
          ? 'The subscription sign-in expired or was revoked. Reconnect the account.'
          : 'No subscription account is connected for this provider.',
      // Both branches mean "this credential will not authenticate" — invalid,
      // not unreachable (which reserves "no verdict obtainable").
      status: 'invalid',
    };
  };

  const runChainProbe = async (
    profile: string | undefined
  ): Promise<ProviderVerificationResult> => {
    const checkedAt = new Date(now()).toISOString();
    // BOUNDED (#2525 finding 3): reuses the probe's own requestTimeoutMs, so
    // a hanging `credential_process`, a stalled SSO refresh, or an IMDS
    // connect timeout settles this entry instead of wedging the single-flight
    // map behind a promise that never resolves.
    const outcome = await verifyChain(profile, { timeoutMs: requestTimeoutMs });
    if (outcome.ok) {
      return {
        checkedAt,
        // verified_LIMITED, not verified (#2525 finding 5). Module-wide,
        // `verified` means the provider's API accepted the credential.
        // Resolution proves only that local credentials exist — it never
        // touches Bedrock — so reporting `verified` would silently redefine
        // the status for one provider. This is the same rung a 403 earns:
        // authenticated, but the probe could not fully succeed.
        detail: `Resolved AWS credentials from the ${
          profile ? `"${profile}"` : 'default'
        } profile chain; Bedrock access not exercised.`,
        status: 'verified_limited',
      };
    }
    return {
      checkedAt,
      detail: outcome.detail.slice(0, MAX_VISIBLE_ERROR_CHARS),
      status: outcome.kind === 'unknown' ? 'unreachable' : 'invalid',
    };
  };

  const runProbe = async (probe: ProbeRequest): Promise<ProviderVerificationResult> => {
    const checkedAt = new Date(now()).toISOString();
    const request = Effect.tryPromise({
      catch: (error: unknown): Error =>
        error instanceof Error ? error : new ProviderProbeRequestError(error),
      try: async (signal: AbortSignal): Promise<{ response: Response; bodyText: string }> => {
        const response = await fetchImpl(probe.url, {
          ...(probe.body === undefined ? {} : { body: probe.body }),
          headers: probe.headers,
          method: probe.method,
          signal,
        });
        signal.throwIfAborted();
        const bodyText = await response.text();
        signal.throwIfAborted();
        return { bodyText, response };
      },
    });
    const bounded = Effect.timeoutOrElse(request, {
      duration: requestTimeoutMs,
      orElse: (): Effect.Effect<never, ProviderProbeTimeoutError> =>
        Effect.fail(new ProviderProbeTimeoutError(requestTimeoutMs)),
    });
    try {
      const { response, bodyText } = await runAtPromiseBoundary(bounded);
      const status = (probe.classifyHttp ?? classifySharedHttp)(response, bodyText);
      if (status === 'verified') {
        const detail = probe.describeSuccess?.(bodyText)?.slice(0, MAX_VISIBLE_ERROR_CHARS);
        return { checkedAt, ...(detail === undefined ? {} : { detail }), status };
      }
      // Non-2xx detail comes from the STATUS CODE only — never the body, which
      // can echo request headers (and therefore key material) on some vendors.
      const detail =
        status === 'verified_limited'
          ? response.status === 429
            ? 'HTTP 429 — credential authenticated but rate limited'
            : `HTTP ${response.status} — credential authenticated but lacks permission`
          : `HTTP ${response.status}`;
      return { checkedAt, detail, status };
    } catch (error) {
      return { checkedAt, detail: toVisibleError(error), status: 'unreachable' };
    }
  };

  return {
    async verify(providerId: string): Promise<ProviderVerificationSnapshot> {
      const target = findProvider(providerId);
      if (!target) {
        throw new UnknownVerificationProviderError();
      }
      if (target.authType === 'none') {
        // Keyless local runtimes: liveness is the ipc-runtime probe family's
        // concern; there is no credential to verify and no network call here.
        return {
          freshness: 'live',
          result: {
            checkedAt: new Date(now()).toISOString(),
            detail: 'Keyless local runtime; there is no credential to verify.',
            status: 'not_applicable',
          },
        };
      }

      const credential = await readCredential(providerId);
      if (!credential) {
        throw new MissingProviderCredentialError(providerId);
      }
      const probe = resolveProbe(providerId, target, credential, env);

      // Cache and single-flight key on (provider, credential digest): a
      // just-changed key must re-probe immediately, never serve the previous
      // key's cached verdict.
      const cacheKey = `${providerId}:${createHash('sha256')
        .update(JSON.stringify(credential))
        .digest('hex')}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        // Only proven-good credentials earn the long TTL; failures dedup
        // click-storms briefly and then re-probe, so recovery (wifi back,
        // upstream fixed) is observable on the next deliberate click.
        const ttlMs =
          cached.result.status === 'verified' || cached.result.status === 'verified_limited'
            ? successTtlMs
            : failureTtlMs;
        if (now() - cached.checkedAtMs < ttlMs) {
          return { freshness: 'fresh-cache', result: cached.result };
        }
      }

      const existing = pending.get(cacheKey);
      if (existing) {
        return await existing;
      }
      const request = (async (): Promise<ProviderVerificationSnapshot> => {
        let result: ProviderVerificationResult;
        if (isSubscriptionProbe(probe)) {
          result = await runSubscriptionProbe(probe.refreshSubscription);
        } else if (isChainProbe(probe)) {
          result = await runChainProbe(probe.resolveChain);
        } else {
          result = await runProbe(probe);
        }
        // Timestamp AFTER the probe resolves: a probe that spent its 10s
        // timeout failing must not pre-burn the failure TTL it just earned.
        retain(cacheKey, now(), result);
        return { freshness: 'live', result };
      })().finally(() => {
        pending.delete(cacheKey);
      });
      pending.set(cacheKey, request);
      return await request;
    },
  };
}
