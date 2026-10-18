import type { Page } from '@playwright/test';

/** Current desktop proof: real TEXT chunks plus independently committed imported bytes. */
export async function seedNativeResetProbe(
  page: Page,
  workspacePath: string
): Promise<{ indexedFileId: string; importedFileId: string }> {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { expect } = await import('@playwright/test');
  const { ensureMockWorkspaceOpen } = await import('./layout-helpers');
  const { chooseTextSearch, textReadiness } = await import('./text-search-mode');
  if (!workspacePath) {
    throw new Error('Disposable workspace path is required');
  }
  await writeFile(
    join(workspacePath, 'reset-indexed-probe.txt'),
    'Native reset indexed marker.\n',
    'utf8'
  );
  await chooseTextSearch(page);
  // Settle the generation the settings change opens before adding the folder: one still
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
  return await page.evaluate(async () => {
    const files = window.sourceFiles;
    if (!files) {
      throw new Error('Canonical source capability missing');
    }
    const indexed = (
      await files.list().then((result) => {
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.value;
      })
    ).find((file) => file.fileName === 'reset-indexed-probe.txt');
    if (!indexed) {
      throw new Error('Actual indexed source missing');
    }
    const chunks = await files
      .chunks({ fileId: indexed.fileId, limit: 100, offset: 0 })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.value;
      });
    if (
      chunks.kind !== 'available' ||
      chunks.total === 0 ||
      !chunks.chunks.some((chunk) => chunk.content.includes('Native reset indexed marker'))
    ) {
      throw new Error('Actual native reset probe chunks unavailable');
    }
    const content = 'Canonical imported reset marker';
    const imported = await files
      .import({
        embeddingSetId: null,
        files: [
          {
            content,
            name: 'reset-imported-probe.txt',
            path: 'reset-imported-probe.txt',
            size: content.length,
          },
        ],
      })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.value;
      });
    const receipt = imported.items[0];
    if (!receipt?.imported) {
      throw new Error('Imported reset probe was not committed');
    }
    // Import returns committed metadata. Read the same canonical ID to prove
    // the bytes survived the existing source/blob writer, rather than assuming
    // metadata receipts carry the content payload.
    const persisted = await files.read([receipt.file.fileId], content.length).then((result) => {
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    });
    if (
      persisted.length !== 1 ||
      persisted[0]?.fileId !== receipt.file.fileId ||
      persisted[0]?.content !== content
    ) {
      throw new Error('Imported reset probe content was not retained by its canonical ID');
    }
    // Unassigned imports remain retained/pending; no fabricated embedding job or chunk.
    if (imported.indexing.kind !== 'pending') {
      throw new Error('Unassigned import incorrectly claimed indexing');
    }
    return { importedFileId: receipt.file.fileId, indexedFileId: indexed.fileId };
  });
}

export async function readNativeResetProbe(
  page: Page,
  probe: { indexedFileId: string; importedFileId: string }
): Promise<{ files: number; retainedProbeIds: string[] }> {
  return await page.evaluate(async (ids) => {
    const source = window.sourceFiles;
    if (!source) {
      throw new Error('Canonical source capability missing');
    }
    const listed = await source.list().then((result) => {
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    });
    // read() requires existing canonical IDs; deletion is proved by the full
    // authoritative inventory, not a read of identities that no longer exist.
    return {
      files: listed.length,
      retainedProbeIds: listed
        .filter((file) => file.fileId === ids.indexedFileId || file.fileId === ids.importedFileId)
        .map((file) => file.fileId),
    };
  }, probe);
}
