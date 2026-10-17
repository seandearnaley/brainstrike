import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AuthProvider,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';
import type { ExplicitHttpMcpAuthorizationCallbackSource } from '../mcp/interactive-oauth-completion';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

async function readJsonBody(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected one MCP request object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function createOAuthHarness(options?: {
  readonly authorizationCallbackTimeoutMs?: number;
  readonly callback?:
    | 'fail'
    | 'fail-after-connect'
    | 'hold'
    | 'hold-after-connect'
    | 'mismatched-state'
    | 'missing'
    | 'missing-state';
  readonly codeVerifierSave?:
    | 'fail-after-connect'
    | 'hold'
    | 'hold-and-fail-after-connect'
    | 'throw-sync';
  readonly maxStepUpRetries?: number;
  readonly rotatingState?: boolean;
  readonly stepUps?: number | 'always';
  readonly tokenExchange?: 'hold';
}) {
  const mcpUrl = new URL('https://resource.test/mcp');
  const issuer = 'https://auth.test/';
  const observed = {
    activeCallbackWaits: 0,
    activeVerifierSaves: 0,
    authorizationRequests: 0,
    initializeRequests: 0,
    stateRequests: 0,
    tokenInvalidations: 0,
    toolCalls: 0,
  };
  let codeVerifier = '';
  let discoveryState: OAuthDiscoveryState | undefined;
  let pendingCallback: Promise<URLSearchParams> | undefined;
  let releaseCallback: (() => void) | undefined;
  let releaseCodeVerifierSave: (() => void) | undefined;
  let releaseTokenExchange: (() => void) | undefined;
  let tokens: StoredOAuthTokens | undefined;
  let verifierSaveFailed = false;
  let remainingStepUps = options?.stepUps ?? 0;

  const callbackSource: ExplicitHttpMcpAuthorizationCallbackSource = {
    takePendingAuthorizationCallback(signal) {
      const callback = pendingCallback;
      pendingCallback = undefined;
      if (callback === undefined) {
        return;
      }
      observed.activeCallbackWaits += 1;
      return new Promise<URLSearchParams>((resolve, reject) => {
        let settled = false;
        const settle = (action: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          observed.activeCallbackWaits -= 1;
          signal.removeEventListener('abort', onAbort);
          action();
        };
        const onAbort = () => settle(() => reject(signal.reason));
        signal.addEventListener('abort', onAbort, { once: true });
        callback.then(
          (value) => settle(() => resolve(value)),
          (error: unknown) => settle(() => reject(error))
        );
      });
    },
  };
  const clientInformation: StoredOAuthClientInformation = {
    client_id: 'brainstrike-test-client',
    redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
  };
  const provider: OAuthClientProvider = {
    clientInformation: () => clientInformation,
    clientMetadata: {
      client_name: 'Brainstrike test client',
      grant_types: ['authorization_code'],
      redirect_uris: clientInformation.redirect_uris,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    codeVerifier: () => codeVerifier,
    discoveryState: () => discoveryState,
    invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'tokens') {
        observed.tokenInvalidations += 1;
        tokens = undefined;
      }
      if (scope === 'all' || scope === 'verifier') {
        codeVerifier = '';
      }
    },
    redirectToAuthorization(authorizationUrl) {
      observed.authorizationRequests += 1;
      if (options?.callback === 'missing') {
        return;
      }
      if (
        options?.callback === 'fail' ||
        (options?.callback === 'fail-after-connect' && observed.authorizationRequests > 1)
      ) {
        pendingCallback = Promise.reject(new Error('secret callback code=do-not-leak'));
        pendingCallback.catch(() => undefined);
        return;
      }
      const callbackParams = new URLSearchParams({
        code: `code-${observed.authorizationRequests}`,
        iss: issuer,
        ...(options?.callback === 'missing-state'
          ? {}
          : {
              state:
                options?.callback === 'mismatched-state'
                  ? 'attacker-state'
                  : (authorizationUrl.searchParams.get('state') ?? ''),
            }),
      });
      if (
        options?.callback === 'hold' ||
        (options?.callback === 'hold-after-connect' && observed.authorizationRequests > 1)
      ) {
        pendingCallback = new Promise<URLSearchParams>((resolve) => {
          releaseCallback = () => resolve(callbackParams);
        });
        return;
      }
      pendingCallback = Promise.resolve(callbackParams);
    },
    redirectUrl: clientInformation.redirect_uris[0],
    saveCodeVerifier(value) {
      if (options?.codeVerifierSave === 'throw-sync') {
        throw new Error('secret synchronous verifier failure');
      }
      return saveCodeVerifier(value);
    },
    saveDiscoveryState(value) {
      discoveryState = value;
    },
    saveTokens(value) {
      tokens = value;
    },
    state: () => {
      observed.stateRequests += 1;
      return options?.rotatingState ? `state-${observed.stateRequests}` : 'fixed-state';
    },
    tokens: () => tokens,
  };
  async function saveCodeVerifier(value: string): Promise<void> {
    const shouldHold =
      options?.codeVerifierSave === 'hold' ||
      (options?.codeVerifierSave === 'hold-and-fail-after-connect' &&
        observed.authorizationRequests > 0 &&
        !verifierSaveFailed);
    if (shouldHold) {
      observed.activeVerifierSaves += 1;
      await new Promise<void>((resolve) => {
        releaseCodeVerifierSave = () => {
          observed.activeVerifierSaves -= 1;
          resolve();
        };
      });
    }
    if (
      (options?.codeVerifierSave === 'fail-after-connect' ||
        options?.codeVerifierSave === 'hold-and-fail-after-connect') &&
      observed.authorizationRequests > 0 &&
      !verifierSaveFailed
    ) {
      verifierSaveFailed = true;
      throw new Error('secret verifier write failed');
    }
    codeVerifier = value;
  }
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return jsonResponse({
        authorization_servers: [issuer],
        resource: mcpUrl.href,
        scopes_supported: ['read', 'write'],
      });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return jsonResponse({
        authorization_endpoint: `${issuer}authorize`,
        code_challenge_methods_supported: ['S256'],
        issuer,
        response_types_supported: ['code'],
        token_endpoint: `${issuer}token`,
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/token') {
      if (options?.tokenExchange === 'hold') {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            releaseTokenExchange = undefined;
            reject(init?.signal?.reason);
          };
          init?.signal?.addEventListener('abort', onAbort, { once: true });
          releaseTokenExchange = () => {
            init?.signal?.removeEventListener('abort', onAbort);
            resolve();
          };
        });
      }
      const params = new URLSearchParams(String(init?.body));
      tokens = {
        access_token: `token-${observed.authorizationRequests}`,
        scope: params.get('scope') ?? 'read',
        token_type: 'Bearer',
      };
      return jsonResponse(tokens);
    }
    if (url.pathname !== '/mcp') {
      return new Response(null, { status: 404 });
    }
    const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
    const method = request['method'];
    if (method === 'initialize') {
      observed.initializeRequests += 1;
    }
    if (method === 'tools/call') {
      observed.toolCalls += 1;
    }
    if (
      !tokens ||
      new Headers(init?.headers).get('authorization') !== `Bearer ${tokens.access_token}`
    ) {
      return new Response(null, {
        headers: {
          'www-authenticate':
            'Bearer scope="read", resource_metadata="https://resource.test/.well-known/oauth-protected-resource"',
        },
        status: 401,
      });
    }
    if (method === 'tools/call' && (remainingStepUps === 'always' || remainingStepUps > 0)) {
      if (remainingStepUps !== 'always') {
        remainingStepUps -= 1;
      }
      return new Response(null, {
        headers: {
          'www-authenticate':
            'Bearer error="insufficient_scope", scope="write", resource_metadata="https://resource.test/.well-known/oauth-protected-resource"',
        },
        status: 403,
      });
    }
    if (typeof request['id'] !== 'number') {
      return new Response(null, { status: 202 });
    }
    const result =
      method === 'initialize'
        ? {
            capabilities: { tools: {} },
            protocolVersion: '2025-11-25',
            serverInfo: { name: 'oauth-test', version: '1.0.0' },
          }
        : { content: [{ text: 'ok', type: 'text' }] };
    return jsonResponse({ id: request['id'], jsonrpc: '2.0', result });
  };
  const client = new ExplicitHttpMcpClient({
    ...(options?.authorizationCallbackTimeoutMs === undefined
      ? {}
      : { authorizationCallbackTimeoutMs: options.authorizationCallbackTimeoutMs }),
    authorizationCallbackSource: callbackSource,
    authProvider: provider,
    fetch,
    maxStepUpRetries: options?.maxStepUpRetries ?? 3,
    name: 'interactive-oauth-test',
    transport: 'streamable-http',
    url: mcpUrl,
  });
  cleanupTasks.push(async () => await client.close());
  return {
    client,
    observed,
    releaseCallback: () => {
      if (!releaseCallback) {
        throw new Error('No held OAuth callback is available');
      }
      const release = releaseCallback;
      releaseCallback = undefined;
      release();
    },
    releaseCodeVerifierSave: () => {
      if (!releaseCodeVerifierSave) {
        throw new Error('No held code-verifier save is available');
      }
      const release = releaseCodeVerifierSave;
      releaseCodeVerifierSave = undefined;
      release();
    },
    releaseTokenExchange: () => {
      if (!releaseTokenExchange) {
        throw new Error('No held token exchange is available');
      }
      const release = releaseTokenExchange;
      releaseTokenExchange = undefined;
      release();
    },
  };
}

describe('ExplicitHttpMcpClient host-owned auth', () => {
  it('performs exactly one bounded 401 retry with the refreshed bearer', async () => {
    const observedAuthorization: Array<string | undefined> = [];
    const observedMethods: string[] = [];
    const server = createServer(async (request, response) => {
      const body = await readJsonBody(request);
      const method = body['method'];
      if (typeof method !== 'string') {
        response.writeHead(400).end();
        return;
      }
      observedAuthorization.push(request.headers.authorization);
      observedMethods.push(method);
      if (request.headers.authorization !== 'Bearer current-token') {
        response
          .writeHead(401, {
            'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1/oauth-resource"',
          })
          .end();
        return;
      }
      if (method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: body['id'],
            jsonrpc: '2.0',
            result: {
              capabilities: { tools: {} },
              protocolVersion: '2025-11-25',
              serverInfo: { name: 'auth-test-server', version: '1.0.0' },
            },
          })
        );
        return;
      }
      response.writeHead(202).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    cleanupTasks.push(
      async () =>
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    );
    const address = server.address() as AddressInfo;
    let token = 'expired-token';
    let unauthorizedCalls = 0;
    const authProvider: AuthProvider = {
      async onUnauthorized() {
        unauthorizedCalls += 1;
        token = 'current-token';
      },
      async token() {
        return token;
      },
    };
    const client = new ExplicitHttpMcpClient({
      authProvider,
      name: 'host-owned-auth-canary',
      transport: 'streamable-http',
      url: `http://127.0.0.1:${address.port}/mcp`,
    });
    cleanupTasks.push(async () => await client.close());

    await client.connect();

    expect(unauthorizedCalls).toBe(1);
    expect(observedMethods).toEqual(['initialize', 'initialize', 'notifications/initialized']);
    expect(observedAuthorization).toEqual([
      'Bearer expired-token',
      'Bearer current-token',
      'Bearer current-token',
    ]);
  });

  it('preserves the caller abort reason when non-interactive cleanup also fails', async () => {
    const abortReason = new Error('caller-owned abort');
    const cleanupFailure = new Error('owned cleanup failed');
    let markFetchStarted = (): void => undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.spyOn(StreamableHTTPClientTransport.prototype, 'close')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cleanupFailure);
    const client = new ExplicitHttpMcpClient({
      fetch: async (_input, init) => {
        markFetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('incidental transport abort')),
            { once: true }
          );
        });
      },
      name: 'non-interactive-abort-cleanup',
      transport: 'streamable-http',
      url: 'https://resource.test/mcp',
    });
    const abort = new AbortController();
    const connecting = client.connect({ signal: abort.signal });
    await fetchStarted;
    abort.abort(abortReason);

    const error = await connecting.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error('Expected non-interactive cleanup to aggregate failures');
    }
    expect(error.errors).toEqual([abortReason, cleanupFailure]);
  });
});

describe('ExplicitHttpMcpClient interactive OAuth completion', () => {
  it('finishes the initial redirect before reconnecting with a fresh SDK transport', async () => {
    const { client, observed } = createOAuthHarness();
    await client.connect();
    expect(observed.authorizationRequests).toBe(1);
    expect(observed.initializeRequests).toBe(2);
    expect(client.getConnectionGeneration()).toBeGreaterThan(1);
    expect(observed.activeCallbackWaits).toBe(0);
  });

  it('finishes one scope step-up and retries the same tool operation', async () => {
    const { client, observed } = createOAuthHarness({ stepUps: 1 });
    await client.connect();
    const result = await client.callTool({ arguments: {}, name: 'test-tool' });
    expect(result.content).toEqual([{ text: 'ok', type: 'text' }]);
    expect(observed.authorizationRequests).toBe(2);
    expect(observed.toolCalls).toBe(2);
  });

  it('caps each failing operation with the configured SDK retry limit', async () => {
    const { client, observed } = createOAuthHarness({ stepUps: 5 });
    await client.connect();
    const redirectsAfterConnect = observed.authorizationRequests;
    await expect(client.callTool({ arguments: {}, name: 'test-tool' })).rejects.toThrow(
      'MCP OAuth authorization request limit reached'
    );
    expect(observed.authorizationRequests - redirectsAfterConnect).toBe(3);
    expect(observed.activeCallbackWaits).toBe(0);

    await expect(client.callTool({ arguments: {}, name: 'test-tool' })).resolves.toMatchObject({
      content: [{ text: 'ok', type: 'text' }],
    });
    expect(observed.authorizationRequests - redirectsAfterConnect).toBe(4);
    expect(observed.toolCalls).toBe(6);
  });

  it('shares one authorization callback flight across concurrent scope step-ups', async () => {
    const { client, observed, releaseCallback } = createOAuthHarness({
      callback: 'hold-after-connect',
      rotatingState: true,
      stepUps: 2,
    });
    await client.connect();

    const first = client.callTool({ arguments: {}, name: 'first-tool' });
    const second = client.callTool({ arguments: {}, name: 'second-tool' });
    await vi.waitFor(() => expect(observed.activeCallbackWaits).toBe(1));
    expect(observed.authorizationRequests).toBe(2);
    expect(observed.stateRequests).toBe(2);
    releaseCallback();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(observed.authorizationRequests).toBe(2);
    expect(observed.activeCallbackWaits).toBe(0);
    expect(observed.toolCalls).toBe(4);
  });

  it('charges a joined authorization flight to every operation retry budget', async () => {
    const { client, observed, releaseCallback } = createOAuthHarness({
      callback: 'hold-after-connect',
      maxStepUpRetries: 1,
      stepUps: 3,
    });
    await client.connect();
    const requests = [
      client.callTool({ arguments: {}, name: 'first-tool' }),
      client.callTool({ arguments: {}, name: 'second-tool' }),
    ];
    await vi.waitFor(() => expect(observed.activeCallbackWaits).toBe(1));
    releaseCallback();
    const results = await Promise.allSettled(requests);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringContaining('MCP OAuth authorization request limit reached'),
      }),
    });
    expect(observed.authorizationRequests).toBe(2);
  });

  it('rejects every waiter when the shared verifier save fails', async () => {
    const { client, observed, releaseCodeVerifierSave } = createOAuthHarness({
      codeVerifierSave: 'hold-and-fail-after-connect',
      rotatingState: true,
      stepUps: 2,
    });
    await client.connect();
    const requests = [
      client.callTool({ arguments: {}, name: 'first-tool' }),
      client.callTool({ arguments: {}, name: 'second-tool' }),
    ];
    await vi.waitFor(() => expect(observed.activeVerifierSaves).toBe(1));
    releaseCodeVerifierSave();
    const results = await Promise.allSettled(requests);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) {
      if (result.status !== 'rejected') {
        throw new Error('Expected every shared verifier waiter to reject');
      }
      expect(String(result.reason)).toContain('MCP OAuth authorization setup failed');
      expect(String(result.reason)).not.toContain('secret verifier write failed');
    }
    expect(observed.authorizationRequests).toBe(1);
    expect(observed.stateRequests).toBe(2);
  });

  it('keeps a shared callback flight alive when one concurrent caller cancels', async () => {
    const { client, observed, releaseCallback } = createOAuthHarness({
      callback: 'hold-after-connect',
      rotatingState: true,
      stepUps: 2,
    });
    await client.connect();
    const abort = new AbortController();
    const cancelled = client.callTool(
      { arguments: {}, name: 'cancelled-tool' },
      { signal: abort.signal }
    );
    const surviving = client.callTool({ arguments: {}, name: 'surviving-tool' });
    await vi.waitFor(() => expect(observed.activeCallbackWaits).toBe(1));

    abort.abort(new Error('caller-only secret'));
    await expect(cancelled).rejects.toThrow('MCP OAuth authorization callback was cancelled');
    expect(observed.activeCallbackWaits).toBe(1);
    releaseCallback();

    await expect(surviving).resolves.toMatchObject({
      content: [{ text: 'ok', type: 'text' }],
    });
    await expect(client.callTool({ arguments: {}, name: 'follow-up-tool' })).resolves.toMatchObject(
      {
        content: [{ text: 'ok', type: 'text' }],
      }
    );
    expect(observed.authorizationRequests).toBe(2);
    expect(observed.stateRequests).toBe(2);
  });

  it('cleans up a failed shared callback flight exactly once', async () => {
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    const { client, observed } = createOAuthHarness({
      callback: 'fail-after-connect',
      rotatingState: true,
      stepUps: 2,
    });
    await client.connect();
    close.mockClear();

    const results = await Promise.allSettled([
      client.callTool({ arguments: {}, name: 'first-tool' }),
      client.callTool({ arguments: {}, name: 'second-tool' }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) {
      if (result.status !== 'rejected') {
        throw new Error('Expected both shared OAuth callers to reject');
      }
      expect(
        JSON.stringify(result.reason, Object.getOwnPropertyNames(result.reason))
      ).not.toContain('do-not-leak');
    }
    expect(observed.authorizationRequests).toBe(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('times out an abandoned authorization callback with owned cleanup', async () => {
    const { client, observed } = createOAuthHarness({
      authorizationCallbackTimeoutMs: 25,
      callback: 'hold',
    });
    await expect(client.connect()).rejects.toThrow('MCP OAuth authorization callback timed out');
    expect(observed.activeCallbackWaits).toBe(0);
  });

  it('times out a hung verifier save before any browser handoff', async () => {
    const { client, observed, releaseCodeVerifierSave } = createOAuthHarness({
      authorizationCallbackTimeoutMs: 25,
      codeVerifierSave: 'hold',
      rotatingState: true,
    });
    await expect(client.connect()).rejects.toThrow('MCP OAuth authorization callback timed out');
    expect(observed.authorizationRequests).toBe(0);
    expect(observed.stateRequests).toBe(1);
    releaseCodeVerifierSave();
  });

  it('redacts a synchronous verifier-store failure before browser handoff', async () => {
    const { client, observed } = createOAuthHarness({ codeVerifierSave: 'throw-sync' });
    const error = await client.connect().catch((cause: unknown) => cause);
    expect(String(error)).toContain('MCP OAuth authorization setup failed');
    expect(String(error)).not.toContain('secret synchronous verifier failure');
    expect(observed.authorizationRequests).toBe(0);
  });

  it('does not open the browser when the caller cancels before handoff', async () => {
    const { client, observed, releaseCodeVerifierSave } = createOAuthHarness({
      codeVerifierSave: 'hold',
    });
    const abort = new AbortController();
    const connecting = client.connect({ signal: abort.signal });
    await vi.waitFor(() => expect(observed.stateRequests).toBe(1));
    abort.abort(new Error('pre-handoff secret'));
    releaseCodeVerifierSave();

    const error = await connecting.catch((cause: unknown) => cause);
    expect(String(error)).toContain('MCP OAuth authorization callback was cancelled');
    expect(String(error)).not.toContain('pre-handoff secret');
    expect(observed.authorizationRequests).toBe(0);
  });

  it('times out and aborts a hung token exchange without persisting late tokens', async () => {
    const { client, observed } = createOAuthHarness({
      authorizationCallbackTimeoutMs: 25,
      tokenExchange: 'hold',
    });
    await expect(client.connect()).rejects.toThrow('MCP OAuth authorization callback timed out');
    expect(observed.tokenInvalidations).toBe(0);
    expect(observed.activeCallbackWaits).toBe(0);
  });

  it('cancels a callback wait without retaining its abort listener', async () => {
    const { client, observed } = createOAuthHarness({ callback: 'hold' });
    const abort = new AbortController();
    const connecting = client.connect({ signal: abort.signal });
    await vi.waitFor(() => expect(observed.activeCallbackWaits).toBe(1));
    abort.abort(new Error('secret abort reason'));
    const error = await connecting.catch((cause: unknown) => cause);
    expect(String(error)).toContain('MCP OAuth authorization callback was cancelled');
    expect(String(error)).not.toContain('secret abort reason');
    expect(observed.activeCallbackWaits).toBe(0);
  });

  it('terminal close settles a callback wait and closes the owned transport exactly once', async () => {
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    const { client, observed } = createOAuthHarness({
      callback: 'hold-after-connect',
      stepUps: 1,
    });
    await client.connect();
    const request = client.callTool({ arguments: {}, name: 'step-up-tool' });
    await vi.waitFor(() => expect(observed.activeCallbackWaits).toBe(1));
    close.mockClear();
    await client.close();
    await expect(request).rejects.toThrow('MCP OAuth authorization callback was cancelled');
    await expect(client.connect()).rejects.toThrow('Explicit HTTP MCP client is closed');
    expect(observed.activeCallbackWaits).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cancels a last request waiter without closing the shared active transport', async () => {
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    const { client, observed } = createOAuthHarness({
      callback: 'hold-after-connect',
      stepUps: 1,
    });
    await client.connect();
    close.mockClear();
    const abort = new AbortController();
    const request = client.callTool(
      { arguments: {}, name: 'cancelled-tool' },
      { signal: abort.signal }
    );
    await vi.waitFor(() => expect(observed.activeCallbackWaits).toBe(1));
    abort.abort(new Error('last waiter secret'));

    const error = await request.catch((cause: unknown) => cause);
    expect(String(error)).toContain('MCP OAuth authorization callback was cancelled');
    expect(String(error)).not.toContain('last waiter secret');
    expect(close).not.toHaveBeenCalled();
    await expect(client.callTool({ arguments: {}, name: 'surviving-tool' })).resolves.toMatchObject(
      {
        content: [{ text: 'ok', type: 'text' }],
      }
    );
  });

  it('clears a failed verifier setup and rotates state on the next operation', async () => {
    const { client, observed } = createOAuthHarness({
      codeVerifierSave: 'fail-after-connect',
      rotatingState: true,
      stepUps: 2,
    });
    await client.connect();
    const error = await client
      .callTool({ arguments: {}, name: 'first-tool' })
      .catch((cause: unknown) => cause);
    expect(String(error)).toContain('MCP OAuth authorization setup failed');
    expect(String(error)).not.toContain('secret verifier write failed');
    expect(observed.stateRequests).toBe(2);

    await expect(client.callTool({ arguments: {}, name: 'retry-tool' })).resolves.toMatchObject({
      content: [{ text: 'ok', type: 'text' }],
    });
    expect(observed.stateRequests).toBe(3);
  });

  it('preserves the primary failure while redacting callback failures', async () => {
    const { client } = createOAuthHarness({ callback: 'fail' });
    const error = await client.connect().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toContain('MCP OAuth authorization callback failed');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('do-not-leak');
  });

  it.each(['missing-state', 'mismatched-state'] as const)(
    'rejects an OAuth callback with %s',
    async (callback) => {
      const { client } = createOAuthHarness({ callback });
      const error = await client.connect().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AggregateError);
      expect(String(error)).toContain('MCP OAuth authorization callback state did not match');
      expect(String(error)).not.toContain('attacker-state');
    }
  );

  it('fails visibly when a captured redirect does not arm a callback', async () => {
    const { client } = createOAuthHarness({ callback: 'missing' });
    await expect(client.connect()).rejects.toThrow(
      'MCP OAuth authorization callback was not available after redirect'
    );
  });
});
