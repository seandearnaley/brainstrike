import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local OpenID Connect issuer that behaves as OpenAI's Sign in with ChatGPT
 * documents: the registration entry client, an issued client on the callback,
 * PKCE, a signed ID token, rotating refresh tokens and revocation. Its
 * `browser` stands in for the person: it approves the authorization URL the
 * host asked to open and follows the redirect to the host's loopback listener.
 */
export interface FakeChatGptIssuer {
  /** The authorization requests the host opened, as their query parameters. */
  readonly authorizations: URLSearchParams[];
  /** Approves a sign-in as the person would: pass it to the host as `openExternal`. */
  browser(url: string): Promise<void>;
  close(): Promise<void>;
  readonly issuer: string;
  /** What the next approval does instead of granting everything. */
  next: {
    /** Answer the redirect with this OAuth error instead of a code. */
    error?: string;
    /** The sign-in page opens and the person never finishes it: no redirect comes. */
    unanswered?: boolean;
    /** Leave the plan scope out of the grant, as a person who declines it does. */
    withoutPlanScope?: boolean;
  };
  /**
   * Holds the token endpoint's next answer. `reached` settles once the host's
   * request has arrived; `release` lets the answer go.
   */
  pauseTokens(): { readonly reached: Promise<void>; release(): void };
  /** Refresh tokens the host revoked. */
  readonly revoked: string[];
  /** The form bodies of the token-endpoint requests, in order. */
  readonly tokenRequests: URLSearchParams[];
  /** The account the next approval signs in. */
  user: { email: string; sub: string };
}

const PLAN_SCOPES = [
  'chatgpt.tokens.use.direct',
  'email',
  'offline_access',
  'openid',
  'profile',
  'resource.invoke',
];

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export async function startFakeChatGptIssuer(): Promise<FakeChatGptIssuer> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const codes = new Map<
    string,
    {
      challenge: string;
      clientId: string;
      nonce: string;
      scope: string;
      user: FakeChatGptIssuer['user'];
    }
  >();
  const sessions = new Map<string, { clientId: string; scope: string }>();
  let tokenPause: { reached(): void; released: Promise<void> } | undefined;
  const fake: FakeChatGptIssuer = {
    authorizations: [],
    browser: async (href) => {
      const url = new URL(href);
      const query = url.searchParams;
      fake.authorizations.push(new URLSearchParams(query));
      const redirect = new URL(query.get('redirect_uri') ?? '');
      redirect.searchParams.set('state', query.get('state') ?? '');
      const requested = query.get('client_id') ?? '';
      const { error, unanswered, withoutPlanScope } = fake.next;
      fake.next = {};
      if (unanswered) {
        return;
      }
      if (error) {
        redirect.searchParams.set('error', error);
      } else {
        // A first sign-in registers a client for this person; a later one names it.
        const clientId =
          requested === 'dynamic_agent_client'
            ? `oaiapp_${randomUUID().replaceAll('-', '')}`
            : requested;
        const scope = PLAN_SCOPES.filter(
          (granted) => !(withoutPlanScope && granted === 'chatgpt.tokens.use.direct')
        ).join(' ');
        const code = randomUUID();
        codes.set(code, {
          challenge: query.get('code_challenge') ?? '',
          clientId,
          nonce: query.get('nonce') ?? '',
          scope,
          user: fake.user,
        });
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('scope', scope);
        if (requested === 'dynamic_agent_client') {
          redirect.searchParams.set('client_id', clientId);
        }
      }
      // The redirect answers before the host has exchanged the code, as a browser's does.
      await fetch(redirect);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    issuer: '',
    next: {},
    pauseTokens: () => {
      const reached = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      tokenPause = { reached: reached.resolve, released: released.promise };
      return { reached: reached.promise, release: released.resolve };
    },
    revoked: [],
    tokenRequests: [],
    user: { email: 'ada@example.com', sub: 'user-ada' },
  };

  const idToken = (
    clientId: string,
    nonce: string | undefined,
    user: FakeChatGptIssuer['user']
  ) => {
    const seconds = Math.floor(Date.now() / 1000);
    const signed = `${base64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))}.${base64url(
      JSON.stringify({
        aud: clientId,
        email: user.email,
        exp: seconds + 3600,
        iat: seconds,
        iss: fake.issuer,
        sub: user.sub,
        ...(nonce === undefined ? {} : { nonce }),
      })
    )}`;
    return `${signed}.${createSign('RSA-SHA256').update(signed).sign(privateKey).toString('base64url')}`;
  };
  const grant = (clientId: string, scope: string) => {
    const refreshToken = `refresh-${randomUUID()}`;
    sessions.set(refreshToken, { clientId, scope });
    return {
      access_token: `access-${randomUUID()}`,
      expires_in: 3600,
      refresh_token: refreshToken,
      scope,
      token_type: 'Bearer',
    };
  };

  const server = createServer((request, response) => {
    void (async () => {
      const { pathname } = new URL(request.url ?? '/', fake.issuer);
      if (pathname === '/.well-known/openid-configuration') {
        return json(response, 200, {
          authorization_endpoint: `${fake.issuer}/api/accounts/authorize`,
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          id_token_signing_alg_values_supported: ['RS256'],
          issuer: fake.issuer,
          jwks_uri: `${fake.issuer}/.well-known/jwks.json`,
          response_types_supported: ['code'],
          revocation_endpoint: `${fake.issuer}/api/accounts/oauth/revoke`,
          subject_types_supported: ['public'],
          token_endpoint: `${fake.issuer}/api/accounts/oauth/token`,
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (pathname === '/.well-known/jwks.json') {
        return json(response, 200, {
          keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid, use: 'sig' }],
        });
      }
      if (pathname === '/api/accounts/oauth/revoke') {
        const form = await readForm(request);
        const token = form.get('token') ?? '';
        sessions.delete(token);
        fake.revoked.push(token);
        return response.writeHead(200).end();
      }
      if (pathname !== '/api/accounts/oauth/token') {
        return response.writeHead(404).end();
      }
      const form = await readForm(request);
      fake.tokenRequests.push(form);
      if (tokenPause) {
        const pause = tokenPause;
        tokenPause = undefined;
        pause.reached();
        await pause.released;
      }
      const clientId = form.get('client_id') ?? '';
      if (form.get('grant_type') === 'refresh_token') {
        const session = sessions.get(form.get('refresh_token') ?? '');
        if (session?.clientId !== clientId) {
          return json(response, 400, { error: 'invalid_grant' });
        }
        // Rotating: the spent refresh token never works again.
        sessions.delete(form.get('refresh_token') ?? '');
        return json(response, 200, grant(clientId, session.scope));
      }
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (!pending || pending.clientId !== clientId || pending.challenge !== challenge) {
        return json(response, 400, { error: 'invalid_grant' });
      }
      return json(response, 200, {
        ...grant(clientId, pending.scope),
        id_token: idToken(clientId, pending.nonce, pending.user),
      });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  (fake as { issuer: string }).issuer =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
