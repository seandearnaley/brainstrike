import type {
  OAuthProviderDescriptor,
  OAuthTokenGrant,
  ProviderCredential,
} from '@brainstrike/assistant-contract';
import type { SecretsService } from '../secrets';
import { pollDeviceFlow, startDeviceFlow } from './device-flow';
import { ProviderAuthFlowError } from './errors';
import { type LoopbackServerHandle, startLoopbackServer } from './loopback-server';
import { computeS256Challenge, createPkceVerifier, createState } from './pkce';

/**
 * OAuth flow orchestration (BST-1355): authorize URL -> external browser ->
 * loopback callback (or device poll) -> token exchange -> typed credential in
 * the safeStorage-backed secrets store. The browser is ALWAYS the user's own
 * (via the injected `openExternal`, wired to the app's validated
 * shell.openExternal path) — never an embedded webview (legal gate BST-1351).
 */

/** Applied when a provider omits `expires_in` (RFC 6749 makes it optional). */
export const DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 3600;

export interface AuthorizeUrlInputs {
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly state: string;
}

export function buildAuthorizeUrl(
  descriptor: OAuthProviderDescriptor,
  inputs: AuthorizeUrlInputs
): string {
  const url = new URL(descriptor.authorizeUrl);
  // biome-ignore-start lint/style/useNamingConvention: RFC 6749/7636 wire fields.
  const params = new URLSearchParams({
    client_id: descriptor.clientId,
    code_challenge: inputs.codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: inputs.redirectUri,
    response_type: 'code',
    scope: descriptor.scopes.join(' '),
    state: inputs.state,
    ...descriptor.extraAuthorizeParams,
  });
  // biome-ignore-end lint/style/useNamingConvention: RFC 6749/7636 wire fields.
  url.search = params.toString();
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGrantOrThrow(providerId: string, status: number, body: unknown): OAuthTokenGrant {
  if (!isRecord(body)) {
    throw new ProviderAuthFlowError(
      'token_exchange_failed',
      `Token endpoint for ${providerId} returned a non-object body (status ${status}).`
    );
  }
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ProviderAuthFlowError(
      'token_exchange_failed',
      `Token endpoint for ${providerId} returned no access_token (status ${status}).`
    );
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new ProviderAuthFlowError(
      'token_exchange_failed',
      `Token endpoint for ${providerId} returned no refresh_token; a subscription session cannot be sustained without one.`
    );
  }
  const expiresIn = Number(body['expires_in']);
  return {
    accessToken,
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresInSeconds: expiresIn } : {}),
    raw: body,
    refreshToken,
  };
}

export interface ExchangeAuthorizationCodeOptions {
  readonly code: string;
  readonly codeVerifier: string;
  readonly descriptor: OAuthProviderDescriptor;
  readonly fetchFn: typeof fetch;
  readonly redirectUri: string;
}

/** RFC 6749 §4.1.3 + RFC 7636 §4.5 token exchange. */
export async function exchangeAuthorizationCode(
  options: ExchangeAuthorizationCodeOptions
): Promise<OAuthTokenGrant> {
  const { code, codeVerifier, descriptor, fetchFn, redirectUri } = options;
  const response = await fetchFn(descriptor.tokenUrl, {
    // biome-ignore-start lint/style/useNamingConvention: RFC 6749/7636 wire fields + standard HTTP header names.
    body: new URLSearchParams({
      client_id: descriptor.clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    // biome-ignore-end lint/style/useNamingConvention: RFC 6749/7636 wire fields + standard HTTP header names.
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
    throw new ProviderAuthFlowError(
      'token_exchange_failed',
      `Token exchange for ${descriptor.providerId} failed with status ${response.status}.`
    );
  }
  return parseGrantOrThrow(descriptor.providerId, response.status, body);
}

/** Project a grant onto the stored `{ type: 'oauth', ... }` credential. */
export function toStoredOAuthCredential(
  grant: OAuthTokenGrant,
  options: { readonly accountId?: string; readonly now: number }
): Extract<ProviderCredential, { type: 'oauth' }> {
  const lifetimeSeconds = grant.expiresInSeconds ?? DEFAULT_TOKEN_EXPIRES_IN_SECONDS;
  return {
    access: grant.accessToken,
    expires: options.now + lifetimeSeconds * 1000,
    refresh: grant.refreshToken,
    type: 'oauth',
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
  };
}

export interface OAuthFlowDeps {
  readonly cancelSignal?: AbortSignal;
  readonly fetchFn: typeof fetch;
  readonly loopbackTimeoutMs?: number;
  readonly now?: () => number;
  /** Called as the flow transitions; the engine forwards these to status. */
  readonly onAwaitingBrowser?: () => void;
  readonly onAwaitingDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  /** Wired to the app's validated shell.openExternal path; MUST throw on
   * failure so the flow fails visibly instead of waiting forever. */
  readonly openExternal: (url: string) => Promise<void>;
  readonly secrets: SecretsService;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam; defaults to the real loopback server. */
  readonly startLoopbackServerFn?: typeof startLoopbackServer;
}

export interface CompletedOAuthFlow {
  readonly accountId?: string;
}

async function persistGrant(
  descriptor: OAuthProviderDescriptor,
  grant: OAuthTokenGrant,
  deps: Pick<OAuthFlowDeps, 'now' | 'secrets'>
): Promise<CompletedOAuthFlow> {
  const accountId = descriptor.extractAccountId?.(grant);
  const credential = toStoredOAuthCredential(grant, {
    now: (deps.now ?? (() => Date.now()))(),
    ...(accountId === undefined ? {} : { accountId }),
  });
  let persisted: boolean;
  try {
    persisted = await deps.secrets.setCredential(descriptor.providerId, credential);
  } catch (error) {
    throw new ProviderAuthFlowError(
      'credential_persist_failed',
      `Failed to persist the OAuth credential for ${descriptor.providerId}.`,
      error
    );
  }
  if (!persisted) {
    throw new ProviderAuthFlowError(
      'credential_persist_failed',
      `The secrets store rejected the OAuth credential for ${descriptor.providerId}.`
    );
  }
  return accountId === undefined ? {} : { accountId };
}

/**
 * PKCE + loopback flow: fixed-port 127.0.0.1 callback server, system browser,
 * state-checked callback, token exchange, persist.
 */
export async function runLoopbackOAuthFlow(
  descriptor: OAuthProviderDescriptor,
  deps: OAuthFlowDeps
): Promise<CompletedOAuthFlow> {
  const startServer = deps.startLoopbackServerFn ?? startLoopbackServer;
  const codeVerifier = createPkceVerifier();
  const state = createState();

  const handle: LoopbackServerHandle = await startServer({
    callbackPath: descriptor.redirectPath,
    expectedState: state,
    port: descriptor.redirectPort,
    providerLabel: descriptor.providerId,
    ...(deps.loopbackTimeoutMs === undefined ? {} : { timeoutMs: deps.loopbackTimeoutMs }),
  });

  const onAbort = () => {
    handle.cancel();
  };
  deps.cancelSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const callbackPromise = handle.waitForCallback();
    // Swallow nothing: this pre-attachment only prevents an unhandled
    // rejection while openExternal below is still in flight; the same promise
    // is awaited (and its rejection surfaced) right after.
    callbackPromise.catch(() => undefined);

    const authorizeUrl = buildAuthorizeUrl(descriptor, {
      codeChallenge: computeS256Challenge(codeVerifier),
      redirectUri: handle.redirectUri,
      state,
    });
    deps.onAwaitingBrowser?.();
    try {
      await deps.openExternal(authorizeUrl);
    } catch (error) {
      throw new ProviderAuthFlowError(
        'browser_open_failed',
        `Could not open the system browser for ${descriptor.providerId} sign-in.`,
        error
      );
    }

    const { code } = await callbackPromise;
    const grant = await exchangeAuthorizationCode({
      code,
      codeVerifier,
      descriptor,
      fetchFn: deps.fetchFn,
      redirectUri: handle.redirectUri,
    });
    return await persistGrant(descriptor, grant, deps);
  } finally {
    deps.cancelSignal?.removeEventListener('abort', onAbort);
    await handle.close();
  }
}

/**
 * Device-authorization flow: adapter-shaped start + poll, then either a
 * direct grant or a follow-up standard token exchange (Codex shape), then
 * persist.
 */
export async function runDeviceOAuthFlow(
  descriptor: OAuthProviderDescriptor,
  deps: OAuthFlowDeps
): Promise<CompletedOAuthFlow> {
  const flowDeps = {
    fetchFn: deps.fetchFn,
    ...(deps.cancelSignal ? { cancelSignal: deps.cancelSignal } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  const start = await startDeviceFlow(descriptor, flowDeps);
  deps.onAwaitingDeviceCode?.({
    userCode: start.userCode,
    verificationUri: start.verificationUri,
  });
  const outcome = await pollDeviceFlow(descriptor, start, flowDeps);
  const grant =
    outcome.kind === 'tokens'
      ? outcome.tokens
      : await exchangeAuthorizationCode({
          code: outcome.code,
          codeVerifier: outcome.codeVerifier,
          descriptor,
          fetchFn: deps.fetchFn,
          redirectUri: outcome.redirectUri,
        });
  return await persistGrant(descriptor, grant, deps);
}
