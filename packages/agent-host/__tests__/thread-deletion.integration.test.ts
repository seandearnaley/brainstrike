import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { RootLock, StateStore } from '@brainstrike/state-store';
import recording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { storedHostEvent } from '../src/event-storage.js';
import { HostLogRowSchema } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';

test('authenticated Root deletion removes only its recorded thread and preserves its neighbor across reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-protocol-thread-delete-')));
  const options = {
    dbPath: join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: [root],
    stateProjection: {
      mode: 'dev',
      module: new URL('../dist/state-projection.js', import.meta.url).href,
    },
    stateRoot: root,
  } as const;
  const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
  let native: Awaited<ReturnType<typeof openIndexer>> | undefined;
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    const captured = z.array(HostLogRowSchema).parse(recording);
    const target = captured[0]?.threadId;
    if (!target) {
      throw new Error('Core recording requires a thread');
    }
    const seed = await StateStore.open(root);
    try {
      await seed.append(captured.map((row) => storedHostEvent(row.threadId, row.event)));
    } finally {
      await seed.close();
    }
    const open = (): Promise<AgentHost> =>
      startAgentHost({ lifetime: 'persistent', root }, async (context) => {
        await context.register(async () => native?.close());
        native = await openIndexer(options, deadlines);
        return {
          close: async () => native?.close(),
          maxSteps: 1,
          readPermissionPolicy: () => ({
            policies: { ...DEFAULT_PERMISSION_POLICIES },
            yolo: false,
          }),
          resolveModel: async () => {
            throw new Error('Recorded deletion must not invoke a model');
          },
          stateIndexer: createStateStoreIndexer(native),
          tools: {},
        };
      });
    host = await open();
    client = await attachAgentHost(host.record);
    const { threadId: neighbor } = await client.request('thread/start', {
      commandId: randomUUID(),
    });
    const before = await client.request('thread/read', { fromSeq: 0, threadId: neighbor });
    expect(before.rows.length).toBeGreaterThan(0);
    await native?.catchUpState([target, neighbor]);
    expect((await native?.stateStats(target))?.docs).toBeGreaterThan(0);
    const ledgerThreads = async (): Promise<string[]> =>
      (await client?.request('ledger/read', {}))?.threads.map(({ threadId }) => threadId) ?? [];
    expect((await ledgerThreads()).sort()).toEqual([target, neighbor].sort());
    const deleted = { deleted: true, threadIds: [target] };
    expect(await client.request('thread/delete', { threadId: target })).toEqual(deleted);
    expect(await client.request('thread/delete', { threadId: target })).toEqual(deleted);
    // Core's cost-view ledger forgets the deleted thread with its log.
    expect(await ledgerThreads()).toEqual([neighbor]);
    expect((await client.request('thread/list', {})).threads).not.toContainEqual({
      threadId: target,
    });
    expect(await client.request('thread/read', { fromSeq: 0, threadId: neighbor })).toEqual(before);
    await expect(client.request('thread/read', { fromSeq: 0, threadId: target })).rejects.toThrow(
      'Unknown thread'
    );
    expect(await native?.stateStats(target)).toMatchObject({ docs: 0 });
    await expect(client.request('thread/delete', { threadId: 'unowned-thread' })).rejects.toThrow(
      'Unknown thread'
    );
    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    const lock = await RootLock.acquire(root);
    lock.release();
    host = await open();
    client = await attachAgentHost(host.record);
    expect((await client.request('thread/list', {})).threads).not.toContainEqual({
      threadId: target,
    });
    expect(await client.request('thread/read', { fromSeq: 0, threadId: neighbor })).toEqual(before);
    expect(await native?.stateStats(target)).toMatchObject({ docs: 0 });
  } finally {
    await client?.close();
    await host?.close();
    await native?.close();
    await rm(root, { force: true, recursive: true });
  }
});
