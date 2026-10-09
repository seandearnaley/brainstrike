import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  HOST_METHOD_SCHEMAS,
  HOST_RESULT_SCHEMAS,
  type HostMethod,
  type HostParams,
  type HostResults,
} from '@brainstrike/agent-host/protocol';
import { describe, expect, it, vi } from 'vitest';
import { hostPermissionPolicyPersistence } from '../renderer/host-permission-policy';

const SAVED = {
  enforce: true,
  perToolOverrides: {},
  policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
  yolo: false,
} as const;

/** One host connection keeping the saved policy, through the wire schemas. */
function host() {
  let saved: HostResults['permissions/policy/read']['policy'] = null;
  const closed = Promise.withResolvers<void>();
  const requests: string[] = [];
  const client = {
    closed: closed.promise,
    request: async <M extends HostMethod>(method: M, params: HostParams<M>) => {
      requests.push(method);
      const parsed = HOST_METHOD_SCHEMAS[method].parse(params);
      if (method === 'permissions/policy/write') {
        saved = (parsed as HostParams<'permissions/policy/write'>).policy;
      }
      return HOST_RESULT_SCHEMAS[method].parse({ policy: saved }) as HostResults[M];
    },
  } as unknown as HostClient;
  return { client, close: () => closed.resolve(), requests };
}

/** BST-1930 stage e: the desktop's policy store persists to the agent host. */
describe('the desktop permission policy persistence', () => {
  it('writes the saved slice to the host and reads it back in the store envelope', async () => {
    const owner = host();
    const connect = vi.fn(async () => owner.client);
    const storage = hostPermissionPolicyPersistence(connect, 2);

    await expect(storage.getItem('permission-policy.v1')).resolves.toBeNull();
    await storage.setItem('permission-policy.v1', JSON.stringify({ state: SAVED, version: 2 }));
    await expect(storage.getItem('permission-policy.v1')).resolves.toBe(
      JSON.stringify({ state: SAVED, version: 2 })
    );
    await storage.removeItem('permission-policy.v1');
    await expect(storage.getItem('permission-policy.v1')).resolves.toBeNull();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('refuses a malformed slice before it reaches the host', async () => {
    const owner = host();
    const storage = hostPermissionPolicyPersistence(async () => owner.client, 2);

    await expect(
      storage.setItem(
        'permission-policy.v1',
        JSON.stringify({ state: { ...SAVED, yolo: 'sometimes' }, version: 2 })
      )
    ).rejects.toThrow();
    expect(owner.requests).toEqual([]);
  });

  it('connects again after its host went away', async () => {
    const first = host();
    const second = host();
    const connect = vi
      .fn<() => Promise<HostClient>>()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const storage = hostPermissionPolicyPersistence(connect, 2);

    await storage.getItem('permission-policy.v1');
    first.close();
    await vi.waitFor(async () => {
      await storage.getItem('permission-policy.v1');
      expect(connect).toHaveBeenCalledTimes(2);
    });
    expect(second.requests).toContain('permissions/policy/read');
  });
});
