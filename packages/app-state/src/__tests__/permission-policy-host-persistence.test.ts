// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const SAVED = {
  enforce: true,
  perToolOverrides: {},
  policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
  yolo: false,
};

afterEach(() => {
  Reflect.deleteProperty(window, 'agentHost');
  vi.resetModules();
});

/** BST-1930 stage e: a window with an agent host client keeps the saved policy there. */
describe('the permission policy store with an agent host client', () => {
  it('hydrates from and saves to the persistence its client provides, never this window', async () => {
    (window as Window & { agentHost?: unknown }).agentHost = {};
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const values = new Map<string, string>([
      ['permission-policy.v1', JSON.stringify({ state: SAVED, version: 2 })],
    ]);
    const host = {
      getItem: vi.fn(async (name: string) => values.get(name) ?? null),
      removeItem: vi.fn(async (name: string) => {
        values.delete(name);
      }),
      setItem: vi.fn(async (name: string, value: string) => {
        values.set(name, value);
      }),
    };
    const store = await import('../stores/permission-policy-store.ts');
    // Before the client provides its persistence, nothing is read or written.
    await Promise.resolve();
    expect(host.getItem).not.toHaveBeenCalled();

    store.provideHostPermissionPolicyPersistence(host);
    await vi.waitFor(() =>
      expect(store.usePermissionPolicyStore.getState().policies.edit).toBe('deny')
    );
    await store.usePermissionPolicyStore.getState().setCategoryPolicy('execute', 'deny');
    expect(JSON.parse(values.get('permission-policy.v1') ?? '{}')).toMatchObject({
      state: { policies: { edit: 'deny', execute: 'deny' } },
      version: store.PERMISSION_POLICY_STORE_VERSION,
    });
    expect(local).not.toHaveBeenCalledWith('permission-policy.v1', expect.anything());
  });

  it('shows a choice only once the host has committed it, so a quit or kill never loses what the user saw', async () => {
    (window as Window & { agentHost?: unknown }).agentHost = {};
    const commit = Promise.withResolvers<void>();
    const host = {
      getItem: vi.fn(async () => null),
      removeItem: vi.fn(async () => undefined),
      setItem: vi.fn(() => commit.promise),
    };
    const store = await import('../stores/permission-policy-store.ts');
    store.provideHostPermissionPolicyPersistence(host);
    await vi.waitFor(() =>
      expect(store.usePermissionPolicyHydration.getState().status).toBe('ready')
    );

    const saved = store.usePermissionPolicyStore.getState().setCategoryPolicy('edit', 'deny');
    await vi.waitFor(() => expect(host.setItem).toHaveBeenCalledOnce());
    expect(store.usePermissionPolicyStore.getState().policies.edit).toBe('ask');

    commit.resolve();
    await saved;
    expect(store.usePermissionPolicyStore.getState().policies.edit).toBe('deny');
  });

  it('keeps the last saved choice and reports why when the host refuses a save', async () => {
    (window as Window & { agentHost?: unknown }).agentHost = {};
    const host = {
      getItem: vi.fn(async () => null),
      removeItem: vi.fn(async () => undefined),
      setItem: vi.fn(async () => {
        throw new Error('The agent host is closing');
      }),
    };
    const store = await import('../stores/permission-policy-store.ts');
    store.provideHostPermissionPolicyPersistence(host);

    await store.usePermissionPolicyStore.getState().setCategoryPolicy('edit', 'deny');

    expect(store.usePermissionPolicyStore.getState().policies.edit).toBe('ask');
    expect(store.usePermissionPolicySave.getState().error).toBe('The agent host is closing');
  });

  it('lets no save that was pending at a factory reset bring the old policy back', async () => {
    (window as Window & { agentHost?: unknown }).agentHost = {};
    const values = new Map<string, string>();
    const commit = Promise.withResolvers<void>();
    const host = {
      getItem: vi.fn(async (name: string) => values.get(name) ?? null),
      removeItem: vi.fn(async (name: string) => {
        values.delete(name);
      }),
      setItem: vi.fn(async (name: string, value: string) => {
        await commit.promise;
        values.set(name, value);
      }),
    };
    const store = await import('../stores/permission-policy-store.ts');
    store.provideHostPermissionPolicyPersistence(host);
    await vi.waitFor(() =>
      expect(store.usePermissionPolicyHydration.getState().status).toBe('ready')
    );

    const inFlight = store.usePermissionPolicyStore.getState().setCategoryPolicy('edit', 'deny');
    const queued = store.usePermissionPolicyStore.getState().setYolo(true);
    await vi.waitFor(() => expect(host.setItem).toHaveBeenCalledOnce());
    store.resetPermissionPolicyStoreToDefaults();
    commit.resolve();
    await Promise.all([inFlight, queued]);
    await vi.waitFor(() => expect(host.removeItem).toHaveBeenCalledOnce());

    expect(store.usePermissionPolicyStore.getState()).toMatchObject({
      policies: { edit: 'ask' },
      yolo: false,
    });
    expect(host.setItem).toHaveBeenCalledOnce();
    expect(values.has('permission-policy.v1')).toBe(false);
  });

  it('never overwrites a policy it could not load', async () => {
    (window as Window & { agentHost?: unknown }).agentHost = {};
    const host = {
      getItem: vi.fn(async () => {
        throw new Error('StateStore unavailable');
      }),
      removeItem: vi.fn(async () => undefined),
      setItem: vi.fn(async () => undefined),
    };
    const store = await import('../stores/permission-policy-store.ts');
    store.provideHostPermissionPolicyPersistence(host);

    await store.usePermissionPolicyStore.getState().setToolOverride('brainstrike.tool', 'allow');

    expect(store.usePermissionPolicyHydration.getState()).toEqual({
      error: 'StateStore unavailable',
      status: 'failed',
    });
    expect(host.setItem).not.toHaveBeenCalled();
    expect(store.usePermissionPolicySave.getState().error).toBe('StateStore unavailable');
  });
});
