import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { HostCore, type HostEventStore } from '../src/core.js';
import { scriptedModel } from './fixtures/scripted-model.js';

// BST-1977: retained failed-command regression, authorized causal repair.
test.each(['before commit', 'after commit'] as const)(
  'a completed-run Stop acceptance failure %s remains failed and reserves its command identity',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-completed-stop-'));
    const store = await StateStore.open(root);
    const failure = new Error('completed Stop acceptance rejected');
    let attempts = 0;
    const port: HostEventStore = {
      append: async (items, committed, durability) => {
        if (
          items.some(
            (item) => item.event.type === 'command.accepted' && item.event['method'] === 'run/stop'
          )
        ) {
          attempts += 1;
          if (mode === 'after commit') {
            await store.append(items, committed, durability);
          }
          throw failure;
        }
        return store.append(items, committed, durability);
      },
      deleteSetting: (key) => store.deleteSetting(key),
      getSetting: (key) => store.getSetting(key),
      read: (threadId, fromSeq) => store.read(threadId, fromSeq),
      root: store.root,
      setSetting: (key, value) => store.setSetting(key, value),
      syncBoundary: (threadId) => store.syncBoundary(threadId),
      threads: () => store.threads(),
    };
    const core = await HostCore.open(
      port,
      {
        close: async () => undefined,
        maxSteps: 3,
        readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
        resolveModel: async () => scriptedModel(),
        tools: {},
      },
      () => () => undefined
    );
    try {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Complete this run',
        threadId,
      });
      await expect
        .poll(async () =>
          (await core.read(threadId, 0)).some((row) => row.event.type === 'run.finished')
        )
        .toBe(true);
      const commandId = randomUUID();
      await expect(core.stop({ commandId, runId, threadId })).rejects.toBe(failure);
      const [repeated, concurrent] = await Promise.allSettled([
        core.stop({ commandId, runId, threadId }),
        core.stop({ commandId, runId, threadId }),
      ]);
      const [reuse] = await Promise.allSettled([core.startThread({ commandId })]);
      await expect(core.stop({ commandId: randomUUID(), runId, threadId })).rejects.toBe(failure);
      const committedStops = (await core.read(threadId, 0)).filter(
        (row) => row.event.type === 'command.accepted' && row.event.method === 'run/stop'
      );
      await writeFile(
        mode === 'before commit'
          ? '/tmp/brainstrike-m3-completed-stop-repro.json'
          : '/tmp/brainstrike-m3-completed-stop-after-commit-repro.json',
        JSON.stringify(
          {
            attempts,
            commandId,
            committedStops: committedStops.length,
            conflictingReuse:
              reuse?.status === 'fulfilled'
                ? { status: reuse.status, value: reuse.value }
                : { status: reuse?.status },
            mode,
            repeated:
              repeated?.status === 'fulfilled'
                ? { status: repeated.status, value: repeated.value }
                : { status: repeated?.status },
          },
          null,
          2
        )
      );
      expect(repeated?.status).toBe('rejected');
      expect(concurrent?.status).toBe('rejected');
      expect(reuse?.status).toBe('rejected');
      expect(attempts).toBe(1);
      expect(committedStops).toHaveLength(mode === 'after commit' ? 1 : 0);
      await core.close();
      const restored = await HostCore.open(
        port,
        {
          close: async () => undefined,
          maxSteps: 3,
          readPermissionPolicy: () => ({
            policies: { ...DEFAULT_PERMISSION_POLICIES },
            yolo: false,
          }),
          resolveModel: async () => scriptedModel(),
          tools: {},
        },
        () => () => undefined
      );
      try {
        if (mode === 'after commit') {
          await expect(restored.stop({ commandId, runId, threadId })).resolves.toEqual({
            outcome: 'already-terminal',
          });
          expect(attempts).toBe(1);
        } else {
          // Uncommitted process-local attempts are not invented during restoration.
          await expect(restored.startThread({ commandId })).resolves.toHaveProperty('threadId');
        }
      } finally {
        await restored.close();
      }
    } finally {
      await core.close();
      await store.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);
