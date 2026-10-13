// @vitest-environment node

import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import { readNativeSnapshot } from '../../qualification/m2-native/candidate';
import { ipcFailure } from '../platform/ipc-contract';

afterEach(() => vi.unstubAllGlobals());

function context(failure: {
  readonly category: string;
  readonly code: string;
}): ElectronAppContext {
  const status: Awaited<ReturnType<IndexSearchCapability['status']>> = {
    authorizedRootIds: ['root'],
    embedding: { indexMode: 'text-only' },
    kind: 'ready',
    rootReadiness: [{ rootId: 'root', scanComplete: false }],
    storeId: 'a'.repeat(64),
  };
  vi.stubGlobal('window', {
    __brainstrikeTestHooks__: {
      indexSearch: {
        coverageBatch: () =>
          failure.code === 'native-coverage-observation-invalidated'
            ? Promise.resolve({ code: failure.code, kind: 'invalidated' })
            : Promise.resolve().then(() => readBoundaryResult(ipcFailure(INTERNAL_FAULT))),
        status: () => Promise.resolve(status),
      },
    },
    embeddingHost: { getStatus: vi.fn() },
  });
  return {
    window: {
      evaluate: async (read: (code: string) => Promise<unknown>, code: string) => {
        try {
          return JSON.parse(JSON.stringify(await read(code))) as unknown;
        } catch (error) {
          // Playwright reconstructs thrown page errors without custom code/category properties.
          throw new Error(
            `page.evaluate: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
    },
  } as unknown as ElectronAppContext;
}

it('keeps direct reads rejecting while preserving the classified public failure across the page boundary', async () => {
  await expect(
    readNativeSnapshot(
      context({
        category: 'native-index',
        code: 'native-coverage-observation-invalidated',
      })
    )
  ).rejects.toMatchObject({
    code: 'native-index-transitioning',
    message: 'Native source or saved profile changed during search.',
  });
});

it('does not reclassify unrelated public failures as invalid observations', async () => {
  await expect(
    readNativeSnapshot(
      context({
        category: 'native-index',
        code: 'native-index-failed',
      })
    )
  ).rejects.toThrow(INTERNAL_FAULT.message);
});
