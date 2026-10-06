import { randomUUID } from 'node:crypto';
import type { PathLike } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

test('startup cancellation fences an authenticated pending decision before publication acknowledges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-abort-admission-'));
  const target = join(await realpath(root), 'host.json');
  const renamed = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<void>();
  const controller = new AbortController();
  let runAborted = false;
  let client: HostClient | undefined;
  publication.afterRename = async (path) => {
    if (String(path) === target) {
      renamed.resolve();
      await acknowledged.promise;
    }
  };
  const opening = startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: () => joined.promise,
      maxSteps: 3,
      openRun: async ({ signal }) => {
        signal.addEventListener(
          'abort',
          () => {
            runAborted = true;
          },
          { once: true }
        );
        return { close: async () => undefined };
      },
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => scriptedModel('write_file'),
      tools: {
        write_file: {
          description: 'Real write after a committed approval',
          execute: async () => {
            await writeFile(join(root, 'must-not-execute'), 'unfenced startup');
            return { wrote: true };
          },
          identity: 'native',
          inputSchema: z.object({ text: z.string() }),
          risk: 'edit',
        },
      },
    },
    controller.signal
  );
  opening.catch(() => undefined);
  try {
    await renamed.promise;
    const record = decodeHostRecord(JSON.parse(await readFile(target, 'utf8')));
    client = await attachAgentHost(record);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Use the tool',
      threadId,
    });
    let interactionId: string | undefined;
    await expect
      .poll(async () => {
        const pending = (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows
          .map((row) => row.event)
          .find((event) => event.type === 'interaction.requested');
        interactionId = pending?.interactionId;
        return interactionId !== undefined;
      })
      .toBe(true);
    if (!interactionId) {
      throw new Error('Expected pending approval');
    }
    controller.abort(new Error('Recorded startup abort at publication'));
    await expect(
      client.request('interaction/respond', {
        commandId: randomUUID(),
        decision: 'approve',
        interactionId,
        runId,
        threadId,
      })
    ).rejects.toThrow('closing');
    expect(runAborted).toBe(true);
    await expect(readFile(join(root, 'must-not-execute'))).rejects.toThrow();
    const rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(rows.some((row) => row.event.type === 'interaction.responded')).toBe(false);
    expect(rows.some((row) => row.event.type === 'effect.started')).toBe(false);
    await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
    acknowledged.resolve();
    await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
    joined.resolve();
    await expect(opening).rejects.toThrow('Recorded startup abort');
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
  } finally {
    joined.resolve();
    acknowledged.resolve();
    publication.afterRename = undefined;
    await client?.close();
    await opening.then(
      (host) => host.close(),
      () => undefined
    );
    await rm(root, { force: true, recursive: true });
  }
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
