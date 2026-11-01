import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type { HostMethodHandler } from '../src/auth-connection.js';
import {
  bindHostBrowserOriginMethods,
  type HostBrowserOriginStore,
  readHostBrowserOrigins,
  removeHostBrowserOrigin,
  saveHostBrowserOrigin,
} from '../src/browser-origin-answers.js';
import type { HostClientOrigin } from '../src/ports.js';
import { HOST_METHOD_SCHEMAS, type HostMethod } from '../src/protocol.js';

/** The StateStore's settings, in memory. */
function settings(): HostBrowserOriginStore & {
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
function bound(store: HostBrowserOriginStore, origin: HostClientOrigin) {
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
          })(params) as never,
          new AbortController().signal
        )
    );
  };
  bindHostBrowserOriginMethods(handle, store, origin);
  return handlers;
}
/** BST-1178: the host keeps each browser origin's saved answer in its StateStore. */
describe('saved browser origins', () => {
  it('saves, lists and removes answers; an empty set leaves no setting', async () => {
    const store = settings();
    await saveHostBrowserOrigin(store, 'https://example.com', 'allow');
    await saveHostBrowserOrigin(store, 'http://localhost:5173', 'deny');
    const handlers = bound(store, 'desktop-ui');
    await expect(handlers.get('permissions/origins/read')?.({})).resolves.toEqual({
      origins: { 'http://localhost:5173': 'deny', 'https://example.com': 'allow' },
    });
    await expect(
      handlers.get('permissions/origins/remove')?.({ origin: 'https://example.com' })
    ).resolves.toEqual({ removed: true });
    await expect(
      handlers.get('permissions/origins/remove')?.({ origin: 'https://example.com' })
    ).resolves.toEqual({ removed: false });
    await removeHostBrowserOrigin(store, 'http://localhost:5173');
    expect(store.values.size).toBe(0);
    await expect(readHostBrowserOrigins(store)).resolves.toEqual({});
  });

  it('applies concurrent changes one at a time, dropping none', async () => {
    const store = settings();
    await Promise.all([
      saveHostBrowserOrigin(store, 'https://a.example', 'allow'),
      saveHostBrowserOrigin(store, 'https://b.example', 'deny'),
      saveHostBrowserOrigin(store, 'https://c.example', 'allow'),
    ]);
    await expect(readHostBrowserOrigins(store)).resolves.toEqual({
      'https://a.example': 'allow',
      'https://b.example': 'deny',
      'https://c.example': 'allow',
    });
  });

  it('accepts only an exact http(s) origin', async () => {
    const handlers = bound(settings(), 'desktop-ui');
    for (const origin of ['https://example.com/', 'https://example.com/a', 'file:///tmp', 'x']) {
      await expect(handlers.get('permissions/origins/remove')?.({ origin })).rejects.toThrow();
    }
    await expect(
      saveHostBrowserOrigin(settings(), 'https://example.com/a', 'allow')
    ).rejects.toThrow('Expected an http(s) origin');
  });

  it("is reachable only from the desktop's private client", async () => {
    const store = settings();
    await saveHostBrowserOrigin(store, 'https://example.com', 'allow');
    const handlers = bound(store, 'public-socket');
    await expect(handlers.get('permissions/origins/read')?.({})).rejects.toThrow(
      "Saved browser origins are available only to the desktop's private client"
    );
    await expect(
      handlers.get('permissions/origins/remove')?.({ origin: 'https://example.com' })
    ).rejects.toThrow("Saved browser origins are available only to the desktop's private client");
    await expect(readHostBrowserOrigins(store)).resolves.toEqual({
      'https://example.com': 'allow',
    });
  });
});
