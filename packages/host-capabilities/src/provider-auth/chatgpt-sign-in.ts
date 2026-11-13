/**
 * Sign in with ChatGPT for an open-source app (ADR-0038), as OpenAI documents it:
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * The user registers this installation as their own OAuth client in the
 * browser and lets it spend their ChatGPT plan. The host holds the tokens, in
 * the profile's credential store, and is their only reader and writer: a
 * client sees a status and an email, never a token.
 *
 * OpenID Connect itself (discovery, PKCE, the code exchange, ID-token
 * validation, refresh, revocation) is `openid-client`. What is written here is
 * what OpenAI adds to it: the registration entry client, the host ID, the
 * plan scope and the retained registration.
 */
import { randomUUID } from 'node:crypto';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import {
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_PLAN_SCOPE,
  type ChatGptSignInCredential,
  type ChatGptSignInStatus,
  isSignedInChatGptCredential,
  refusalError,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import * as oidc from 'openid-client';
import { startLoopbackCallback } from '../mcp/oauth-loopback-callback.ts';

const logger = createLogger('ChatGptSignIn');

export const CHATGPT_PROVIDER_ID = 'chatgpt';
const OPENAI_ISSUER = 'https://auth.openai.com';
/** The client a first sign-in names; OpenAI answers with the client it registered. */
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME = 'Brainstrike';
/** OpenAI matches the path exactly; only the port may differ between sign-ins. */
const CALLBACK_PATH = '/auth/callback';
const SCOPE = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;
const ISSUED_CLIENT_ID = /^[\w-]{1,200}$/u;
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/u;
/** A token this close to expiry is renewed before a request is sent with it. */
const RENEW_WITHIN_MS = 5 * 60 * 1000;
/** OpenAI's codes for a refresh token that will never work again. */
const DEAD_REFRESH_TOKEN_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'token_expired',
]);

export interface ChatGptSignInOptions {
  /** Fixture seam: a local issuer. Production signs in at OpenAI. */
  readonly issuer?: string;
  readonly now?: () => number;
  /** Opens the system browser; absent on a host with no interactive client. */
  readonly openExternal?: (url: string) => Promise<void>;
  /** The profile store, resolved per call. */
  readonly secrets: () => Pick<SecretsService, 'getCredential' | 'setCredential'>;
}

export interface ChatGptSignIn {
  /** A token valid for the next request, renewed first when it is about to expire. */
  accessToken(): Promise<string>;
  /** Ends a sign-in that is waiting for the browser; settles once that sign-in has ended. */
  cancel(): Promise<void>;
  /**
   * Signs in through the browser. `newAccount` registers again, for another
   * ChatGPT account or workspace: OpenAI binds a registered client to both.
   * `signal` ends the sign-in as Cancel does, when its caller goes away.
   */
  signIn(newAccount: boolean, signal?: AbortSignal): Promise<ChatGptSignInStatus>;
  /** Ends the session at OpenAI and forgets its tokens; the registration stays for the next sign-in. */
  signOut(): Promise<{ readonly revoked: boolean }>;
  /** `settled` answers once no sign-in is waiting for the browser. */
  status(settled?: boolean): Promise<ChatGptSignInStatus>;
}

function signedOut(code: string, message: string, remedy: string): Error {
  return refusalError('authorization', `auth.${code}`, message, remedy);
}

const cancelled = (): Error =>
  refusalError('conflict', 'auth.chatgpt-sign-in-cancelled', 'Sign-in was cancelled.');

const notSignedIn = (): Error =>
  signedOut(
    'chatgpt-signed-out',
    'ChatGPT is not signed in.',
    'Choose Continue with ChatGPT in Settings → Providers.'
  );

/** The OAuth error code of a token-endpoint or authorization refusal. */
function oauthErrorCode(cause: unknown): string | undefined {
  return cause instanceof oidc.ResponseBodyError || cause instanceof oidc.AuthorizationResponseError
    ? cause.error
    : undefined;
}

/** One sign-in, from the browser opening to its session being kept. */
interface ActiveSignIn {
  cancel(): void;
  cancelled: boolean;
  /** Settles once the sign-in has succeeded, been refused or been cancelled. */
  readonly ended: Promise<void>;
  /** Aborts with the sign-in: its requests to OpenAI stop where they are. */
  readonly stopped: AbortSignal;
}

/** The secrets of one authorization attempt, never reused by another. */
interface SignInAttempt {
  readonly nonce: string;
  readonly state: string;
  readonly verifier: string;
}

export function createChatGptSignIn(options: ChatGptSignInOptions): ChatGptSignIn {
  const issuer = new URL(options.issuer ?? OPENAI_ISSUER);
  const now = options.now ?? Date.now;
  // Only a fixture issuer is ever plain HTTP.
  const execute = issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [];
  let metadata: Promise<oidc.ServerMetadata> | undefined;
  let active: ActiveSignIn | undefined;
  let renewal: Promise<string> | undefined;
  // Every read-then-write of the record runs alone, in arrival order.
  let turn: Promise<unknown> = Promise.resolve();
  const alone = <T>(work: () => Promise<T>): Promise<T> => {
    const result = turn.then(work, work);
    turn = result.catch(() => undefined);
    return result;
  };

  const read = async (): Promise<ChatGptSignInCredential | undefined> => {
    const stored = await options.secrets().getCredential(CHATGPT_PROVIDER_ID);
    return stored?.type === 'chatgpt_sign_in' ? stored : undefined;
  };
  const write = async (record: ChatGptSignInCredential): Promise<void> => {
    await options.secrets().setCredential(CHATGPT_PROVIDER_ID, record);
  };
  const client = async (clientId: string, stopped?: AbortSignal): Promise<oidc.Configuration> => {
    metadata ??= oidc
      .discovery(issuer, REGISTRATION_CLIENT_ID, undefined, oidc.None(), { execute })
      .then((discovered) => discovered.serverMetadata());
    let server: oidc.ServerMetadata;
    try {
      server = await metadata;
    } catch (cause) {
      metadata = undefined;
      throw cause;
    }
    const configuration = new oidc.Configuration(server, clientId, undefined, oidc.None());
    for (const apply of execute) {
      apply(configuration);
    }
    if (stopped) {
      // A cancelled sign-in stops its request in flight instead of finishing it.
      configuration[oidc.customFetch] = (url, { body, signal, ...init }) =>
        fetch(url, {
          ...init,
          // The library's body type admits a shared-buffer view the DOM's `BodyInit` omits.
          ...(body === undefined ? {} : { body: body as BodyInit | null }),
          signal: signal ? AbortSignal.any([signal, stopped]) : stopped,
        });
    }
    return configuration;
  };

  /** The session a token response grants, or a refusal when it grants no plan use. */
  const sessionFrom = (
    tokens: oidc.TokenEndpointResponse,
    previous?: NonNullable<ChatGptSignInCredential['session']>
  ): NonNullable<ChatGptSignInCredential['session']> => {
    // A refresh may leave out an unchanged scope and, never, its replacement token.
    const scopes = tokens.scope?.split(' ').filter(Boolean) ?? previous?.scopes ?? [];
    if (!scopes.includes(CHATGPT_PLAN_SCOPE)) {
      throw signedOut(
        'chatgpt-plan-not-granted',
        'ChatGPT signed in without permission to use your plan here.',
        'Sign in again and allow plan usage, or add an OpenAI API key instead.'
      );
    }
    if (!(tokens.refresh_token && tokens.expires_in && tokens.expires_in > 0)) {
      throw new Error('The ChatGPT token response carried no renewable session');
    }
    return {
      accessToken: tokens.access_token,
      expiresAt: now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token,
      scopes,
    };
  };

  const renew = (): Promise<string> =>
    alone(async () => {
      const record = await read();
      if (!(record && isSignedInChatGptCredential(record))) {
        throw notSignedIn();
      }
      // A renewal that finished while this one waited its turn already replaced the token.
      if (record.session.expiresAt - now() > RENEW_WITHIN_MS) {
        return record.session.accessToken;
      }
      let tokens: oidc.TokenEndpointResponse;
      try {
        tokens = await oidc.refreshTokenGrant(
          await client(record.clientId),
          record.session.refreshToken,
          { resource: CHATGPT_PLAN_RESOURCE }
        );
      } catch (cause) {
        const code = oauthErrorCode(cause);
        if (code === undefined || !DEAD_REFRESH_TOKEN_CODES.has(code)) {
          // A network or server failure proves nothing about the session: it stays.
          throw cause;
        }
        const { session: _ended, ...registration } = record;
        await write(registration);
        throw signedOut(
          'chatgpt-session-ended',
          'Your ChatGPT sign-in has ended.',
          'Choose Continue with ChatGPT in Settings → Providers to sign in again.'
        );
      }
      const session = sessionFrom(tokens, record.session);
      await write({ ...record, session });
      return session.accessToken;
    });

  /** The page the person signs in at: a first registration, or the registered client's. */
  const authorizationUrl = async (
    record: ChatGptSignInCredential,
    attempt: SignInAttempt,
    redirectUrl: string
  ): Promise<URL> => {
    const parameters = new URLSearchParams([
      ['code_challenge', await oidc.calculatePKCECodeChallenge(attempt.verifier)],
      ['code_challenge_method', 'S256'],
      ['ext_agent_host_id', record.hostId],
      ['nonce', attempt.nonce],
      ['redirect_uri', redirectUrl],
      ['resource', CHATGPT_PLAN_RESOURCE],
      ['scope', SCOPE],
      ['state', attempt.state],
    ]);
    // A first sign-in names the app; a later one names the account it expects.
    if (record.clientId === undefined) {
      parameters.set('agent_name_hint', AGENT_NAME);
    } else if (record.email !== undefined) {
      parameters.set('login_hint', record.email);
    }
    const url = oidc.buildAuthorizationUrl(
      await client(record.clientId ?? REGISTRATION_CLIENT_ID),
      parameters
    );
    if (url.origin !== issuer.origin) {
      // The page the person signs in on is the issuer's own, whatever its metadata says.
      throw new Error('The ChatGPT sign-in page is not on the issuer origin');
    }
    return url;
  };

  /** The browser's redirect, or the refusal that says why none came. */
  const redirected = async (
    redirect: Promise<URLSearchParams>,
    flow: ActiveSignIn
  ): Promise<URLSearchParams> => {
    try {
      return await redirect;
    } catch (cause) {
      if (flow.cancelled) {
        throw cancelled();
      }
      logger.warn('ChatGPT sign-in received no browser callback', { cause });
      throw refusalError(
        'timeout',
        'auth.chatgpt-sign-in-timeout',
        'ChatGPT did not return to Brainstrike.',
        'Choose Continue with ChatGPT to try again.'
      );
    }
  };

  /**
   * The client the code is exchanged as: the registered one, or the one a
   * first sign-in's redirect names. A redirect that carries an OAuth error
   * names none, and the exchange reports that error.
   */
  const issuedClientId = (
    record: ChatGptSignInCredential,
    returned: URLSearchParams
  ): string | undefined => {
    const named = returned.get('client_id') ?? undefined;
    const clientId = record.clientId ?? named;
    if (returned.has('error')) {
      return clientId;
    }
    if (
      clientId === undefined ||
      clientId === REGISTRATION_CLIENT_ID ||
      !ISSUED_CLIENT_ID.test(clientId) ||
      (named !== undefined && named !== clientId)
    ) {
      throw refusalError(
        'availability',
        'auth.chatgpt-registration-incomplete',
        'ChatGPT did not finish registering Brainstrike.',
        'Choose Continue with ChatGPT to try again.'
      );
    }
    return clientId;
  };

  /** The validated tokens of the redirect's one-time code. */
  const exchange = async (
    clientId: string | undefined,
    redirect: URL,
    attempt: SignInAttempt,
    stopped: AbortSignal
  ): Promise<Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>> => {
    try {
      return await oidc.authorizationCodeGrant(
        await client(clientId ?? REGISTRATION_CLIENT_ID, stopped),
        redirect,
        {
          expectedNonce: attempt.nonce,
          expectedState: attempt.state,
          idTokenExpected: true,
          pkceCodeVerifier: attempt.verifier,
        },
        { resource: CHATGPT_PLAN_RESOURCE }
      );
    } catch (cause) {
      const code = oauthErrorCode(cause);
      if (code === 'access_denied') {
        throw signedOut(
          'chatgpt-access-denied',
          'ChatGPT sign-in was declined.',
          'Choose Continue with ChatGPT and allow access to sign in.'
        );
      }
      if (code === undefined) {
        throw cause;
      }
      // OpenAI answered with an OAuth error: the code is its own, the remedy a fresh attempt.
      logger.warn('ChatGPT refused the sign-in', { cause });
      throw signedOut(
        'chatgpt-sign-in-refused',
        `ChatGPT refused the sign-in${OAUTH_ERROR_CODE.test(code) ? ` (${code})` : ''}.`,
        'Choose Continue with ChatGPT to try again.'
      );
    }
  };

  const authorize = async (
    record: ChatGptSignInCredential,
    openExternal: (url: string) => Promise<void>,
    flow: ActiveSignIn
  ): Promise<ChatGptSignInStatus> => {
    const callback = await startLoopbackCallback(CALLBACK_PATH, undefined);
    const cancelFlow = flow.cancel;
    flow.cancel = () => {
      cancelFlow();
      callback.cancel();
    };
    // Cancel ends the sign-in wherever it is: nothing below is kept once it is cancelled.
    const stillWanted = (): void => {
      if (flow.cancelled) {
        throw cancelled();
      }
    };
    try {
      stillWanted();
      const attempt: SignInAttempt = {
        nonce: oidc.randomNonce(),
        state: oidc.randomState(),
        verifier: oidc.randomPKCECodeVerifier(),
      };
      await callback.arm(attempt.state);
      const authorization = await authorizationUrl(record, attempt, callback.redirectUrl);
      // Listening before the browser opens: the redirect may arrive at once.
      const redirect = callback.wait();
      redirect.catch(() => undefined);
      stillWanted();
      await openExternal(authorization.href);
      const returned = await redirected(redirect, flow);
      stillWanted();
      const clientId = issuedClientId(record, returned);
      const registered: ChatGptSignInCredential =
        clientId === undefined ? record : { ...record, clientId };
      if (record.clientId === undefined && clientId !== undefined) {
        // Kept before the one-time code is spent, so a failed exchange never registers twice.
        await alone(() => write(registered));
      }
      const tokens = await exchange(
        clientId,
        new URL(`${callback.redirectUrl}?${returned.toString()}`),
        attempt,
        flow.stopped
      );
      stillWanted();
      const claims = tokens.claims();
      if (!claims) {
        throw new Error('ChatGPT sign-in returned no ID token');
      }
      if (record.subject !== undefined && record.subject !== claims.sub) {
        throw signedOut(
          'chatgpt-account-mismatch',
          'That is a different ChatGPT account from the one registered here.',
          'Sign in with the original account, or choose Use a different account.'
        );
      }
      const email = typeof claims['email'] === 'string' ? { email: claims['email'] } : {};
      const session = sessionFrom(tokens);
      await alone(() => write({ ...registered, ...email, session, subject: claims.sub }));
      return {
        state: 'signed_in',
        ...email,
        // This sign-in registered the account: the client confirms plan use once.
        ...(record.clientId === undefined ? { firstSignIn: true } : {}),
      };
    } catch (cause) {
      // A request the cancel stopped fails as an abort: the person sees the cancel.
      throw flow.cancelled ? cancelled() : cause;
    } finally {
      await callback.close();
    }
  };

  /** Ends the session at OpenAI and forgets its tokens; the registration stays. */
  const endSession = (stopped?: AbortSignal): Promise<{ readonly revoked: boolean }> =>
    alone(async () => {
      const record = await read();
      if (!record?.session) {
        return { revoked: true };
      }
      let revoked = false;
      try {
        if (record.clientId === undefined) {
          throw new Error('The ChatGPT session has no registered client');
        }
        await oidc.tokenRevocation(
          await client(record.clientId, stopped),
          record.session.refreshToken,
          new URLSearchParams([['token_type_hint', 'refresh_token']])
        );
        revoked = true;
      } catch (cause) {
        // The tokens are forgotten either way; the caller tells the user it was not confirmed.
        logger.warn('ChatGPT did not confirm the session revocation', { cause });
      }
      const { session: _ended, ...registration } = record;
      await write(registration);
      return { revoked };
    });

  return {
    accessToken: async () => {
      const record = await read();
      if (!(record && isSignedInChatGptCredential(record))) {
        throw notSignedIn();
      }
      if (record.session.expiresAt - now() > RENEW_WITHIN_MS) {
        return record.session.accessToken;
      }
      // One renewal serves every request that finds the token expiring.
      renewal ??= renew().finally(() => {
        renewal = undefined;
      });
      return await renewal;
    },
    cancel: async () => {
      active?.cancel();
      await active?.ended;
    },
    signIn: async (newAccount, signal) => {
      const { openExternal } = options;
      if (!openExternal) {
        throw refusalError(
          'availability',
          'auth.chatgpt-sign-in-unavailable',
          'This host cannot open a browser to sign in.',
          'Sign in from the Brainstrike desktop app.'
        );
      }
      if (active) {
        throw refusalError(
          'conflict',
          'auth.chatgpt-sign-in-active',
          'A ChatGPT sign-in is already waiting in your browser.',
          'Finish it there, or cancel it and start again.'
        );
      }
      const ended = Promise.withResolvers<void>();
      const stop = new AbortController();
      const flow: ActiveSignIn = {
        cancel: (): void => {
          flow.cancelled = true;
          stop.abort();
        },
        cancelled: false,
        ended: ended.promise,
        stopped: stop.signal,
      };
      active = flow;
      // The caller going away (the app quitting, a reset) cancels as the person would.
      const callerLeft = (): void => flow.cancel();
      signal?.addEventListener('abort', callerLeft, { once: true });
      try {
        if (signal?.aborted) {
          flow.cancel();
        }
        if (newAccount) {
          // Another account replaces this registration: its session ends first.
          await endSession(flow.stopped);
        }
        // OpenAI needs the same host ID on every attempt, so it is kept before the first.
        const record = await alone(async () => {
          const existing = await read();
          if (existing && !(newAccount && existing.clientId !== undefined)) {
            return existing;
          }
          const created: ChatGptSignInCredential = {
            hostId: existing?.hostId ?? `urn:uuid:${randomUUID()}`,
            type: 'chatgpt_sign_in',
          };
          await write(created);
          return created;
        });
        return await authorize(record, openExternal, flow);
      } finally {
        signal?.removeEventListener('abort', callerLeft);
        active = undefined;
        ended.resolve();
      }
    },
    signOut: async () => {
      active?.cancel();
      await active?.ended;
      return await endSession();
    },
    status: async (settled = false) => {
      if (settled) {
        await active?.ended;
      }
      if (active) {
        return { state: 'signing_in' };
      }
      const record = await read();
      const email = record?.email === undefined ? {} : { email: record.email };
      if (record && isSignedInChatGptCredential(record)) {
        return { state: 'signed_in', ...email };
      }
      // A registered client is bound to one account, whether or not its email was ever learned.
      return {
        state: 'signed_out',
        ...email,
        ...(record?.clientId === undefined ? {} : { registered: true }),
      };
    },
  };
}
