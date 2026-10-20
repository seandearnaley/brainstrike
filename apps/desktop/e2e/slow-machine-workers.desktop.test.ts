import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { ElectronApplication, Page } from 'playwright';
import {
  ensureEmbeddingHostStarted,
  getEmbeddingHostStatus,
  getMainBufferedLogs,
} from './embedding-worker-renderer.shared';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';

/**
 * Lifecycle redesign PR D (§6.1): a slow machine never causes a worker error. The E2E seam holds
 * the indexer utility's first request, the first canonical attach and the first workspace-root
 * parcel subscribe past every deadline that used to retire them, and the hidden embedding host's
 * readiness past its old 30 s ready timer. The spec asserts product behaviour only: the folder
 * indexes, the index reaches ready with a VECTOR profile (the paused semantic setup of
 * workspace-index-bootstrap, which needs no model download), one indexer process serves it all,
 * the one embedding host is running, and no lifecycle family logs an error.
 */
test.use({
  electronEnv: {
    BRAINSTRIKE_E2E_LIFECYCLE_DELAYS:
      'indexer-request:7000,canonical-attach:7000,hidden-host-ready:35000,parcel-subscribe:12000',
  },
});

/** Main's log scopes for the workers and hosts this spec slows down. */
const LIFECYCLE_SCOPE =
  /^(IndexerHostManager|NativeIndex|RendererHostLifecycle|EmbeddingHostManager|HostRequestChannel|ParcelWatchers|AgentHostStateIndex|HostLease)/u;

interface StatusDigest {
  readonly indexedFiles: number;
  readonly indexMode: string | null;
  readonly kind: string;
  readonly reason: string | null;
  readonly scanComplete: boolean;
}

/** The native index status and the opened folder's coverage, as the renderer reads them. */
async function readIndexDigest(page: Page): Promise<StatusDigest> {
  return await page.evaluate(async () => {
    const capability = (
      globalThis as typeof globalThis & {
        readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
      }
    ).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('The native index capability is unavailable.');
    }
    const status = await capability.status();
    if (status.kind !== 'ready') {
      return {
        indexedFiles: 0,
        indexMode: null,
        kind: status.kind,
        reason: status.reason,
        scanComplete: false,
      };
    }
    const observation = await capability.coverageBatch([{ rootIds: status.authorizedRootIds }]);
    const indexedFiles =
      observation.kind === 'blocked' || observation.kind === 'invalidated'
        ? 0
        : (observation.coverage[0]?.totals.indexedFiles ?? 0);
    return {
      indexedFiles,
      indexMode: status.embedding.indexMode,
      kind: status.kind,
      reason: null,
      scanComplete:
        status.rootReadiness.length > 0 && status.rootReadiness.every((root) => root.scanComplete),
    };
  });
}

/** The pid of every live indexer utility (`serviceName: 'brainstrike-indexer'`). */
async function indexerPids(app: ElectronApplication): Promise<number[]> {
  return await app.evaluate(({ app: electronApp }) =>
    electronApp
      .getAppMetrics()
      .filter((metric) => metric.type === 'Utility' && metric.name === 'brainstrike-indexer')
      .map((metric) => metric.pid)
  );
}

/** Live hidden embedding host windows. */
async function embeddingHostWindows(app: ElectronApplication): Promise<number> {
  return await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) =>
        window.webContents.getURL().includes('mode=embedding-host')
      ).length
  );
}

test('@desktop-slow-machine-workers slow workers are waited for, never retired or failed', async ({
  electron,
}) => {
  // Every delay is paid once; the rest is the ordinary first run on a slow runner.
  test.setTimeout(8 * 60_000);
  const folder = realpathSync(await mkdtemp(join(tmpdir(), 'brainstrike-slow-workers-')));
  await writeFile(
    join(folder, 'slow-proof.md'),
    '# Slow machine\nThe workers proof indexes this document while every worker is slow.\n'
  );
  try {
    const { app, window } = await electron.ensureContext();
    const homePage = new HomePage(window);

    // The workspace-root watch subscribes 12 s late: joined, never a subscribe-timeout.
    await app.evaluate((_electron, path) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = path;
    }, folder);
    await ensureFileExplorerPanelVisible(window);
    await window.getByTestId('select-root-button').click();
    await expect(
      window.getByRole('treegrid', { name: 'File tree' }).getByText('slow-proof.md')
    ).toBeVisible({ timeout: 60_000 });

    // Text indexing of the folder: its canonical attach and the utility's first request each
    // answer 7 s late, past the former 5 s deadlines that closed admission or killed the utility.
    await homePage.openSettings();
    await window.getByRole('button', { name: 'Search & Indexing' }).click();
    await expect(window.getByTestId('settings-category-search-indexing')).toBeVisible({
      timeout: 60_000,
    });
    await window.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
    await window.getByRole('option', { name: /BGE Small/ }).click();
    await window.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
    await expect(window.getByRole('combobox', { name: 'Managed collection' })).toContainText(
      'Workspace Index (BGE Small)',
      { timeout: 60_000 }
    );
    await window.getByRole('combobox', { name: 'Search mode' }).click();
    await window.getByRole('option', { exact: true, name: 'Text search' }).click();
    await expect
      .poll(() => readIndexDigest(window), { intervals: [1000], timeout: 180_000 })
      .toEqual({
        indexedFiles: 1,
        indexMode: 'text-only',
        kind: 'ready',
        reason: null,
        scanComplete: true,
      });
    const indexer = await indexerPids(app);
    expect(indexer).toHaveLength(1);

    // The hidden embedding host reports ready 35 s late, past its former 30 s ready timer.
    const host = await ensureEmbeddingHostStarted(window);
    expect(host).toMatchObject({ lastError: null, state: 'running' });
    expect(await embeddingHostWindows(app)).toBe(1);

    // Paused semantic setup reaches a VECTOR profile without inference
    // (workspace-index-bootstrap "completes paused semantic setup", smoke45's test).
    await window.getByRole('button', { name: 'Pause workspace index' }).click();
    await window.getByRole('combobox', { name: 'Search mode' }).click();
    await window.getByRole('option', { exact: true, name: 'Text and semantic search' }).click();
    await window.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
    await window.getByRole('option', { name: /BGE Small/ }).click();
    await window.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
    await window.getByRole('combobox', { name: 'Local model execution' }).click();
    await window.getByRole('option', { exact: true, name: 'WASM · Q8' }).click();
    await expect
      .poll(() => readIndexDigest(window).then((digest) => digest.indexMode), {
        intervals: [1000],
        timeout: 180_000,
      })
      .toBe('vector-configured');

    // One indexer process served it all, and the one embedding host was never replaced.
    expect(await indexerPids(app)).toEqual(indexer);
    expect(await getEmbeddingHostStatus(window)).toMatchObject({
      runtimeId: host.runtimeId,
      state: 'running',
    });
    expect(await embeddingHostWindows(app)).toBe(1);

    const logs = await getMainBufferedLogs(window);
    // The seam was live for this launch, so every delay above really applied.
    expect(
      logs.some(
        (record) =>
          record.scope === 'LifecycleDelaySeam' &&
          record.message === 'E2E lifecycle delays are active'
      )
    ).toBe(true);
    const lifecycleErrors = logs.filter(
      (record) =>
        (record as { readonly level?: string }).level === 'error' &&
        LIFECYCLE_SCOPE.test(record.scope ?? '')
    );
    expect(lifecycleErrors).toEqual([]);
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
});
