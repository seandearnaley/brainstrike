// @vitest-environment node
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import { readNativeSnapshot } from '../../qualification/m2-native/candidate';
import { unwrapIpcResult } from '../platform/ipc-bridge';
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
    embeddingHost: { getStatus: vi.fn() },
    indexSearch: {
      coverageBatch: () =>
        failure.code === 'native-coverage-observation-invalidated'
          ? Promise.resolve({ code: failure.code, kind: 'invalidated' })
          : Promise.resolve().then(() =>
              unwrapIpcResult(
                'index-search:coverage-batch',
                ipcFailure(failure.category, failure.code, 'Rejected observation')
              )
            ),
      status: () => Promise.resolve(status),
    },
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
    code: 'native-coverage-observation-invalidated',
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
  ).rejects.toThrow('Rejected observation (native-index · native-index-failed)');
});
