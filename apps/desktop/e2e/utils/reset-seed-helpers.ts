import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from '@playwright/test';

const MARKER = 'Native reset indexed marker';

type IndexHooks = typeof globalThis & {
  readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
};

/** The indexed probe file's identity. */
export interface NativeResetProbe {
  readonly indexedFileId: string;
}

/** Current desktop proof: a real folder's file, indexed and found by text search. */
export async function seedNativeResetProbe(
  page: Page,
  workspacePath: string
): Promise<NativeResetProbe> {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { expect } = await import('@playwright/test');
  const { ensureMockWorkspaceOpen } = await import('./layout-helpers');
  const { textReadiness } = await import('./text-search-mode');
  if (!workspacePath) {
    throw new Error('Disposable workspace path is required');
  }
  await writeFile(join(workspacePath, 'reset-indexed-probe.txt'), `${MARKER}.\n`, 'utf8');
  // Settle the fresh profile's first Text generation before adding the folder: one still
  // opening can lease the new folder and publish its chunks, and the folder's own
  // registration then opens the next generation, which refuses reads (BST-2152).
  await expect
    .poll(() => textReadiness(page), { timeout: 60_000 })
    .toEqual({ folders: 0, indexMode: 'text-only', kind: 'ready' });
  await ensureMockWorkspaceOpen(page);
  // Adding a folder does not wait for the index; the index's status owns readiness.
  await expect
    .poll(() => textReadiness(page), { timeout: 60_000 })
    .toEqual({ folders: 1, indexMode: 'text-only', kind: 'ready' });
  return await page.evaluate(async (marker) => {
    const capability = (globalThis as IndexHooks).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('The index search capability is unavailable.');
    }
    const status = await capability.status();
    if (status.kind !== 'ready') {
      throw new Error(status.reason);
    }
    const result = await capability.search({
      limit: 10,
      mode: 'bm25',
      rootIds: [...status.authorizedRootIds],
      text: marker,
    });
    const hit = result.hits.find(
      (candidate) =>
        candidate.relativePath === 'reset-indexed-probe.txt' && candidate.content.includes(marker)
    );
    if (!hit) {
      throw new Error('Text search did not find the indexed reset probe');
    }
    return { indexedFileId: hit.fileId };
  }, MARKER);
}

/** The index's folders, and whether its search still finds the probe file. */
export async function readNativeResetProbe(
  page: Page,
  probe: NativeResetProbe
): Promise<{ folders: number; retainedProbeIds: string[] }> {
  const { expect } = await import('@playwright/test');
  const { nativeStatus } = await import('./text-search-mode');
  await expect.poll(async () => (await nativeStatus(page)).kind, { timeout: 60_000 }).toBe('ready');
  return await page.evaluate(
    async ({ indexedFileId, marker }) => {
      const capability = (globalThis as IndexHooks).__brainstrikeTestHooks__?.indexSearch;
      if (!capability) {
        throw new Error('The index search capability is unavailable.');
      }
      const status = await capability.status();
      if (status.kind !== 'ready') {
        throw new Error(status.reason);
      }
      // With no folder there is nothing to search: the index holds no files.
      if (status.authorizedRootIds.length === 0) {
        return { folders: 0, retainedProbeIds: [] };
      }
      const result = await capability.search({
        limit: 10,
        mode: 'bm25',
        rootIds: [...status.authorizedRootIds],
        text: marker,
      });
      return {
        folders: status.authorizedRootIds.length,
        retainedProbeIds: [
          ...new Set(
            result.hits.filter((hit) => hit.fileId === indexedFileId).map((hit) => hit.fileId)
          ),
        ],
      };
    },
    { indexedFileId: probe.indexedFileId, marker: MARKER }
  );
}
