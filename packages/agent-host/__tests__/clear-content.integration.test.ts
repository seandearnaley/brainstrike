import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

test('parent terminal clear joins Core and platform before deleting content on the original writer', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-clear-content-')));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let store: StateStore | undefined;
  const host = await startAgentHost({ lifetime: 'persistent', root }, (context) => {
    store = context.store;
    return {
      close: async () => {
        entered.resolve();
        await release.promise;
      },
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => scriptedModel(),
      tools: {},
    };
  });
  try {
    if (!store) {
      throw new Error('Existing host writer unavailable');
    }
    await store.setSetting('retained', 'configuration');
    const { threadId } = await host.core.startThread({ commandId: randomUUID() });
    const clearing = host.clearAndRetireContent();
    await entered.promise;
    expect(RootLock.inspect(root)?.owner.released).not.toBe(true);
    expect((await store.read(threadId)).length).toBeGreaterThan(0);
    await expect(host.core.startThread({ commandId: randomUUID() })).rejects.toThrow();
    release.resolve();
    expect(await clearing).toEqual({ deletedChunks: 0, deletedFiles: 0 });
    await host.closed;
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    const reopened = await StateStore.open(root);
    try {
      expect(await reopened.read(threadId)).toEqual([]);
      expect(await reopened.getSetting('retained')).toBe('configuration');
    } finally {
      await reopened.close();
    }
  } finally {
    release.resolve();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});
