import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { ensureMockWorkspaceOpen } from './layout-helpers';
import { callIndexSearch, nativeStatus, textReadiness } from './text-search-mode';

const MARKER = 'Native reset indexed marker';

/** The indexed probe file's identity. */
export interface NativeResetProbe {
  readonly indexedFileId: string;
}

/** With no folder the index holds no files, so there is no search to run. */
export type NativeResetProbeReading =
  | { readonly folders: 0 }
  | { readonly folders: number; readonly retainedProbeIds: readonly string[] };

async function searchMarker(page: Page, rootIds: readonly string[]) {
  return await callIndexSearch(page, 'search', {
    limit: 10,
    mode: 'bm25',
    rootIds: [...rootIds],
    text: MARKER,
  });
}

/** Current desktop proof: a real folder's file, indexed and found by text search. */
export async function seedNativeResetProbe(
  page: Page,
  workspacePath: string
): Promise<NativeResetProbe> {
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
  const status = await nativeStatus(page);
  if (status.kind !== 'ready') {
    throw new Error(status.reason);
  }
  const result = await searchMarker(page, status.authorizedRootIds);
  const hit = result.hits.find(
    (candidate) =>
      candidate.relativePath === 'reset-indexed-probe.txt' && candidate.content.includes(MARKER)
  );
  if (!hit) {
    throw new Error('Text search did not find the indexed reset probe');
  }
  return { indexedFileId: hit.fileId };
}

/** The index's folders and, when it has any, whether its search still finds the probe file. */
export async function readNativeResetProbe(
  page: Page,
  probe: NativeResetProbe
): Promise<NativeResetProbeReading> {
  // A reset or restart replaces the index: wait for the replacement to answer.
  await expect.poll(async () => (await nativeStatus(page)).kind, { timeout: 60_000 }).toBe('ready');
  const status = await nativeStatus(page);
  if (status.kind !== 'ready') {
    throw new Error(status.reason);
  }
  if (status.authorizedRootIds.length === 0) {
    return { folders: 0 };
  }
  const result = await searchMarker(page, status.authorizedRootIds);
  return {
    folders: status.authorizedRootIds.length,
    retainedProbeIds: [
      ...new Set(
        result.hits.filter((hit) => hit.fileId === probe.indexedFileId).map((hit) => hit.fileId)
      ),
    ],
  };
}
