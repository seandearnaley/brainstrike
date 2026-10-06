import { randomUUID } from 'node:crypto';
import type { PathLike } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const publication = vi.hoisted(() => ({
  afterRename: undefined as ((target: PathLike) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>): Promise<void> => {
      await actual.rename(...args);
      await publication.afterRename?.(args[1]);
    },
  };
});

// BST-1977: retained publication-race regression, authorized causal repair.
test('an acknowledged run retains the real lease while startup publication acknowledgement is held', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-publication-'));
  const target = join(await realpath(root), 'host.json');
  const renamed = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  publication.afterRename = async (path) => {
    if (String(path) === target) {
      renamed.resolve();
      await acknowledged.promise;
    }
  };
  let closed = false;
  const clients: HostClient[] = [];
  const opening = startAgentHost(
    { lifetime: 'cli', root },
    {
      close: async () => {
        closed = true;
      },
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => scriptedModel('write_file'),
      tools: {
        write_file: {
          description: 'Existing approval boundary',
          execute: async () => ({ wrote: true }),
          identity: 'native',
          inputSchema: z.object({ text: z.string() }),
          risk: 'edit',
        },
      },
    }
  );
  try {
    await renamed.promise;
    const record = decodeHostRecord(JSON.parse(await readFile(target, 'utf8')));
    const client = await attachAgentHost(record);
    clients.push(client);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Use the tool',
      threadId,
    });
    await expect
      .poll(async () =>
        (await client.request('thread/read', { fromSeq: 0, threadId })).rows.some(
          (row) => row.event.type === 'interaction.requested'
        )
      )
      .toBe(true);
    await client.close();
    // A new authenticated round trip proves the socket/root actor survived the last-client departure.
    const joined = await attachAgentHost(record);
    clients.push(joined);
    try {
      expect(
        (await joined.request('thread/read', { fromSeq: 0, threadId })).rows.some(
          (row) => row.event.type === 'run.finished'
        )
      ).toBe(false);
      expect(closed).toBe(false);
      const owner = RootLock.inspect(root)?.owner;
      expect(owner).toMatchObject({ pid: record.pid, start: record.start });
      // LockOwner.released is optional and absent for an active generation.
      expect(owner?.released ?? false).toBe(false);
      await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
      acknowledged.resolve();
      const host = await opening;
      await joined.request('run/stop', { commandId: randomUUID(), runId, threadId });
      await joined.close();
      await host.closed;
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
    } finally {
      await joined.close();
    }
  } finally {
    acknowledged.resolve();
    publication.afterRename = undefined;
    await Promise.all(clients.map((client) => client.close()));
    await opening.then(
      (host) => host.close(),
      () => undefined
    );
    await rm(root, { force: true, recursive: true });
  }
});
