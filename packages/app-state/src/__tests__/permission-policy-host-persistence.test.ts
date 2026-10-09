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
    const store = await import('../stores/permission-policy-store');
    // Before the client provides its persistence, nothing is read or written.
    await Promise.resolve();
    expect(host.getItem).not.toHaveBeenCalled();

    store.provideHostPermissionPolicyPersistence(host);
    await vi.waitFor(() =>
      expect(store.usePermissionPolicyStore.getState().policies.edit).toBe('deny')
    );
    store.usePermissionPolicyStore.getState().setCategoryPolicy('execute', 'deny');
    await vi.waitFor(() =>
      expect(JSON.parse(values.get('permission-policy.v1') ?? '{}')).toMatchObject({
        state: { policies: { edit: 'deny', execute: 'deny' } },
        version: store.PERMISSION_POLICY_STORE_VERSION,
      })
    );
    expect(local).not.toHaveBeenCalledWith('permission-policy.v1', expect.anything());
  });
});
