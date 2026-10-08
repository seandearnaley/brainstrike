import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAskUserTool } from '@brainstrike/agent';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import recording from '@brainstrike/test-utils/fixtures/committed-host-question.json' with {
  type: 'json',
};
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import { HostLogRowSchema } from '../src/protocol.js';
import { scriptedModel } from './fixtures/scripted-model.js';

test.for([
  { cleanupFailure: false, invalidCatalog: false },
  { cleanupFailure: true, invalidCatalog: false },
  { cleanupFailure: true, invalidCatalog: true },
])(
  'deletion joins a pending admission (cleanupFailure=$cleanupFailure, invalidCatalog=$invalidCatalog)',
  async ({ cleanupFailure, invalidCatalog }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-delete-pending-admission-')));
    const native = await openIndexer(
      {
        dbPath: join(root, 'index.sqlite'),
        embedding: { indexMode: 'text-only' },
        rootIds: [root],
        stateProjection: {
          mode: 'dev',
          module: new URL('../dist/state-projection.js', import.meta.url).href,
        },
        stateRoot: root,
      },
      { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
    );
    const store = await StateStore.open(root, { indexer: createStateStoreIndexer(native) });
    const snapshot = z
      .array(HostLogRowSchema)
      .parse(recording)
      .map((row) => row.event)
      .find((event) => event.type === 'run.started')?.snapshot;
    if (!snapshot) {
      throw new Error('Recorded canonical question run has no admission snapshot');
    }
    const model = scriptedModel();
    const question = createAskUserTool();
    const inputSchema = question.inputSchema;
    if (!inputSchema) {
      throw new Error('Canonical question tool has no input schema');
    }
    const entered = Promise.withResolvers<AbortSignal>();
    const selectionReady = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const cleanupReady = Promise.withResolvers<void>();
    const failure = new Error('Admitted platform owner failed to retire');
    const closeSelection = vi.fn(async (): Promise<void> => {
      cleanupEntered.resolve();
      await cleanupReady.promise;
      if (cleanupFailure) {
        throw failure;
      }
    });
    const execute = vi.fn(async (): Promise<never> => {
      throw new Error('Deleted admission must never execute a tool');
    });
    const platform: HostPlatform = {
      admitRun: async ({ signal }) => {
        entered.resolve(signal);
        await selectionReady.promise;
        return {
          close: closeSelection,
          configuration: {},
          model,
          snapshot,
          tools: {
            brainstrike_askUser: {
              description: question.description ?? 'Ask the user',
              execute,
              identity: invalidCatalog ? 'replaced-question-owner' : 'brainstrike.askUser',
              inputSchema,
              risk: 'read',
            },
          },
        };
      },
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    };
    const core = await HostCore.open(store, platform, () => () => undefined);
    const erase = vi.spyOn(store, 'deleteThread');
    let primaryFailure: { readonly cause: unknown } | undefined;
    let closeFailure: unknown;
    try {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const original = await core.read(threadId, 0);
      const starting = core.startRun({
        commandId: randomUUID(),
        modelId: 'recorded-sdk-fixture',
        prompt: 'Ask the recorded question',
        threadId,
      });
      const startResult = Promise.allSettled([starting]);
      const signal = await entered.promise;
      const deleting = core.deleteThread({ threadId });
      const deleteResult = Promise.allSettled([deleting]);
      expect(signal.aborted).toBe(true);
      selectionReady.resolve();
      await cleanupEntered.promise;
      expect(erase).not.toHaveBeenCalled();
      expect(await core.read(threadId, 0)).toEqual(original);
      expect(RootLock.inspect(root)?.owner).toBeDefined();
      expect(RootLock.inspect(root)?.owner.released).not.toBe(true);
      cleanupReady.resolve();
      const [admission] = await startResult;
      expect(admission?.status).toBe('rejected');
      const [deletion] = await deleteResult;
      if (cleanupFailure) {
        expect(deletion?.status).toBe('rejected');
        if (deletion?.status !== 'rejected') {
          throw new Error('Deletion acknowledged failed platform retirement');
        }
        expect(deletion.reason).toBe(
          admission?.status === 'rejected' ? admission.reason : undefined
        );
        expect(erase).not.toHaveBeenCalled();
        expect(await core.read(threadId, 0)).toEqual(original);
        expect(await store.threads()).toContain(threadId);
        await expect(core.deleteThread({ threadId })).rejects.toBe(deletion.reason);
        await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
        await expect(core.close()).rejects.toBeInstanceOf(AggregateError);
      } else {
        expect(deletion).toEqual({ status: 'fulfilled', value: { deleted: true } });
        expect(erase).toHaveBeenCalledOnce();
        expect(await store.threads()).not.toContain(threadId);
      }
      expect(closeSelection).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(model.doStreamCalls).toHaveLength(0);
    } catch (cause) {
      primaryFailure = { cause };
    } finally {
      selectionReady.resolve();
      cleanupReady.resolve();
      try {
        await core.close();
      } catch (cause) {
        closeFailure = cause;
      }
      await native.close();
      await store.close();
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      await rm(root, { force: true, recursive: true });
    }
    const failures = [
      ...(primaryFailure ? [primaryFailure.cause] : []),
      ...(closeFailure && !cleanupFailure ? [closeFailure] : []),
    ];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Admission qualification and cleanup failed');
    }
  }
);
