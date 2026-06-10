import { describe, expect, it } from 'vitest';
import { resolvePlannedTokenIndexingHandles } from '../indexing/background-token-indexer-dispatch-handles';
import type { TokenIndexingDispatchPlan } from '../indexing/background-token-indexer-dispatch-planner';
import type { ElectronFileHandle, HandleInfo } from '../indexing/background-token-indexer-handles';

const webHandle = { getFile: async () => new File([''], 'web.ts') } as FileSystemFileHandle;

const electronHandle: ElectronFileHandle = {
  kind: 'file',
  name: 'electron.ts',
  path: '/repo/electron.ts',
  platform: 'electron',
};

function createPlan(overrides: Partial<TokenIndexingDispatchPlan> = {}): TokenIndexingDispatchPlan {
  return {
    electronFiles: [],
    estimatedElectronBytes: 0,
    indexedKeysToAdd: [],
    invalidPathWarnings: [],
    pendingNoHandleKeysToAdd: [],
    pendingNoHandleKeysToDelete: [],
    skipped: {
      binary: 0,
      invalidPath: 0,
      noHandle: 0,
      tooLarge: 0,
    },
    webFiles: [],
    webResolverFiles: [],
    ...overrides,
  };
}

describe('resolvePlannedTokenIndexingHandles', () => {
  it('resolves planned dispatch entries to real web and Electron handles', () => {
    const plan = createPlan({
      electronFiles: [
        {
          compositeKey: 'root|@|electron.ts',
          filePath: 'electron.ts',
          fileSize: 256,
          folderId: 'root',
        },
      ],
      webFiles: [
        {
          compositeKey: 'root|@|web.ts',
          filePath: 'web.ts',
          folderId: 'root',
        },
      ],
    });
    const handleInfoByCompositeKey = new Map<string, HandleInfo>([
      [
        'root|@|web.ts',
        {
          fileName: 'web.ts',
          fileSize: 128,
          webHandle,
        },
      ],
      [
        'root|@|electron.ts',
        {
          electronHandle,
          fileName: 'electron.ts',
          fileSize: 256,
        },
      ],
    ]);

    const queues = resolvePlannedTokenIndexingHandles({
      dispatchPlan: plan,
      handleInfoByCompositeKey,
    });

    expect(queues.webFilesToIndex).toEqual([
      {
        compositeKey: 'root|@|web.ts',
        fileHandle: webHandle,
        filePath: 'web.ts',
        folderId: 'root',
      },
    ]);
    expect(queues.electronFilesToRead).toEqual([
      {
        compositeKey: 'root|@|electron.ts',
        filePath: 'electron.ts',
        fileSize: 256,
        folderId: 'root',
        handle: electronHandle,
      },
    ]);
  });

  it('throws on planner/handle drift before dispatch queues are returned', () => {
    const plan = createPlan({
      webFiles: [
        {
          compositeKey: 'root|@|available.ts',
          filePath: 'available.ts',
          folderId: 'root',
        },
        {
          compositeKey: 'root|@|missing.ts',
          filePath: 'missing.ts',
          folderId: 'root',
        },
      ],
    });
    const handleInfoByCompositeKey = new Map<string, HandleInfo>([
      [
        'root|@|available.ts',
        {
          fileName: 'available.ts',
          fileSize: 128,
          webHandle,
        },
      ],
    ]);

    expect(() =>
      resolvePlannedTokenIndexingHandles({
        dispatchPlan: plan,
        handleInfoByCompositeKey,
      })
    ).toThrow('Missing planned web file handle for root|@|missing.ts');
  });
});
