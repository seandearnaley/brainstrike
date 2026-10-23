import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWorkspaceFolder } from './embedding-worker-renderer.native-search';
import {
  expect,
  openWorkspaceSearchPanel,
  runWorkspaceSemanticSearch,
  test,
  waitForWorkspaceSemanticSearchResults,
} from './embedding-worker-renderer.shared';
import { updateIndexConfig } from './utils/index-config';
import { configureNativeIndex, waitForEmbeddedFolder } from './utils/native-index-build';
import { textReadiness } from './utils/text-search-mode';

test('indexes and searches a real folder registered while native ingestion is paused', async ({
  electron,
  electronApp,
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
    await configureNativeIndex(window, 'wasm');
    await expect
      .poll(() => textReadiness(window), { timeout: 120_000 })
      .toEqual({ folders: 0, indexMode: 'vector-configured', kind: 'ready' });
    await addWorkspaceFolder(electronApp.app, window, rootPath, 'proof.ts');
    await updateIndexConfig(window, { paused: false });
    await waitForEmbeddedFolder(window, 1);
    const panel = await openWorkspaceSearchPanel(window);
    await runWorkspaceSemanticSearch(panel, 'real native root authority proof');
    const results = await waitForWorkspaceSemanticSearchResults(panel);
    expect(results.resultFileCount).toBeGreaterThan(0);
    await expect(panel.getByRole('row').filter({ hasText: 'proof.ts' })).toBeVisible();
  } finally {
    await electron.closeForStateSeeding();
    await rm(rootPath, { force: true, recursive: true });
  }
});
