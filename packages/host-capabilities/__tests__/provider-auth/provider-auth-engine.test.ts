import { HostAuthStatusSchema } from '@brainstrike/agent-host';
import { SecretReadError } from '@brainstrike/agent-host/credential-contract';
import type { OAuthProviderDescriptor } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthFlowCancelledError,
  ProviderAuthFlowError,
} from '../../src/provider-auth/errors.js';
import type { LoopbackServerHandle } from '../../src/provider-auth/loopback-server.js';
import {
  assertInteractiveProviderAuthOrigin,
  createProviderAuthEngine,
  PROVIDER_AUTH_INTERACTIVE_ORIGIN,
} from '../../src/provider-auth/provider-auth-engine.js';
import { makeFakeSecrets } from './fake-secrets.js';

const PROVIDER = 'fake-provider';
function makeDescriptor(overrides: Partial<OAuthProviderDescriptor> = {}): OAuthProviderDescriptor {
  return {
    authorizeUrl: 'https://provider.test/authorize',
    clientId: 'client-123',
    providerId: PROVIDER,
    redirectPath: '/callback',
    redirectPort: 43_210,
    scopes: ['openid'],
    tokenUrl: 'https://provider.test/token',
    ...overrides,
  };
}
interface FakeLoopback {
  readonly deliverCode: (code: string) => void;
  readonly handle: LoopbackServerHandle;
}
function makeFakeLoopback(): FakeLoopback {
  let resolveCallback: ((result: { code: string }) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;
  const handle: LoopbackServerHandle = {
    cancel: () => {
      rejectCallback?.(new ProviderAuthFlowCancelledError());
    },
    close: async () => {
      rejectCallback?.(new ProviderAuthFlowCancelledError());
    },
    port: 43_210,
    redirectUri: 'http://127.0.0.1:43210/callback',
    waitForCallback: () =>
      new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = (error) => {
          rejectCallback = undefined;
          reject(error);
        };
      }),
  };
  return {
    deliverCode: (code) => {
      rejectCallback = undefined;
      resolveCallback?.({ code });
    },
    handle,
  };
}
function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
const TOKENS_BODY = {
  access_token: 'access-1',
  account_id: 'acct-42',
  expires_in: 3600,
  refresh_token: 'refresh-1',
};
function makeEngine(overrides: {
  descriptor?: OAuthProviderDescriptor;
  fetchResponses?: Response[];
  loopback?: FakeLoopback;
  secrets?: ReturnType<typeof makeFakeSecrets>;
  openExternal?: (url: string) => Promise<void>;
}) {
  const secrets = overrides.secrets ?? makeFakeSecrets();
  const descriptor = overrides.descriptor ?? makeDescriptor();
  const loopback = overrides.loopback;
  let fetchIndex = 0;
  const fetchFn = vi.fn(async () => {
    const response = overrides.fetchResponses?.[fetchIndex];
    fetchIndex += 1;
    if (!response) {
      throw new Error('engine fetch exhausted');
    }
    return response;
  }) as unknown as typeof fetch;
  const openExternal = vi.fn(overrides.openExternal ?? (async () => undefined));
  const engine = createProviderAuthEngine({
    fetchFn,
    getDescriptor: (providerId) => {
      if (providerId !== descriptor.providerId) {
        throw new ProviderAuthFlowError(
          'unknown_provider',
          `No OAuth provider descriptor registered for "${providerId}".`
        );
      }
      return descriptor;
    },
    openExternal,
    secrets,
    sleep: async () => undefined,
    ...(loopback ? { startLoopbackServerFn: async () => loopback.handle } : {}),
  });
  return { engine, fetchFn, openExternal, secrets };
}
describe('provider auth engine — status derivation', () => {
  it('reports disconnected when nothing is stored', async () => {
    const { engine } = makeEngine({});
    await expect(engine.getStatus(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
  });
  it('reports connected with accountId for a stored oauth credential', async () => {
    const secrets = makeFakeSecrets({
      [PROVIDER]: {
        access: 'a',
        accountId: 'acct-1',
        expires: 1,
        refresh: 'r',
        type: 'oauth',
      },
    });
    const { engine } = makeEngine({ secrets });
    await expect(engine.getStatus(PROVIDER)).resolves.toEqual({
      accountId: 'acct-1',
      state: 'connected',
    });
  });
  it('reports disconnected for a stored non-oauth credential', async () => {
    const secrets = makeFakeSecrets({ [PROVIDER]: { key: 'sk-1', type: 'api_key' } });
    const { engine } = makeEngine({ secrets });
    await expect(engine.getStatus(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
  });
  it('reports a credential_unreadable error when the store read fails', async () => {
    const secrets = makeFakeSecrets();
    secrets.readCredentialError = new SecretReadError('decrypt_failed', PROVIDER);
    const { engine } = makeEngine({ secrets });
    await expect(engine.getStatus(PROVIDER)).resolves.toEqual({
      code: 'credential_unreadable',
      state: 'error',
    });
  });
});
describe('provider auth engine — start', () => {
  it('returns unknown_provider for an unregistered provider', async () => {
    const { engine } = makeEngine({});
    await expect(engine.start('never-registered')).resolves.toEqual({
      code: 'unknown_provider',
      state: 'error',
    });
  });
  it('returns device_flow_unsupported for a device start without a device descriptor', async () => {
    const { engine } = makeEngine({});
    await expect(engine.start(PROVIDER, 'device')).resolves.toEqual({
      code: 'device_flow_unsupported',
      state: 'error',
    });
  });
  it('runs the loopback flow to connected and persists the credential', async () => {
    const loopback = makeFakeLoopback();
    const { engine, openExternal, secrets } = makeEngine({
      descriptor: makeDescriptor({
        extractAccountId: (grant) => grant.raw['account_id'] as string,
      }),
      fetchResponses: [tokenResponse(TOKENS_BODY)],
      loopback,
    });
    const started = await engine.start(PROVIDER);
    expect(started).toEqual({ state: 'awaiting_browser' });
    expect(openExternal).toHaveBeenCalledTimes(1);
    const authorizeUrl = new URL(openExternal.mock.calls[0]?.[0] as string);
    expect(authorizeUrl.searchParams.get('client_id')).toBe('client-123');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    loopback.deliverCode('auth-code');
    await vi.waitFor(async () => {
      await expect(engine.getStatus(PROVIDER)).resolves.toEqual({
        accountId: 'acct-42',
        state: 'connected',
      });
    });
    expect(secrets.store.get(PROVIDER)).toMatchObject({
      access: 'access-1',
      accountId: 'acct-42',
      refresh: 'refresh-1',
      type: 'oauth',
    });
  });
  it('announces awaiting_browser only AFTER openExternal resolves (truthful status)', async () => {
    // Security-review finding 8: the status must not claim the browser is
    // open before it actually is.
    const loopback = makeFakeLoopback();
    let releaseBrowser: (() => void) | undefined;
    const browserGate = new Promise<void>((resolve) => {
      releaseBrowser = resolve;
    });
    let opened = false;
    const { engine } = makeEngine({
      fetchResponses: [],
      loopback,
      openExternal: async () => {
        await browserGate;
        opened = true;
      },
    });
    let startStatus: unknown;
    const started = engine.start(PROVIDER).then((status) => {
      startStatus = status;
      return status;
    });
    // Give the flow a chance to run: start must NOT have resolved while
    // openExternal is still pending.
    await new Promise((resolve) => setImmediate(resolve));
    expect(startStatus).toBeUndefined();
    releaseBrowser?.();
    await expect(started).resolves.toEqual({ state: 'awaiting_browser' });
    expect(opened).toBe(true);
    await engine.cancel(PROVIDER);
  });
  it('returns browser_open_failed directly from start when openExternal rejects', async () => {
    const loopback = makeFakeLoopback();
    const { engine } = makeEngine({
      fetchResponses: [],
      loopback,
      openExternal: async () => {
        throw new Error('no browser available');
      },
    });
    await expect(engine.start(PROVIDER)).resolves.toEqual({
      code: 'browser_open_failed',
      state: 'error',
    });
  });
  it('cancel rejects a STALLED token exchange promptly and frees the provider for a new start', async () => {
    // Security-review finding 4: the flow AbortSignal must reach every fetch,
    // so a hung token endpoint cannot wedge the provider forever.
    const loopback = makeFakeLoopback();
    const secrets = makeFakeSecrets();
    const stalledFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })
    ) as unknown as typeof fetch;
    const engine = createProviderAuthEngine({
      fetchFn: stalledFetch,
      getDescriptor: () => makeDescriptor(),
      openExternal: async () => undefined,
      secrets,
      startLoopbackServerFn: async () => loopback.handle,
    });
    await engine.start(PROVIDER);
    loopback.deliverCode('code-into-stalled-exchange');
    // Let the flow reach the stalled fetch before cancelling.
    await vi.waitFor(() => {
      expect(stalledFetch).toHaveBeenCalledTimes(1);
    });
    await expect(engine.cancel(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
    // The provider is free again: a new start must not report
    // flow_already_active.
    await expect(engine.start(PROVIDER)).resolves.toEqual({ state: 'awaiting_browser' });
    await engine.cancel(PROVIDER);
  });
  it('rejects a second start while a flow is active', async () => {
    const loopback = makeFakeLoopback();
    const { engine } = makeEngine({ fetchResponses: [], loopback });
    await engine.start(PROVIDER);
    await expect(engine.start(PROVIDER)).resolves.toEqual({
      code: 'flow_already_active',
      state: 'error',
    });
    await engine.cancel(PROVIDER);
  });
  it('cancel during awaiting_browser returns to the idle-derived status', async () => {
    const loopback = makeFakeLoopback();
    const { engine } = makeEngine({ fetchResponses: [], loopback });
    await engine.start(PROVIDER);
    await expect(engine.cancel(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
  });
  it('cancel DURING loopback-server startup settles and frees the provider (PR #2529 finding 2)', async () => {
    // The window between `start` and the server finishing its bind used to
    // swallow cancellation entirely: the abort listener was attached after the
    // await, so an already-fired signal never reached it and engine.cancel()
    // stayed blocked on the flow until the 5-minute callback timeout.
    const loopback = makeFakeLoopback();
    const openExternal = vi.fn(async () => undefined);
    let releaseStartup: (() => void) | undefined;
    const startedUp = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const engine = createProviderAuthEngine({
      fetchFn: vi.fn() as unknown as typeof fetch,
      getDescriptor: () => makeDescriptor(),
      openExternal,
      secrets: makeFakeSecrets(),
      startLoopbackServerFn: async () => {
        await startedUp;
        return loopback.handle;
      },
    });
    // `start` cannot resolve yet — its first status transition is announced
    // after the browser opens — so hold the promise and cancel underneath it.
    const started = engine.start(PROVIDER);
    const cancelled = engine.cancel(PROVIDER);
    releaseStartup?.();
    await expect(cancelled).resolves.toEqual({ state: 'disconnected' });
    await expect(started).resolves.toEqual({ state: 'disconnected' });
    expect(openExternal).not.toHaveBeenCalled();
    // activeFlows must be clear: a fresh start cannot report flow_already_active
    // (the startup gate is already released, so this one binds immediately).
    await expect(engine.start(PROVIDER)).resolves.toEqual({ state: 'awaiting_browser' });
    await engine.cancel(PROVIDER);
  });
  it('surfaces a failed token exchange as a sticky error until disconnect', async () => {
    const loopback = makeFakeLoopback();
    const { engine } = makeEngine({
      fetchResponses: [tokenResponse({ error: 'invalid_grant' }, 400)],
      loopback,
    });
    await engine.start(PROVIDER);
    loopback.deliverCode('bad-code');
    await vi.waitFor(async () => {
      await expect(engine.getStatus(PROVIDER)).resolves.toEqual({
        code: 'token_exchange_failed',
        state: 'error',
      });
    });
    await expect(engine.disconnect(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
  });
  it('runs the device flow to connected', async () => {
    const { engine, secrets } = makeEngine({
      descriptor: makeDescriptor({
        deviceFlow: {
          pollUrl: 'https://provider.test/device/token',
          startUrl: 'https://provider.test/device/code',
          verificationUri: 'https://provider.test/activate',
        },
      }),
      fetchResponses: [
        tokenResponse({
          device_code: 'dc-1',
          expires_in: 600,
          interval: 5,
          user_code: 'ABCD-1234',
          verification_uri: 'https://provider.test/activate',
        }),
        tokenResponse(TOKENS_BODY),
      ],
    });
    const started = await engine.start(PROVIDER, 'device');
    expect(started).toEqual({
      state: 'awaiting_device_code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://provider.test/activate',
    });
    await vi.waitFor(async () => {
      await expect(engine.getStatus(PROVIDER)).resolves.toMatchObject({ state: 'connected' });
    });
    expect(secrets.store.get(PROVIDER)).toMatchObject({ type: 'oauth' });
  });
});
describe('provider auth engine — disconnect and refresh', () => {
  it('disconnect deletes the stored credential', async () => {
    const secrets = makeFakeSecrets({
      [PROVIDER]: { access: 'a', expires: 1, refresh: 'r', type: 'oauth' },
    });
    const { engine } = makeEngine({ secrets });
    await expect(engine.disconnect(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
    expect(secrets.store.has(PROVIDER)).toBe(false);
  });
  it('a refresh rejected with invalid_grant flips status to reconnect_required and keeps the credential', async () => {
    const secrets = makeFakeSecrets({
      [PROVIDER]: { access: 'a', expires: 0, refresh: 'r', type: 'oauth' },
    });
    const { engine } = makeEngine({
      fetchResponses: [tokenResponse({ error: 'invalid_grant' }, 400)],
      secrets,
    });
    await expect(engine.getFreshAccessToken(PROVIDER)).resolves.toEqual({
      ok: false,
      status: 'reconnect_required',
    });
    await expect(engine.getStatus(PROVIDER)).resolves.toEqual({ state: 'reconnect_required' });
    expect(secrets.store.has(PROVIDER)).toBe(true);
    await expect(engine.disconnect(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
    expect(secrets.store.has(PROVIDER)).toBe(false);
  });
  it('a refresh completing after disconnect is DISCARDED: nothing is persisted (epoch guard)', async () => {
    // Security-review finding 5: disconnect must invalidate an in-flight
    // refresh, otherwise its completion would resurrect the deleted
    // credential in the store.
    const secrets = makeFakeSecrets({
      [PROVIDER]: { access: 'a', expires: 0, refresh: 'r', type: 'oauth' },
    });
    let releaseRefresh: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const gatedFetch = vi.fn(async () => {
      await gate;
      return tokenResponse(TOKENS_BODY);
    }) as unknown as typeof fetch;
    const setCredentialSpy = vi.spyOn(secrets, 'setCredential');
    const engine = createProviderAuthEngine({
      fetchFn: gatedFetch,
      getDescriptor: () => makeDescriptor(),
      openExternal: async () => undefined,
      secrets,
    });
    const refreshing = engine.getFreshAccessToken(PROVIDER);
    await vi.waitFor(() => {
      expect(gatedFetch).toHaveBeenCalledTimes(1);
    });
    await expect(engine.disconnect(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
    releaseRefresh?.();
    await expect(refreshing).resolves.toEqual({ ok: false, status: 'not_connected' });
    expect(setCredentialSpy).not.toHaveBeenCalled();
    expect(secrets.store.has(PROVIDER)).toBe(false);
    await expect(engine.getStatus(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
  });
  it('a persist-failing refresh keeps the session working and surfaces credential_persist_failed', async () => {
    // Security-review finding 3: rotation succeeded at the provider but the
    // local store write failed — the rotated pair must stay active in memory
    // (or the session dies with an unusable stored refresh token) while the
    // user is told persistence failed.
    const secrets = makeFakeSecrets({
      [PROVIDER]: { access: 'a', expires: 0, refresh: 'r', type: 'oauth' },
    });
    secrets.setCredential = async () => {
      throw new Error('keychain unavailable');
    };
    const engine = makeEngine({
      fetchResponses: [tokenResponse(TOKENS_BODY)],
      secrets,
    }).engine;
    await expect(engine.getFreshAccessToken(PROVIDER)).resolves.toEqual({
      accessToken: 'access-1',
      ok: true,
    });
    await expect(engine.getStatus(PROVIDER)).resolves.toEqual({
      code: 'credential_persist_failed',
      state: 'error',
    });
  });
  it('a successful refresh clears a stale reconnect_required flag', async () => {
    const secrets = makeFakeSecrets({
      [PROVIDER]: { access: 'a', expires: 0, refresh: 'r', type: 'oauth' },
    });
    const { engine } = makeEngine({
      fetchResponses: [tokenResponse({ error: 'invalid_grant' }, 400), tokenResponse(TOKENS_BODY)],
      secrets,
    });
    await engine.getFreshAccessToken(PROVIDER);
    await expect(engine.getStatus(PROVIDER)).resolves.toEqual({ state: 'reconnect_required' });
    await expect(engine.getFreshAccessToken(PROVIDER)).resolves.toEqual({
      accessToken: 'access-1',
      ok: true,
    });
    await expect(engine.getStatus(PROVIDER)).resolves.toMatchObject({ state: 'connected' });
  });
});
describe('token-free status across the host auth wire (legal gate constraint 3)', () => {
  it('a FULL loopback flow and a FULL device flow leak no token material through any status', async () => {
    // Every status a real flow produces (awaiting_browser, awaiting_device_code
    // with user code, connected with accountId) crosses the `auth/*` wire
    // schema, which is strict: a token-bearing field would fail to parse.
    const ACCESS = 'ACCESS-TOKEN-SENTINEL-8f3a';
    const REFRESH = 'REFRESH-TOKEN-SENTINEL-2c9d';
    const ID_TOKEN = 'ID-TOKEN-SENTINEL-4e1b';
    const tokenBody = JSON.stringify({
      access_token: ACCESS,
      account_id: 'acct-sentinel-9',
      expires_in: 3600,
      id_token: ID_TOKEN,
      refresh_token: REFRESH,
      token_type: 'Bearer',
    });
    const deviceStartBody = JSON.stringify({
      device_code: 'device-code-sentinel',
      expires_in: 600,
      interval: 1,
      user_code: 'CODE-1234',
      verification_uri: 'https://provider.test/activate',
    });
    const secrets = makeFakeSecrets();
    const engine = createProviderAuthEngine({
      fetchFn: (async (url: unknown) =>
        new Response(String(url).endsWith('/device/code') ? deviceStartBody : tokenBody, {
          status: 200,
        })) as unknown as typeof fetch,
      getDescriptor: () =>
        makeDescriptor({
          deviceFlow: {
            pollUrl: 'https://provider.test/device/token',
            startUrl: 'https://provider.test/device/code',
            verificationUri: 'https://provider.test/activate',
          },
          extractAccountId: (grant) => {
            const accountId = grant.raw['account_id'];
            return typeof accountId === 'string' ? accountId : undefined;
          },
        }),
      openExternal: async () => undefined,
      secrets,
      sleep: async () => undefined,
      // Fake loopback that delivers the code as soon as the flow waits on it.
      startLoopbackServerFn: async () => ({
        cancel: () => undefined,
        close: async () => undefined,
        port: 43_210,
        redirectUri: 'http://127.0.0.1:43210/callback',
        waitForCallback: () =>
          new Promise((resolve) => {
            setImmediate(() => resolve({ code: 'flow-code' }));
          }),
      }),
    });
    const observed: unknown[] = [];
    const observe = async (status: Promise<unknown>): Promise<unknown> => {
      const wire = Schema.decodeUnknownSync(HostAuthStatusSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(JSON.parse(JSON.stringify(await status)));
      observed.push(wire);
      return wire;
    };
    expect(await observe(engine.start(PROVIDER))).toEqual({ state: 'awaiting_browser' });
    await vi.waitFor(async () => {
      expect(await observe(engine.getStatus(PROVIDER))).toEqual({
        accountId: 'acct-sentinel-9',
        state: 'connected',
      });
    });
    expect(secrets.store.get(PROVIDER)).toMatchObject({ access: ACCESS });
    expect(await observe(engine.disconnect(PROVIDER))).toEqual({ state: 'disconnected' });
    expect(await observe(engine.start(PROVIDER, 'device'))).toEqual({
      state: 'awaiting_device_code',
      userCode: 'CODE-1234',
      verificationUri: 'https://provider.test/activate',
    });
    await vi.waitFor(async () => {
      expect(await observe(engine.getStatus(PROVIDER))).toEqual({
        accountId: 'acct-sentinel-9',
        state: 'connected',
      });
    });
    const serialized = JSON.stringify(observed);
    expect(observed.length).toBeGreaterThanOrEqual(5);
    expect(serialized).not.toContain(ACCESS);
    expect(serialized).not.toContain(REFRESH);
    expect(serialized).not.toContain(ID_TOKEN);
    expect(serialized).not.toMatch(/access_token|refresh_token|id_token/i);
  });
});
describe('interactive-desktop-only guard (legal gate constraint 4)', () => {
  it('pins the interactive origin to the private desktop client only', () => {
    expect(PROVIDER_AUTH_INTERACTIVE_ORIGIN).toBe('desktop-ui');
  });
  it('accepts desktop-ui and rejects every other origin, including no live client', () => {
    expect(() => assertInteractiveProviderAuthOrigin('desktop-ui')).not.toThrow();
    for (const origin of ['public-socket', undefined] as const) {
      expect(() => assertInteractiveProviderAuthOrigin(origin)).toThrow(/interactive/i);
    }
  });
});
