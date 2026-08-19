/**
 * Provider credential-verification probe results (BST-1357).
 *
 * A verification probe is the CHEAPEST authenticated call that proves a stored
 * provider credential works — an advisory "Test connection" signal, never part
 * of a run. The wire contract is deliberately narrow:
 *
 * - `verified` — the probe authenticated (HTTP 2xx).
 * - `verified_limited` — the credential authenticated but the probe could not
 *   fully succeed on it: 403 (permission-scoped, e.g. an InvokeModel-only AWS
 *   bearer key answering the foundation-models listing) or 429 (a VALID key
 *   that is rate limited or out of quota — OpenAI answers 429
 *   insufficient_quota on real keys).
 * - `invalid` — the endpoint answered and rejected the credential: 401, or a
 *   vendor-documented invalid-key rejection such as Google's API_KEY_INVALID
 *   400. Wrong key.
 * - `unreachable` — no auth verdict was obtainable: network error, timeout, or
 *   any HTTP status outside the classified set above (404, 5xx, …).
 *   Wifi-down, not wrong-key — `invalid` and `unreachable` are DISTINCT by
 *   contract.
 * - `not_applicable` — nothing to verify over HTTP: keyless local runtimes
 *   (authType 'none' routes here without a network call; their liveness is the
 *   ipc-runtime probe family's job) and AWS profile-chain credentials (no
 *   bearer to send).
 *
 * `detail` is bounded, advisory, and MUST NEVER carry credential material —
 * producers compose it from HTTP status codes and numeric usage figures only.
 */

export const PROVIDER_VERIFICATION_STATUSES = [
  'verified',
  'verified_limited',
  'invalid',
  'unreachable',
  'not_applicable',
] as const;

export type ProviderVerificationStatus = (typeof PROVIDER_VERIFICATION_STATUSES)[number];

export const MAX_PROVIDER_VERIFICATION_DETAIL_CHARS = 300;

export interface ProviderVerificationResult {
  /** ISO-8601 timestamp of the probe that produced this result. */
  readonly checkedAt: string;
  /** Bounded advisory context (HTTP status, usage figures). Never key material. */
  readonly detail?: string;
  readonly status: ProviderVerificationStatus;
}

/**
 * Provenance mirrors the OpenRouter metadata snapshot: `live` = this request
 * ran the probe; `fresh-cache` = served inside the 60s TTL. There is no
 * stale-cache arm — probe failures are themselves first-class results.
 */
export interface ProviderVerificationSnapshot {
  readonly freshness: 'live' | 'fresh-cache';
  readonly result: ProviderVerificationResult;
}

/** Renderer-side request lifecycle for a "Test connection" affordance. */
export type ProviderVerificationLookup =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly snapshot: ProviderVerificationSnapshot; readonly state: 'resolved' }
  | { readonly message: string; readonly state: 'error' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResult(value: unknown): ProviderVerificationResult {
  if (!isRecord(value)) {
    throw new Error('Provider verification result must be an object');
  }
  const status = value['status'];
  if (!PROVIDER_VERIFICATION_STATUSES.some((known) => known === status)) {
    throw new Error('Provider verification result has an unknown status');
  }
  const checkedAt = value['checkedAt'];
  if (!(typeof checkedAt === 'string' && Number.isFinite(Date.parse(checkedAt)))) {
    throw new Error('Provider verification result requires an ISO checkedAt timestamp');
  }
  const detail = value['detail'];
  if (
    detail !== undefined &&
    !(
      typeof detail === 'string' &&
      detail.trim().length > 0 &&
      detail.length <= MAX_PROVIDER_VERIFICATION_DETAIL_CHARS
    )
  ) {
    throw new Error('Provider verification detail must be a bounded non-blank string');
  }
  return {
    checkedAt,
    ...(detail === undefined ? {} : { detail }),
    status: status as ProviderVerificationStatus,
  };
}

export function parseProviderVerificationSnapshot(value: unknown): ProviderVerificationSnapshot {
  if (!isRecord(value)) {
    throw new Error('Provider verification snapshot must be an object');
  }
  const freshness = value['freshness'];
  if (!(freshness === 'live' || freshness === 'fresh-cache')) {
    throw new Error('Provider verification snapshot has an invalid freshness');
  }
  return { freshness, result: parseResult(value['result']) };
}
