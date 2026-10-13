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
  const { chooseTextSearch } = await import('./text-search-mode');
  if (!workspacePath) {
    throw new Error('Disposable workspace path is required');
  }
  await writeFile(
    join(workspacePath, 'reset-indexed-probe.txt'),
    'Native reset indexed marker.\n',
    'utf8'
  );
  await chooseTextSearch(page);
  await ensureMockWorkspaceOpen(page);
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          if (!window.sourceFiles) {
            throw new Error('Canonical source capability missing');
          }
          return (
            (
              await window.sourceFiles.list().then((result) => {
                if (!result.ok) {
                  throw new Error(result.error.message);
                }
                return result.value;
              })
            ).find((file) => file.fileName === 'reset-indexed-probe.txt')?.chunksCount ?? 0
          );
        }),
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0);
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
    if (!receipt?.imported || receipt.file.content !== content) {
      throw new Error('Imported reset probe was not committed');
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
    return {
      files: (
        await source.list().then((result) => {
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.value;
        })
      ).length,
      retainedProbeIds: (
        await source.read([ids.indexedFileId, ids.importedFileId], 4096).then((result) => {
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.value;
        })
      ).map((file) => file.fileId),
    };
  }, probe);
}
