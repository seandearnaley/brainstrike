import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderAuthEngine,
  getSubscriptionFetchFactory,
  initializeProviderAuthRuntime,
  purgeProviderAuthRuntimeState,
  resetProviderAuthRuntimeForTest,
} from '../../provider-auth/provider-auth-runtime';
import { makeFakeSecrets } from './fake-secrets';

/**
 * Provider-auth runtime lifecycle (BST-1356; PR #2527 review, finding 4).
 *
 * Covers the two things that had no test: the factory-reset purge, and the
 * double-construction guard that keeps ONE engine (and therefore one
 * single-flight refresher) per process.
 */

const PROVIDER = 'openai-codex';

function oauthCredential() {
  return {
    access: 'ACCESS-TOKEN',
    accountId: 'acct-1',
    expires: Date.now() + 3_600_000,
    refresh: 'REFRESH-TOKEN',
    type: 'oauth' as const,
  };
}

afterEach(() => {
  resetProviderAuthRuntimeForTest();
  vi.restoreAllMocks();
});

describe('provider-auth runtime construction', () => {
  it('registers the Codex descriptor and exposes the engine', () => {
    const engine = initializeProviderAuthRuntime({
      appVersion: '9.9.9',
      openExternal: async () => undefined,
      secrets: makeFakeSecrets(),
    });
    expect(getProviderAuthEngine()).toBe(engine);
  });

  it('REFUSES a second construction (one engine = one single-flight refresher)', () => {
    // Two engines would each own an `inFlight` map and could concurrently
    // refresh, REPLAYING a rotating refresh token.
    const deps = {
      appVersion: '9.9.9',
      openExternal: async () => undefined,
      secrets: makeFakeSecrets(),
    };
    initializeProviderAuthRuntime(deps);
    expect(() => initializeProviderAuthRuntime(deps)).toThrow(/already initialized/i);
  });

  it('throws rather than returning a null engine before initialization', () => {
    expect(() => getProviderAuthEngine()).toThrow(/not been initialized/i);
  });

  it('exposes NO subscription-fetch capability before initialization', () => {
    // This is the structural half of gate constraint 4: a host that never
    // initializes the runtime cannot resolve a subscription credential.
    expect(getSubscriptionFetchFactory()).toBeUndefined();
  });

  it('exposes the capability once initialized', () => {
    initializeProviderAuthRuntime({
      appVersion: '9.9.9',
      openExternal: async () => undefined,
      secrets: makeFakeSecrets(),
    });
    expect(typeof getSubscriptionFetchFactory()).toBe('function');
  });
});

describe('factory-reset purge', () => {
  it('deletes the stored credential for every registered descriptor', async () => {
    const secrets = makeFakeSecrets({ [PROVIDER]: oauthCredential() });
    initializeProviderAuthRuntime({
      appVersion: '9.9.9',
      openExternal: async () => undefined,
      secrets,
    });

    await purgeProviderAuthRuntimeState();

    expect(secrets.store.get(PROVIDER)).toBeUndefined();
    expect(await secrets.listProviders()).toEqual([]);
  });

  it('goes through engine.disconnect, so the in-memory overlay is invalidated', async () => {
    // The regression this pins: wiping only the secrets FILE leaves a rotated
    // pair whose store write failed alive in the refresher's memory overlay,
    // as the ACTIVE credential, for the rest of the process lifetime. That
    // path is `refresher.invalidate`, reached ONLY via disconnect — this test
    // fails if the purge is ever "simplified" to a direct deleteKey.
    const secrets = makeFakeSecrets({ [PROVIDER]: oauthCredential() });
    initializeProviderAuthRuntime({
      appVersion: '9.9.9',
      openExternal: async () => undefined,
      secrets,
    });
    const engine = getProviderAuthEngine();
    const disconnect = vi.spyOn(engine, 'disconnect');

    await purgeProviderAuthRuntimeState();

    expect(disconnect).toHaveBeenCalledWith(PROVIDER);
  });

  it('leaves the provider disconnected afterwards', async () => {
    const secrets = makeFakeSecrets({ [PROVIDER]: oauthCredential() });
    initializeProviderAuthRuntime({
      appVersion: '9.9.9',
      openExternal: async () => undefined,
      secrets,
    });

    await purgeProviderAuthRuntimeState();

    expect(await getProviderAuthEngine().getStatus(PROVIDER)).toEqual({ state: 'disconnected' });
    // And a token read now fails closed rather than serving a cached one.
    expect(await getProviderAuthEngine().getFreshAccessToken(PROVIDER)).toEqual({
      ok: false,
      status: 'not_connected',
    });
  });

  it('is a no-op (not a throw) when the runtime was never initialized', async () => {
    // Factory reset must never fail because this optional subsystem is absent.
    await expect(purgeProviderAuthRuntimeState()).resolves.toBeUndefined();
  });

  it('never rejects when one provider fails to disconnect', async () => {
    const secrets = makeFakeSecrets({ [PROVIDER]: oauthCredential() });
    initializeProviderAuthRuntime({
      appVersion: '9.9.9',
      openExternal: async () => undefined,
      secrets,
    });
    vi.spyOn(getProviderAuthEngine(), 'disconnect').mockRejectedValue(new Error('keychain locked'));

    // A reset must not be blocked by one provider; the failure is logged.
    await expect(purgeProviderAuthRuntimeState()).resolves.toBeUndefined();
  });
});
