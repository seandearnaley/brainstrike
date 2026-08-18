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
 *   listing; 403 with valid auth (an InvokeModel-only key) is
 *   `verified_limited`, DISTINCT from 401 `invalid`. Activates whenever a
 *   registry provider declares authType 'aws' (BST-1350). Profile-chain
 *   credentials have no bearer to send → typed `not_applicable`.
 * - 'tavily' is not a chat provider (no registry entry) but owns a settings
 *   slot; it gets a synthetic api_key target and its own credential reader.
 *
 * HTTP verdict mapping: 2xx → verified; 401/403 → invalid (aws 403 →
 * verified_limited); Google's documented API_KEY_INVALID 400 → invalid;
 * anything else → unreachable ("no auth verdict obtainable"), keeping
 * `invalid` strictly wrong-key and `unreachable` strictly wifi-down/upstream.
 * Failure `detail` is composed from the HTTP status ONLY — response bodies are
 * never echoed — and the openrouter success detail uses numeric usage figures
 * only (the /key `label` field carries key material).
 */

import { createHash } from 'node:crypto';
import {
  findProviderDefinition,
  type ProviderAuthType,
  type ProviderCredential,
  type ProviderVerificationResult,
  type ProviderVerificationSnapshot,
  type ProviderVerificationStatus,
} from '@brainstrike/assistant-contract';
import { resolveProviderCredential } from './provider-credentials';
import { resolveTavilyApiKeyFromKeychain, TAVILY_SECRET_PROVIDER } from './web-search-tool';

const DEFAULT_SUCCESS_TTL_MS = 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 32;
const MAX_VISIBLE_ERROR_CHARS = 200;
const AWS_REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

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
  readonly fetchImpl?: typeof fetch;
  /** Registry lookup seam; tests inject mock definitions (e.g. bedrock). */
  readonly findProvider?: (providerId: string) => ProviderVerificationTarget | undefined;
  readonly maxCacheEntries?: number;
  readonly now?: () => number;
  /** Typed main-side credential reader; the renderer only ever sends the id. */
  readonly readCredential?: (providerId: string) => Promise<ProviderCredential | undefined>;
  readonly requestTimeoutMs?: number;
  readonly successTtlMs?: number;
}

interface ProbeRequest {
  readonly body?: string;
  readonly classifyHttp?: (response: Response, bodyText: string) => ProviderVerificationStatus;
  readonly describeSuccess?: (bodyText: string) => string | undefined;
  readonly headers: Record<string, string>;
  readonly method: 'GET' | 'POST';
  readonly url: string;
}

function classifyApiKeyHttp(response: Response): ProviderVerificationStatus {
  if (response.ok) {
    return 'verified';
  }
  if (response.status === 401 || response.status === 403) {
    return 'invalid';
  }
  return 'unreachable';
}

function classifyGoogleHttp(response: Response, bodyText: string): ProviderVerificationStatus {
  // Google's Generative Language API rejects a bad key with a documented 400
  // API_KEY_INVALID rather than a 401 — that IS a wrong-key verdict.
  if (response.status === 400 && bodyText.includes('API_KEY_INVALID')) {
    return 'invalid';
  }
  return classifyApiKeyHttp(response);
}

function classifyAwsBearerHttp(response: Response): ProviderVerificationStatus {
  if (response.ok) {
    return 'verified';
  }
  if (response.status === 403) {
    // Authenticated but scoped below ListFoundationModels (e.g. an
    // InvokeModel-only key): the credential itself is proven usable.
    return 'verified_limited';
  }
  if (response.status === 401) {
    return 'invalid';
  }
  return 'unreachable';
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
 * Cheapest authenticated call per api_key provider. Endpoints verified against
 * vendor docs 2026-08-18; voyage publishes NO model-list GET, so its probe is
 * a minimal one-token embeddings POST (the documented minimal call).
 */
const API_KEY_PROBES: Record<string, (key: string) => ProbeRequest> = {
  anthropic: (key) => ({
    headers: {
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': key,
    },
    method: 'GET',
    url: 'https://api.anthropic.com/v1/models',
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
  openai: (key) => bearerProbe('https://api.openai.com/v1/models', key),
  openrouter: (key) => ({
    ...bearerProbe('https://openrouter.ai/api/v1/key', key),
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

function buildAwsBearerProbe(
  credential: Extract<ProviderCredential, { type: 'aws'; mode: 'bearer' }>
): ProbeRequest {
  if (!AWS_REGION_PATTERN.test(credential.region)) {
    throw new UnsupportedVerificationCredentialError('the AWS region is not a valid region name');
  }
  return {
    ...bearerProbe(
      `https://bedrock.${credential.region}.amazonaws.com/foundation-models`,
      credential.bearerKey
    ),
    classifyHttp: classifyAwsBearerHttp,
  };
}

function resolveProbe(
  providerId: string,
  target: ProviderVerificationTarget,
  credential: ProviderCredential
): ProbeRequest | { readonly notApplicable: string } {
  if (target.authType === 'aws') {
    if (credential.type !== 'aws') {
      throw new UnsupportedVerificationCredentialError(
        'the provider expects an AWS credential but a different type is stored'
      );
    }
    if (credential.mode === 'profile_chain') {
      return {
        notApplicable:
          'AWS profile-chain credentials have no bearer token to probe; verification is not applicable.',
      };
    }
    return buildAwsBearerProbe(credential);
  }

  if (credential.type !== 'api_key') {
    throw new UnsupportedVerificationCredentialError(
      'only api_key credentials are verifiable for this provider'
    );
  }
  const buildProbe = API_KEY_PROBES[providerId];
  if (!buildProbe) {
    // NO SILENT FALLBACKS: a provider without a declared probe is a loud gap.
    throw new UnsupportedVerificationCredentialError(
      'no verification probe is declared for this provider'
    );
  }
  return buildProbe(credential.key);
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
  const now = options.now ?? Date.now;
  const findProvider = options.findProvider ?? defaultFindProvider;
  const readCredential = options.readCredential ?? defaultReadCredential;
  const successTtlMs = requirePositiveInteger(
    options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS,
    'successTtlMs'
  );
  const requestTimeoutMs = requirePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs'
  );
  const maxCacheEntries = requirePositiveInteger(
    options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
    'maxCacheEntries'
  );

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

  const runProbe = async (probe: ProbeRequest): Promise<ProviderVerificationResult> => {
    const checkedAt = new Date(now()).toISOString();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    try {
      const response = await fetchImpl(probe.url, {
        ...(probe.body === undefined ? {} : { body: probe.body }),
        headers: probe.headers,
        method: probe.method,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      const status = (probe.classifyHttp ?? classifyApiKeyHttp)(response, bodyText);
      if (status === 'verified') {
        const detail = probe.describeSuccess?.(bodyText)?.slice(0, MAX_VISIBLE_ERROR_CHARS);
        return { checkedAt, ...(detail === undefined ? {} : { detail }), status };
      }
      // Failure detail comes from the STATUS CODE only — never the body, which
      // can echo request headers (and therefore key material) on some vendors.
      const detail =
        status === 'verified_limited'
          ? `HTTP ${response.status} — credential authenticated but lacks list permission`
          : `HTTP ${response.status}`;
      return { checkedAt, detail, status };
    } catch (error) {
      const detail = timedOut
        ? `Request timed out after ${requestTimeoutMs}ms`
        : toVisibleError(error);
      return { checkedAt, detail, status: 'unreachable' };
    } finally {
      clearTimeout(timeout);
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
      const probe = resolveProbe(providerId, target, credential);
      if ('notApplicable' in probe) {
        return {
          freshness: 'live',
          result: {
            checkedAt: new Date(now()).toISOString(),
            detail: probe.notApplicable,
            status: 'not_applicable',
          },
        };
      }

      // Cache and single-flight key on (provider, credential digest): a
      // just-changed key must re-probe immediately, never serve the previous
      // key's cached verdict.
      const cacheKey = `${providerId}:${createHash('sha256')
        .update(JSON.stringify(credential))
        .digest('hex')}`;
      const cached = cache.get(cacheKey);
      if (cached && now() - cached.checkedAtMs < successTtlMs) {
        return { freshness: 'fresh-cache', result: cached.result };
      }

      const existing = pending.get(cacheKey);
      if (existing) {
        return await existing;
      }
      const request = (async (): Promise<ProviderVerificationSnapshot> => {
        const checkedAtMs = now();
        const result = await runProbe(probe);
        retain(cacheKey, checkedAtMs, result);
        return { freshness: 'live', result };
      })().finally(() => {
        pending.delete(cacheKey);
      });
      pending.set(cacheKey, request);
      return await request;
    },
  };
}
