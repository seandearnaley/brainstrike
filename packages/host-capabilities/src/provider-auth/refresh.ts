import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { OAuthProviderDescriptor, ProviderCredential } from '@brainstrike/assistant-contract';
import { getOAuthProviderDescriptor } from './descriptor-registry.js';
import { ProviderAuthFlowError } from './errors.js';
import { guardedFetchText } from './fetch-guards.js';
import { DEFAULT_TOKEN_EXPIRES_IN_SECONDS } from './oauth-flow.js';

/**
 * Access-token freshness for OAuth credentials (BST-1355, hardened per the
 * security review of PR #2520).
 *
 * - Refreshes proactively when `expires - OAUTH_REFRESH_SKEW_MS < now` so a
 *   long-running request never starts with a token about to die.
 * - Single-flight per provider: concurrent callers collapse onto ONE network
 *   call, so a rotating refresh_token is never replayed.
 * - A refresh rejected as `invalid_grant` (revoked/expired refresh token) is
 *   a typed `reconnect_required` result: the stored credential is KEPT (never
 *   deleted silently), the engine's status channel surfaces the state, and
 *   the user reconnects or disconnects explicitly. Every other failure throws
 *   a typed error once — the refresher NEVER retry-loops.
 * - Rotation-then-persist-failure (finding 3): once the provider accepted the
 *   refresh, the OLD refresh token is dead — losing the rotated pair to a
 *   failed store write would strand the session. The rotated credential is
 *   held IN MEMORY (process lifetime) as the active credential, the engine is
 *   told via `onPersistFailure` (surfaced as a `credential_persist_failed`
 *   status), and the next successful persist clears the overlay
 *   (`onPersistRecovered`). After an app restart the stale STORED refresh
 *   token will be rejected by the provider and the user lands in the normal
 *   `reconnect_required` path — never a silent loss.
 * - Epoch guard (finding 5): `getEpoch` snapshots a per-provider generation
 *   at refresh start; disconnect bumps it, so a refresh completing under a
 *   stale epoch DISCARDS its result and persists nothing.
 */

export const OAUTH_REFRESH_SKEW_MS = 120_000;

export type FreshAccessTokenResult =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly status: 'not_connected' | 'reconnect_required' };

export interface TokenRefresherDeps {
  readonly fetchFn: typeof fetch;
  /** Per-request timeout (finding 4); defaults to DEFAULT_FETCH_TIMEOUT_MS. */
  readonly fetchTimeoutMs?: number;
  /** Descriptor lookup; defaults to the engine registry. */
  readonly getDescriptor?: (providerId: string) => OAuthProviderDescriptor;
  /** Per-provider generation counter; a refresh whose captured epoch is stale
   * by completion time discards its result (disconnect race, finding 5). */
  readonly getEpoch?: (providerId: string) => number;
  readonly now?: () => number;
  /** Invoked when a rotated pair could not be persisted and is now held in
   * memory (the engine surfaces `credential_persist_failed`). */
  readonly onPersistFailure?: (providerId: string) => void;
  /** Invoked when a later persist succeeded and cleared the memory overlay. */
  readonly onPersistRecovered?: (providerId: string) => void;
  /** Invoked exactly when a refresh flips a provider to reconnect_required
   * (the engine mirrors it onto the status channel). */
  readonly onReconnectRequired?: (providerId: string) => void;
  readonly secrets: SecretsService;
}

export interface TokenRefresher {
  readonly getFreshAccessToken: (providerId: string) => Promise<FreshAccessTokenResult>;
  /** Drop any in-memory rotated pair for the provider (disconnect path). */
  readonly invalidate: (providerId: string) => void;
}

type OAuthCredential = Extract<ProviderCredential, { type: 'oauth' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 6749 §5.2 codes that mean the refresh token itself is dead. */
const RECONNECT_REQUIRED_ERRORS = new Set(['invalid_grant', 'revoked', 'revoked_token']);

export function createTokenRefresher(deps: TokenRefresherDeps): TokenRefresher {
  const getDescriptor = deps.getDescriptor ?? getOAuthProviderDescriptor;
  const getEpoch = deps.getEpoch ?? (() => 0);
  const now = deps.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<FreshAccessTokenResult>>();
  /** Rotated pairs whose store write failed; the ACTIVE credential until a
   * later persist succeeds or the provider is disconnected. */
  const memoryOverlay = new Map<string, OAuthCredential>();

  async function readActiveCredential(providerId: string): Promise<ProviderCredential | null> {
    const overlaid = memoryOverlay.get(providerId);
    if (overlaid) {
      return overlaid;
    }
    return await deps.secrets.getCredential(providerId);
  }

  function buildRefreshedCredential(
    providerId: string,
    record: Record<string, unknown>,
    credential: OAuthCredential
  ): OAuthCredential {
    const accessToken = record['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new ProviderAuthFlowError(
        'token_exchange_failed',
        `Token refresh for ${providerId} returned no access_token.`
      );
    }
    const rotatedRefresh = record['refresh_token'];
    const expiresIn = Number(record['expires_in']);
    return {
      access: accessToken,
      expires:
        now() +
        (Number.isFinite(expiresIn) && expiresIn > 0
          ? expiresIn
          : DEFAULT_TOKEN_EXPIRES_IN_SECONDS) *
          1000,
      // RFC 6749 §6: refresh-token rotation is optional; when the server
      // omits one, the previous refresh token remains valid by definition.
      refresh:
        typeof rotatedRefresh === 'string' && rotatedRefresh.length > 0
          ? rotatedRefresh
          : credential.refresh,
      type: 'oauth',
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    };
  }

  async function persistOrOverlay(providerId: string, next: OAuthCredential): Promise<void> {
    let persisted = false;
    try {
      persisted = await deps.secrets.setCredential(providerId, next);
    } catch {
      persisted = false;
    }
    if (!persisted) {
      // Keep the session alive on the rotated pair; the store keeps its old
      // (now provider-rejected) value untouched. Visible via onPersistFailure
      // — never silent.
      memoryOverlay.set(providerId, next);
      deps.onPersistFailure?.(providerId);
      return;
    }
    if (memoryOverlay.delete(providerId)) {
      deps.onPersistRecovered?.(providerId);
    }
  }

  async function refresh(
    providerId: string,
    credential: OAuthCredential
  ): Promise<FreshAccessTokenResult> {
    const descriptor = getDescriptor(providerId);
    const epochAtStart = getEpoch(providerId);
    const { response, text } = await guardedFetchText({
      fetchFn: deps.fetchFn,
      init: {
        // biome-ignore-start lint/style/useNamingConvention: RFC 6749 wire fields + standard HTTP header names.
        body: new URLSearchParams({
          client_id: descriptor.clientId,
          grant_type: 'refresh_token',
          refresh_token: credential.refresh,
        }).toString(),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        // biome-ignore-end lint/style/useNamingConvention: RFC 6749 wire fields + standard HTTP header names.
        method: 'POST',
      },
      onTimeout: () =>
        new ProviderAuthFlowError(
          'token_exchange_failed',
          `Token refresh for ${providerId} timed out.`
        ),
      ...(deps.fetchTimeoutMs === undefined ? {} : { timeoutMs: deps.fetchTimeoutMs }),
      url: descriptor.tokenUrl,
    });
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }

    if (getEpoch(providerId) !== epochAtStart) {
      // Disconnected while the refresh was in flight (finding 5): the user
      // severed this provider; discard the result and persist NOTHING.
      return { ok: false, status: 'not_connected' };
    }

    if (!response.ok) {
      const errorCode = isRecord(body) ? body['error'] : undefined;
      if (typeof errorCode === 'string' && RECONNECT_REQUIRED_ERRORS.has(errorCode)) {
        // The refresh token is dead. Keep the stored credential (never delete
        // silently) and surface the typed status; the user decides.
        deps.onReconnectRequired?.(providerId);
        return { ok: false, status: 'reconnect_required' };
      }
      throw new ProviderAuthFlowError(
        'token_exchange_failed',
        `Token refresh for ${providerId} failed with status ${response.status}.`
      );
    }

    const next = buildRefreshedCredential(providerId, isRecord(body) ? body : {}, credential);
    await persistOrOverlay(providerId, next);
    return { accessToken: next.access, ok: true };
  }

  return {
    async getFreshAccessToken(providerId: string): Promise<FreshAccessTokenResult> {
      const existing = inFlight.get(providerId);
      if (existing) {
        return await existing;
      }
      const credential = await readActiveCredential(providerId);
      // Re-check after the await: a concurrent caller may have started a
      // refresh while this one was reading the credential. Microtask
      // continuations run to their next await synchronously, so the winner's
      // map write below is always visible to the loser here — without this,
      // two concurrent callers would BOTH refresh and replay the rotating
      // refresh token.
      const raced = inFlight.get(providerId);
      if (raced) {
        return await raced;
      }
      if (credential === null || credential.type !== 'oauth') {
        return { ok: false, status: 'not_connected' };
      }
      if (credential.expires - OAUTH_REFRESH_SKEW_MS > now()) {
        return { accessToken: credential.access, ok: true };
      }
      const pending = refresh(providerId, credential).finally(() => {
        inFlight.delete(providerId);
      });
      inFlight.set(providerId, pending);
      return await pending;
    },
    invalidate(providerId: string): void {
      memoryOverlay.delete(providerId);
    },
  };
}
