import { createHash } from 'node:crypto';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  createMcpOAuthAuthorizationResponseVerifier,
  createMcpOAuthReferenceEndpoint,
  createMcpOAuthReferenceHandler,
  type McpOAuthReferenceHandler,
  type McpOAuthReferenceHandlerOptions,
} from '../src/oauth-reference';

const ORIGIN = new URL('http://127.0.0.1:43123/');
const REDIRECT_URI = 'http://127.0.0.1:54321/callback';
const VERIFIER = 'brainstrike-mcp-lab-pkce-verifier-000000000000000000000000';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function createFixture(
  options: McpOAuthReferenceHandlerOptions = {},
  onClose?: () => Promise<void>
): { readonly closeCalls: () => number; readonly handler: McpOAuthReferenceHandler } {
  let closeCalls = 0;
  const downstream = {
    async close() {
      closeCalls += 1;
      await onClose?.();
    },
    async fetch() {
      return Response.json({ ok: true });
    },
  } as unknown as McpHttpHandler;
  return {
    closeCalls: () => closeCalls,
    handler: createMcpOAuthReferenceHandler(
      downstream,
      createMcpOAuthReferenceEndpoint(ORIGIN),
      options
    ),
  };
}

async function issueAccessToken(handler: McpOAuthReferenceHandler): Promise<string> {
  const clientId = await register(handler);
  const authorization = await authorize(handler, clientId);
  const code = new URL(authorization.headers.get('location') ?? 'missing:').searchParams.get(
    'code'
  );
  if (!code) {
    throw new Error('Expected an authorization code');
  }
  const token = await handler.fetch(
    new Request(handler.endpoint.tokenUrl, {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: VERIFIER,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        resource: handler.endpoint.url.href,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    })
  );
  return String(((await token.json()) as Record<string, unknown>)['access_token']);
}

async function register(handler: McpOAuthReferenceHandler): Promise<string> {
  const response = await handler.fetch(
    new Request(handler.endpoint.registrationUrl, {
      body: JSON.stringify({
        application_type: 'native',
        client_name: 'Brainstrike MCP Lab',
        grant_types: ['authorization_code'],
        redirect_uris: [REDIRECT_URI],
        response_types: ['code'],
        scope: 'mcp',
        token_endpoint_auth_method: 'none',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
  );
  expect(response.status).toBe(201);
  return String(((await response.json()) as Record<string, unknown>)['client_id']);
}

async function authorize(
  handler: McpOAuthReferenceHandler,
  clientId: string,
  overrides: Readonly<Record<string, string>> = {}
): Promise<Response> {
  const url = new URL(handler.endpoint.authorizationUrl);
  url.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI,
    resource: handler.endpoint.url.href,
    response_type: 'code',
    scope: 'mcp',
    state: 'state-1',
    ...overrides,
  }).toString();
  return handler.fetch(new Request(url));
}

describe('MCP OAuth reference core', () => {
  it('downscopes the SDK v2 interactive registration request to its supported grant', async () => {
    const { handler } = createFixture();
    try {
      const response = await handler.fetch(
        new Request(handler.endpoint.registrationUrl, {
          body: JSON.stringify({
            application_type: 'native',
            client_name: 'Brainstrike MCP Client',
            grant_types: ['authorization_code', 'refresh_token'],
            redirect_uris: [REDIRECT_URI],
            response_types: ['code'],
            scope: 'mcp',
            token_endpoint_auth_method: 'none',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        grant_types: ['authorization_code'],
      });
    } finally {
      await handler.close();
    }
  });

  it('binds a bounded native authorization-code flow to state, PKCE, resource, and expiry', async () => {
    let now = 1_700_000_000_000;
    const { handler } = createFixture({
      now: () => now,
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });
    const clientId = await register(handler);
    const invalidResource = await authorize(handler, clientId, {
      resource: 'https://attacker.invalid/mcp',
      state: 'bad-resource',
    });
    expect(invalidResource.status).toBe(302);
    expect(
      new URL(invalidResource.headers.get('location') ?? 'missing:').searchParams.get('error')
    ).toBe('invalid_target');
    const authorization = await authorize(handler, clientId);
    const callback = new URL(authorization.headers.get('location') ?? 'missing:');
    expect(callback.searchParams.get('iss')).toBe(handler.endpoint.issuer.href);
    const code = callback.searchParams.get('code') ?? '';
    const tokenResponse = await handler.fetch(
      new Request(handler.endpoint.tokenUrl, {
        body: new URLSearchParams({
          client_id: clientId,
          code,
          code_verifier: VERIFIER,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
          resource: handler.endpoint.url.href,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      })
    );
    expect(tokenResponse.status).toBe(200);
    const token = String(((await tokenResponse.json()) as Record<string, unknown>)['access_token']);
    expect(token).not.toBe('brainstrike-lab-access-1');
    const protectedRequest = (body: BodyInit = '{}') =>
      handler.fetch(
        new Request(handler.endpoint.url, {
          body,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          method: 'POST',
        })
      );
    expect((await protectedRequest()).status).toBe(200);
    for (const [length, status] of [
      [1024 * 1024, 200],
      [1024 * 1024 + 1, 413],
    ] as const) {
      expect((await protectedRequest(' '.repeat(length))).status).toBe(status);
    }
    const invalidUtf8 = await protectedRequest(new Uint8Array([255]));
    expect(invalidUtf8.status).toBe(400);
    await expect(invalidUtf8.json()).resolves.toEqual({ error: 'mcp_lab_body_invalid_utf8' });
    now += 301_000;
    expect((await protectedRequest()).status).toBe(401);
    await handler.close();
    expect(handler.stateCounts()).toEqual({ clients: 0, codes: 0, states: 0, tokens: 0 });
  });

  it('publishes exact discovery and diagnoses callback failures precisely', async () => {
    const { handler } = createFixture();
    await expect(
      (await handler.fetch(new Request(handler.endpoint.authorizationServerMetadataUrl))).json()
    ).resolves.toMatchObject({
      authorization_endpoint: handler.endpoint.authorizationUrl.href,
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ['authorization_code'],
      issuer: handler.endpoint.issuer.href,
      registration_endpoint: handler.endpoint.registrationUrl.href,
      token_endpoint: handler.endpoint.tokenUrl.href,
    });
    await expect(
      (await handler.fetch(new Request(handler.endpoint.protectedResourceMetadataUrl))).json()
    ).resolves.toMatchObject({
      authorization_servers: [handler.endpoint.issuer.href],
      resource: handler.endpoint.url.href,
    });
    const wrongMethod = await handler.fetch(
      new Request(handler.endpoint.authorizationServerMetadataUrl, { method: 'HEAD' })
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');

    const clientId = await register(handler);
    const response = await authorize(handler, clientId);
    const callback = new URL(response.headers.get('location') ?? 'missing:');
    callback.searchParams.set('extension_value', 'ignored');
    const verifier = createMcpOAuthAuthorizationResponseVerifier({
      endpoint: handler.endpoint,
      expectedRedirectUri: REDIRECT_URI,
      expectedState: 'state-1',
    });
    expect(verifier(callback)).toMatch(/^brainstrike-lab-code-/u);
    expect(() => verifier(callback)).toThrow(/already consumed/);

    for (const [mutate, error] of [
      [(url: URL) => url.searchParams.append('state', 'state-1'), /repeats a known parameter/],
      [(url: URL) => url.searchParams.append('iss', handler.endpoint.issuer.href), /repeats/],
      [(url: URL) => url.searchParams.set('state', 'wrong-state'), /state mismatch/],
      [(url: URL) => url.searchParams.set('iss', 'https://attacker.invalid/'), /issuer mismatch/],
      [(url: URL) => url.searchParams.delete('code'), /missing an authorization code/],
    ] as const) {
      const tampered = new URL(callback);
      mutate(tampered);
      expect(() =>
        createMcpOAuthAuthorizationResponseVerifier({
          endpoint: handler.endpoint,
          expectedRedirectUri: REDIRECT_URI,
          expectedState: 'state-1',
        })(tampered)
      ).toThrow(error);
    }

    const authorizationError = new URL(
      (await authorize(handler, clientId, { scope: 'wrong', state: 'state-error' })).headers.get(
        'location'
      ) ?? 'missing:'
    );
    expect(() =>
      createMcpOAuthAuthorizationResponseVerifier({
        endpoint: handler.endpoint,
        expectedRedirectUri: REDIRECT_URI,
        expectedState: 'state-error',
      })(authorizationError)
    ).toThrow(/authorization error: invalid_request/);

    const fixedQueryCallback = new URL(
      `${REDIRECT_URI}?tenant=a&tenant=b&code=code&iss=${encodeURIComponent(handler.endpoint.issuer.href)}&state=state-1`
    );
    expect(() =>
      createMcpOAuthAuthorizationResponseVerifier({
        endpoint: handler.endpoint,
        expectedRedirectUri: `${REDIRECT_URI}?tenant=a`,
        expectedState: 'state-1',
      })(fixedQueryCallback)
    ).toThrow(/redirect mismatch/);
  });

  it('prunes expired capacity and waits for in-flight routes before retryable close', async () => {
    let now = 1_700_000_000_000;
    let failClose = true;
    const { closeCalls, handler } = createFixture({ now: () => now }, async () => {
      if (failClose) {
        failClose = false;
        throw new Error('transient close failure');
      }
    });
    const clientId = await register(handler);
    for (let index = 0; index < 128; index += 1) {
      expect((await authorize(handler, clientId, { state: `state-${index}` })).status).toBe(302);
    }
    const atCapacity = await authorize(handler, clientId, { state: 'state-capacity' });
    expect(
      new URL(atCapacity.headers.get('location') ?? 'missing:').searchParams.get('error')
    ).toBe('temporarily_unavailable');
    now += 301_000;
    expect((await authorize(handler, clientId, { state: 'state-0' })).status).toBe(302);

    let releaseBody: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                application_type: 'native',
                client_name: 'In-flight Client',
                grant_types: ['authorization_code'],
                redirect_uris: ['http://127.0.0.1:54322/callback'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
              })
            )
          );
          controller.close();
        };
      },
    });
    const registration = handler.fetch(
      new Request(handler.endpoint.registrationUrl, {
        body,
        duplex: 'half',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      } as RequestInit & { readonly duplex: 'half' })
    );
    await Promise.resolve();
    const firstClose = handler.close();
    releaseBody?.();
    expect((await registration).status).toBe(201);
    await expect(firstClose).rejects.toThrow('transient close failure');
    expect(handler.stateCounts()).toEqual({ clients: 0, codes: 0, states: 0, tokens: 0 });
    await handler.close();
    expect(closeCalls()).toBe(2);
  });

  it('waits for an authenticated MCP dispatch before closing downstream state', async () => {
    let dispatchStarted: (() => void) | undefined;
    let releaseDispatch: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let downstreamClosed = false;
    const downstream = {
      async close() {
        downstreamClosed = true;
      },
      async fetch() {
        dispatchStarted?.();
        await released;
        return Response.json({ ok: true });
      },
    } as unknown as McpHttpHandler;
    const handler = createMcpOAuthReferenceHandler(
      downstream,
      createMcpOAuthReferenceEndpoint(ORIGIN)
    );
    const token = await issueAccessToken(handler);
    const dispatch = handler.fetch(
      new Request(handler.endpoint.url, {
        body: '{}',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        method: 'POST',
      })
    );
    await started;
    let closeSettled = false;
    const close = handler.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(downstreamClosed).toBe(false);

    releaseDispatch?.();
    await expect(dispatch).resolves.toMatchObject({ status: 200 });
    await close;
    expect(downstreamClosed).toBe(true);
  });

  it('serializes OAuth mutations while metadata remains directly available', async () => {
    let blockedMethod: 'oauth/authorize' | 'oauth/token' | undefined;
    let enterBlocked: (() => void) | undefined;
    let releaseBlocked: (() => void) | undefined;
    const armBlock = (method: 'oauth/authorize' | 'oauth/token') => {
      blockedMethod = method;
      const entered = new Promise<void>((resolve) => {
        enterBlocked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseBlocked = resolve;
      });
      return { entered, release: () => releaseBlocked?.(), released };
    };
    let activeBlock: ReturnType<typeof armBlock> | undefined;
    const { handler } = createFixture({
      async beforeAuthorizationMutation(_request, method) {
        if (method !== blockedMethod || !activeBlock) {
          return;
        }
        blockedMethod = undefined;
        enterBlocked?.();
        await activeBlock.released;
      },
    });
    const clientId = await register(handler);

    activeBlock = armBlock('oauth/authorize');
    const firstAuthorization = authorize(handler, clientId);
    await activeBlock.entered;
    const secondAuthorization = authorize(handler, clientId);
    expect(
      (await handler.fetch(new Request(handler.endpoint.authorizationServerMetadataUrl))).status
    ).toBe(200);
    activeBlock.release();
    const callbacks = await Promise.all([firstAuthorization, secondAuthorization]).then(
      (responses) =>
        responses.map((response) => new URL(response.headers.get('location') ?? 'missing:'))
    );
    expect(callbacks.filter((callback) => callback.searchParams.has('code'))).toHaveLength(1);
    expect(
      callbacks.filter((callback) => callback.searchParams.get('error') === 'invalid_request')
    ).toHaveLength(1);

    const code = callbacks
      .find((callback) => callback.searchParams.has('code'))
      ?.searchParams.get('code');
    if (!code) {
      throw new Error('Expected one successful authorization code');
    }
    const tokenRequest = () =>
      new Request(handler.endpoint.tokenUrl, {
        body: new URLSearchParams({
          client_id: clientId,
          code,
          code_verifier: VERIFIER,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
          resource: handler.endpoint.url.href,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      });
    activeBlock = armBlock('oauth/token');
    const firstToken = handler.fetch(tokenRequest());
    await activeBlock.entered;
    const secondToken = handler.fetch(tokenRequest());
    activeBlock.release();
    const tokenResponses = await Promise.all([firstToken, secondToken]);
    expect(tokenResponses.map((response) => response.status).sort()).toEqual([200, 400]);
    const rejected = tokenResponses.find((response) => response.status === 400);
    await expect(rejected?.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    await handler.close();
  });
});
