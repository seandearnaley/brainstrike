import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type { HostMethodHandler } from '../src/auth-connection.js';
import {
  bindHostPermissionPolicyMethods,
  type HostPermissionPolicyStore,
  hostPermissionGate,
  readHostPermissionPolicy,
} from '../src/permission-policy.js';
import type { HostClientOrigin } from '../src/ports.js';
import { HOST_METHOD_SCHEMAS, type HostMethod } from '../src/protocol.js';

const SAVED = {
  enforce: true,
  perToolOverrides: { 'brainstrike.shell': 'allow' },
  policies: { edit: 'ask', execute: 'deny', mcp: 'allow', read: 'allow' },
  yolo: false,
} as const;
/** The StateStore's settings, in memory. */
function settings(): HostPermissionPolicyStore & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    deleteSetting: async (key) => values.delete(key),
    getSetting: async (key) => values.get(key),
    setSetting: async (key, value) => {
      values.set(key, value);
    },
    values,
  };
}
function bound(store: HostPermissionPolicyStore, origin: HostClientOrigin) {
  const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
  const handle: HostMethodHandler = (method, request) => {
    handlers.set(
      method,
      async (params) =>
        // The wire parses each request before its handler sees it.
        await request(
          Schema.decodeUnknownSync(HOST_METHOD_SCHEMAS[method], {
            errors: 'all',
            onExcessProperty: 'error',
          })(params) as never
        )
    );
  };
  bindHostPermissionPolicyMethods(handle, store, origin);
  return handlers;
}
/** BST-1930 stage e: the agent host owns the permission policy the user saved. */
describe('host permission policy', () => {
  it("keeps the desktop's saved policy in the host StateStore, and clears it", async () => {
    const store = settings();
    const handlers = bound(store, 'desktop-ui');
    await expect(handlers.get('permissions/policy/read')?.({})).resolves.toEqual({ policy: null });
    await expect(handlers.get('permissions/policy/write')?.({ policy: SAVED })).resolves.toEqual({
      policy: SAVED,
    });
    await expect(readHostPermissionPolicy(store)).resolves.toEqual(SAVED);
    await expect(handlers.get('permissions/policy/read')?.({})).resolves.toEqual({
      policy: SAVED,
    });
    await handlers.get('permissions/policy/write')?.({ policy: null });
    await expect(readHostPermissionPolicy(store)).resolves.toBeNull();
    expect(store.values.size).toBe(0);
  });
  it('refuses a malformed policy and every public-socket client', async () => {
    const store = settings();
    await expect(
      bound(store, 'desktop-ui').get('permissions/policy/write')?.({
        policy: { ...SAVED, policies: { ...SAVED.policies, edit: 'sometimes' } },
      })
    ).rejects.toThrow();
    const cli = bound(store, 'public-socket');
    for (const [method, params] of [
      ['permissions/policy/read', {}],
      ['permissions/policy/write', { policy: SAVED }],
    ] as const) {
      await expect(cli.get(method)?.(params)).rejects.toThrow(
        "The permission policy is available only to the desktop's private client"
      );
    }
    expect(store.values.size).toBe(0);
  });
  it('gates as the user saved it: enforcement off allows everything', () => {
    expect(hostPermissionGate(SAVED)).toEqual({
      perToolOverrides: { 'brainstrike.shell': 'allow' },
      policies: SAVED.policies,
      yolo: false,
    });
    expect(hostPermissionGate({ ...SAVED, enforce: false, perToolOverrides: {} })).toEqual({
      policies: SAVED.policies,
      yolo: true,
    });
  });
});
