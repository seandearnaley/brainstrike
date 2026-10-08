import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import type {
  OAuthProviderDescriptor,
  OAuthTokenGrant,
  ProviderCredential,
} from '@brainstrike/assistant-contract';
import { pollDeviceFlow, startDeviceFlow } from './device-flow.js';
import { ProviderAuthFlowCancelledError, ProviderAuthFlowError } from './errors.js';
import { guardedFetchText } from './fetch-guards.js';
import { type LoopbackServerHandle, startLoopbackServer } from './loopback-server.js';
import { computeS256Challenge, createPkceVerifier, createState } from './pkce.js';

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
    // Distinct code (security-review finding 7): the exchange SUCCEEDED but
    // no refresh token came back — almost always a missing offline-access
    // style scope in the descriptor, not a transient exchange failure.
    throw new ProviderAuthFlowError(
      'refresh_token_missing',
      `Token endpoint for ${providerId} returned no refresh_token. The requested scopes likely lack the provider's offline-access scope; a subscription session cannot be sustained without one.`
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
  /** Flow cancellation; a stalled exchange rejects promptly on abort. */
  readonly cancelSignal?: AbortSignal;
  readonly code: string;
  readonly codeVerifier: string;
  readonly descriptor: OAuthProviderDescriptor;
  readonly fetchFn: typeof fetch;
  readonly fetchTimeoutMs?: number;
  readonly redirectUri: string;
}

/** RFC 6749 §4.1.3 + RFC 7636 §4.5 token exchange. */
export async function exchangeAuthorizationCode(
  options: ExchangeAuthorizationCodeOptions
): Promise<OAuthTokenGrant> {
  const { code, codeVerifier, descriptor, fetchFn, redirectUri } = options;
  const { response, text } = await guardedFetchText({
    ...(options.cancelSignal ? { cancelSignal: options.cancelSignal } : {}),
    fetchFn,
    init: {
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
    },
    onTimeout: () =>
      new ProviderAuthFlowError(
        'token_exchange_failed',
        `Token exchange for ${descriptor.providerId} timed out.`
      ),
    ...(options.fetchTimeoutMs === undefined ? {} : { timeoutMs: options.fetchTimeoutMs }),
    url: descriptor.tokenUrl,
  });
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
  readonly fetchTimeoutMs?: number;
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

  // Cancellation can RACE the startup (PR #2529 review, finding 2). Binding
  // the socket is asynchronous, so the user may have cancelled while
  // `startServer` was still pending — and `addEventListener('abort', …)` on an
  // ALREADY-fired signal never invokes the handler. Without this check the
  // flow went on to open the browser and then sat on the callback wait, with
  // `engine.cancel()` blocked behind it until the 5-minute timeout.
  //
  // Checked AFTER the await rather than before it so the freshly bound socket
  // is torn down instead of leaked; the thrown error is the same one the
  // listener path produces, so the engine maps it to `disconnected` either way.
  if (deps.cancelSignal?.aborted) {
    await handle.close();
    throw new ProviderAuthFlowCancelledError();
  }

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
    try {
      await deps.openExternal(authorizeUrl);
    } catch (error) {
      throw new ProviderAuthFlowError(
        'browser_open_failed',
        `Could not open the system browser for ${descriptor.providerId} sign-in.`,
        error
      );
    }
    // Truthful status (security-review finding 8): only claim the browser is
    // open AFTER openExternal actually resolved.
    deps.onAwaitingBrowser?.();

    const { code } = await callbackPromise;
    const grant = await exchangeAuthorizationCode({
      ...(deps.cancelSignal ? { cancelSignal: deps.cancelSignal } : {}),
      code,
      codeVerifier,
      descriptor,
      fetchFn: deps.fetchFn,
      ...(deps.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: deps.fetchTimeoutMs }),
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
    ...(deps.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: deps.fetchTimeoutMs }),
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
          ...(deps.cancelSignal ? { cancelSignal: deps.cancelSignal } : {}),
          code: outcome.code,
          codeVerifier: outcome.codeVerifier,
          descriptor,
          fetchFn: deps.fetchFn,
          ...(deps.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: deps.fetchTimeoutMs }),
          redirectUri: outcome.redirectUri,
        });
  return await persistGrant(descriptor, grant, deps);
}
