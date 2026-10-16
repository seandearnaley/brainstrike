import type { ElectronApplication, Page } from 'playwright';
import {
  configureNativeCollectionSearch,
  createNativeImportedSearchFixture,
  waitForNativeCollectionCoverage,
} from './embedding-worker-renderer.native-search';
import { expect } from './fixtures/electron-fixture';
import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';
import { showDatabaseDemoPanel } from './utils/layout-helpers';

/** Capture the real process receipt: exit zero alone did not catch the M3 native cleanup failure. */
export function captureNativeShutdown(app: ElectronApplication): () => void {
  const process = app.process();
  let output = '';
  const append = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
  };
  process.stdout?.on('data', append);
  return () => {
    process.stdout?.off('data', append);
    const reports = output.split('\n').flatMap((line) => {
      if (!line.startsWith('{')) {
        return [];
      }
      const record: unknown = JSON.parse(line);
      if (typeof record !== 'object' || record === null || !('steps' in record)) {
        return [];
      }
      return Array.isArray(record.steps) ? [record.steps] : [];
    });
    expect(process.exitCode).toBe(0);
    expect(process.signalCode).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ failed: false, step: 'native-index' }),
        expect.objectContaining({ failed: false, step: 'embedding-host' }),
      ])
    );
    expect(reports[0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ failed: true })])
    );
  };
}

export interface ActiveNativeIngestion {
  readonly activeWindow: Page;
  readonly searchableCollectionName: string;
  readonly searchableEmbeddingSetId: string;
}

/**
 * A fully embedded collection to search afterwards, then a large real folder
 * opened as the workspace, so the native index is still embedding it.
 */
export async function prepareActiveNativeIngestion(
  electronApp: ElectronApplication,
  window: Page,
  rootPath: string
): Promise<ActiveNativeIngestion> {
  const activeWindow = await showDatabaseDemoPanel(window);
  const searchableCollectionName = `Searchable native collection ${Date.now()}`;
  const fixture = await createNativeImportedSearchFixture(activeWindow, searchableCollectionName);
  await configureNativeCollectionSearch(activeWindow, searchableCollectionName);
  await waitForNativeCollectionCoverage(activeWindow, fixture.embeddingSetId, fixture.fileCount);

  // The folder picker returns this real directory instead of an OS dialog.
  await electronApp.evaluate((_electron, root) => {
    process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = root;
  }, rootPath);
  const explorer = getContextExplorerFileExplorerPanel(activeWindow);
  await expect(explorer).toBeVisible({ timeout: 15_000 });
  await activeWindow.getByTestId('select-root-button').click({ timeout: 15_000 });
  await expect(
    activeWindow.getByRole('treegrid', { name: 'File tree' }).getByText('stress-file-0000.ts')
  ).toBeVisible({ timeout: 30_000 });

  return {
    activeWindow,
    searchableCollectionName,
    searchableEmbeddingSetId: fixture.embeddingSetId,
  };
}
