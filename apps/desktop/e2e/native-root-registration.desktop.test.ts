import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { updateIndexConfig } from './utils/index-config';
import {
  configureNativeIndex,
  vectorSearch,
  waitForEmbeddedFolder,
} from './utils/native-index-build';
import { textReadiness } from './utils/text-search-mode';

/** Adds a real folder with the explorer's Add Folder button, which picks `folder`. */
async function addWorkspaceFolder(
  app: ElectronApplication,
  page: Page,
  folder: string,
  visibleFile: string
): Promise<void> {
  await app.evaluate((_electron, picked) => {
    process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = picked;
  }, folder);
  await ensureFileExplorerPanelVisible(page);
  await page.getByTestId('select-root-button').click({ timeout: 15_000 });
  await expect(
    page.getByRole('treegrid', { name: 'File tree' }).getByText(visibleFile)
  ).toBeVisible({ timeout: 30_000 });
}

test('indexes and searches a real folder registered while native ingestion is paused', async ({
  electron,
  electronApp,
  modelProvider,
  window,
}) => {
  test.setTimeout(180_000);
  const rootPath = await realpath(
    await mkdtemp(join(tmpdir(), 'brainstrike-native-registration-'))
  );
  try {
    await writeFile(
      join(rootPath, 'proof.ts'),
      'export const evidence = "A real native root authority proof";\n'
    );
    await updateIndexConfig(window, { paused: true });
    await configureNativeIndex(window, modelProvider);
    await expect
      .poll(() => textReadiness(window), { timeout: 120_000 })
      .toEqual({ folders: 0, indexMode: 'vector-configured', kind: 'ready' });
    await addWorkspaceFolder(electronApp.app, window, rootPath, 'proof.ts');
    await updateIndexConfig(window, { paused: false });
    await waitForEmbeddedFolder(window, 1);
    const { hits } = await vectorSearch(window, 'real native root authority proof', 5);
    expect(hits.map((hit) => hit.relativePath)).toContain('proof.ts');
  } finally {
    await electron.closeForStateSeeding();
    await rm(rootPath, { force: true, recursive: true });
  }
});
