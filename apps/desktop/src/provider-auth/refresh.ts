import type { OAuthProviderDescriptor, ProviderCredential } from '@brainstrike/assistant-contract';
import type { SecretsService } from '../secrets';
import { getOAuthProviderDescriptor } from './descriptor-registry';
import { ProviderAuthFlowError } from './errors';

/**
 * Access-token freshness for OAuth credentials (BST-1355).
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
 */

export const OAUTH_REFRESH_SKEW_MS = 120_000;

export type FreshAccessTokenResult =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly status: 'not_connected' | 'reconnect_required' };

export interface TokenRefresherDeps {
  readonly fetchFn: typeof fetch;
  /** Descriptor lookup; defaults to the engine registry. */
  readonly getDescriptor?: (providerId: string) => OAuthProviderDescriptor;
  readonly now?: () => number;
  /** Invoked exactly when a refresh flips a provider to reconnect_required
   * (the engine mirrors it onto the status channel). */
  readonly onReconnectRequired?: (providerId: string) => void;
  readonly secrets: SecretsService;
}

export interface TokenRefresher {
  readonly getFreshAccessToken: (providerId: string) => Promise<FreshAccessTokenResult>;
}

type OAuthCredential = Extract<ProviderCredential, { type: 'oauth' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 6749 §5.2 codes that mean the refresh token itself is dead. */
const RECONNECT_REQUIRED_ERRORS = new Set(['invalid_grant', 'revoked', 'revoked_token']);

export function createTokenRefresher(deps: TokenRefresherDeps): TokenRefresher {
  const getDescriptor = deps.getDescriptor ?? getOAuthProviderDescriptor;
  const now = deps.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<FreshAccessTokenResult>>();

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
      expires: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
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

  async function refresh(
    providerId: string,
    credential: OAuthCredential
  ): Promise<FreshAccessTokenResult> {
    const descriptor = getDescriptor(providerId);
    const response = await deps.fetchFn(descriptor.tokenUrl, {
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
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
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
    const persisted = await deps.secrets.setCredential(providerId, next);
    if (!persisted) {
      throw new ProviderAuthFlowError(
        'credential_persist_failed',
        `Failed to persist the refreshed OAuth credential for ${providerId}.`
      );
    }
    return { accessToken: next.access, ok: true };
  }

  return {
    async getFreshAccessToken(providerId: string): Promise<FreshAccessTokenResult> {
      const existing = inFlight.get(providerId);
      if (existing) {
        return await existing;
      }
      const credential = await deps.secrets.getCredential(providerId);
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
  };
}
