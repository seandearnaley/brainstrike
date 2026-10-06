import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { HostCore, type HostEventStore } from '../src/core.js';
import { scriptedModel } from './fixtures/scripted-model.js';

// BST-1977: OPEN third-repair defect. Opt-in repro is not a quarantine waiver.
test.skipIf(process.env['BRAINSTRIKE_M3_STOP_ACCEPTANCE_REPRO'] !== '1')(
  'a completed-run Stop acceptance failure remains failed and reserves its command identity',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-completed-stop-'));
    const store = await StateStore.open(root);
    const failure = new Error('completed Stop acceptance rejected');
    let attempts = 0;
    const port: HostEventStore = {
      append: (items, committed, durability) => {
        if (
          items.some(
            (item) => item.event.type === 'command.accepted' && item.event['method'] === 'run/stop'
          )
        ) {
          attempts += 1;
          return Promise.reject(failure);
        }
        return store.append(items, committed, durability);
      },
      read: (threadId, fromSeq) => store.read(threadId, fromSeq),
      root: store.root,
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
      const [repeated] = await Promise.allSettled([core.stop({ commandId, runId, threadId })]);
      const [reuse] = await Promise.allSettled([core.startThread({ commandId })]);
      await writeFile(
        '/tmp/brainstrike-m3-completed-stop-repro.json',
        JSON.stringify(
          {
            attempts,
            commandId,
            conflictingReuse:
              reuse?.status === 'fulfilled'
                ? { status: reuse.status, value: reuse.value }
                : { status: reuse?.status },
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
      expect(reuse?.status).toBe('rejected');
      expect(attempts).toBe(1);
    } finally {
      await core.close();
      await store.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);
