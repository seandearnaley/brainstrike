import { DEFAULT_INDEX_CONFIG } from '@brainstrike/assistant-contract/index-config';
import { describe, expect, it, vi } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostMethodHandler } from '../src/auth-connection.js';
import type { HostClientOrigin, HostWorkspaceIndex } from '../src/ports.js';
import {
  type HostMethod,
  parseHostParams,
  WORKSPACE_INDEX_EVENT,
  type WorkspaceIndexEvent,
} from '../src/protocol.js';
import { bindHostWorkspaceIndexMethods } from '../src/workspace-index-connection.js';

function bound(index: HostWorkspaceIndex | undefined, origin: HostClientOrigin) {
  const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
  const handle: HostMethodHandler = (method, request) => {
    handlers.set(method, async (params) => await request(params as never));
  };
  const sendNotification = vi.fn(async () => undefined);
  const binding = bindHostWorkspaceIndexMethods(
    handle,
    { dispose: vi.fn(), sendNotification } as unknown as MessageConnection,
    index,
    origin
  );
  return { binding, handlers, sendNotification };
}

function index() {
  const listeners = new Set<(event: WorkspaceIndexEvent) => void>();
  const owner: HostWorkspaceIndex = {
    'index/config/read': vi.fn(async () => DEFAULT_INDEX_CONFIG),
    'index/config/update': vi.fn(async () => DEFAULT_INDEX_CONFIG),
    'index/coverage': vi.fn(),
    'index/coverage-batch': vi.fn(),
    'index/file-chunks': vi.fn(),
    'index/grep': vi.fn(),
    'index/rebuild': vi.fn(async () => ({})),
    'index/retry': vi.fn(async () => ({})),
    'index/roots-registered': vi.fn(async () => ({})),
    'index/search': vi.fn(),
    'index/status': vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'Preparing' })),
    subscribe: vi.fn((listener: (event: WorkspaceIndexEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const publish = (event: WorkspaceIndexEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  return { owner, publish };
}

const CONFIG_CHANGED: WorkspaceIndexEvent = {
  config: { ...DEFAULT_INDEX_CONFIG, mode: 'off' },
  type: 'config',
};

/** ADR-0029 stage 4: the search index is the desktop user's, and only a subscriber hears it. */
describe('host workspace index methods', () => {
  it('pushes index changes only to the connections that subscribed, until each closes', async () => {
    const service = index();
    const subscribed = bound(service.owner, 'desktop-ui');
    const quiet = bound(service.owner, 'desktop-ui');

    await expect(subscribed.handlers.get('index/subscribe')?.({})).resolves.toEqual({
      subscribed: true,
    });
    await subscribed.handlers.get('index/subscribe')?.({});
    await expect(quiet.handlers.get('index/status')?.({})).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Preparing',
    });
    service.publish(CONFIG_CHANGED);
    subscribed.binding.dispose();
    service.publish({ config: DEFAULT_INDEX_CONFIG, type: 'config' });

    expect(subscribed.sendNotification).toHaveBeenCalledOnce();
    expect(subscribed.sendNotification).toHaveBeenCalledWith(WORKSPACE_INDEX_EVENT, CONFIG_CHANGED);
    expect(quiet.sendNotification).not.toHaveBeenCalled();
  });

  it('answers a status in its wire shape, without fields the client cannot read', async () => {
    const service = index();
    vi.mocked(service.owner['index/status']).mockResolvedValueOnce({
      kind: 'unavailable',
      reason: 'Preparing',
      ...{ nativeDiagnostics: 'private' },
    });
    const { handlers } = bound(service.owner, 'desktop-ui');

    await expect(handlers.get('index/status')?.({})).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Preparing',
    });
  });

  it('refuses every index method to a public-socket client', async () => {
    const service = index();
    const { handlers } = bound(service.owner, 'public-socket');

    for (const method of [
      'index/config/read',
      'index/config/update',
      'index/coverage',
      'index/coverage-batch',
      'index/file-chunks',
      'index/grep',
      'index/rebuild',
      'index/retry',
      'index/roots-registered',
      'index/search',
      'index/status',
      'index/subscribe',
    ] as const) {
      await expect(handlers.get(method)?.({})).rejects.toThrow(
        "The search index is available only to the desktop's private client"
      );
    }
    expect(service.owner.subscribe).not.toHaveBeenCalled();
    expect(service.owner['index/status']).not.toHaveBeenCalled();
  });

  it('refuses a desktop client when this host has no search index', async () => {
    const { handlers } = bound(undefined, 'desktop-ui');

    await expect(handlers.get('index/status')?.({})).rejects.toThrow(
      'The search index is unavailable on this host'
    );
  });
});

/** The requests the desktop's index IPC refused are refused before they reach the index. */
describe('workspace index requests', () => {
  const profile = {
    dimensions: 3,
    dtype: 'q8',
    modelId: 'Xenova/bge-small-en-v1.5',
    revision: 'a'.repeat(40),
  } as const;
  const vector = { limit: 10, mode: 'vector', profile, rootIds: ['root'], vector: [1, 0, 0.5] };

  it('accepts a whole vector search and refuses one that does not match its profile', () => {
    expect(parseHostParams('index/search', vector)).toEqual(vector);
    for (const invalid of [
      { vector: [1, 0] },
      { vector: [1, 0, Number.NaN] },
      { profile: { ...profile, revision: 'main' } },
      { profile: { ...profile, distance: 'cosine' } },
      { profile: { ...profile, unexpected: true } },
    ]) {
      expect(() => parseHostParams('index/search', { ...vector, ...invalid })).toThrow();
    }
  });

  it('refuses repeated or blank roots, an out-of-range limit and oversized path lists', () => {
    const text = { limit: 10, mode: 'bm25', rootIds: ['root'], text: 'needle' };
    expect(parseHostParams('index/search', text)).toEqual(text);
    for (const invalid of [{ rootIds: ['root', 'root'] }, { rootIds: [' '] }, { limit: 101 }]) {
      expect(() => parseHostParams('index/search', { ...text, ...invalid })).toThrow();
    }
    expect(() => parseHostParams('index/coverage-batch', { requests: [] })).toThrow();
    expect(() =>
      parseHostParams('index/file-chunks', {
        paths: new Array<string>(101).fill('a.ts'),
        rootId: 'root',
      })
    ).toThrow();
    expect(() =>
      parseHostParams('index/grep', {
        caseSensitive: false,
        filePaths: new Array<string>(1001).fill('a.ts'),
        isRegex: false,
        limit: 10,
        pattern: 'needle',
        rootIds: ['root'],
      })
    ).toThrow();
  });
});
