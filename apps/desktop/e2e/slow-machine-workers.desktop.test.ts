import { realpathSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { ElectronApplication, Page } from 'playwright';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { updateIndexConfig } from './utils/index-config';
import { getMainBufferedLogs } from './utils/main-logs';
import { HOSTED_INDEX_MODEL } from './utils/native-index-build';

/**
 * Lifecycle redesign PR D (§6.1): a slow machine never causes a worker error. The E2E seam holds
 * the indexer utility's first request, the first canonical attach and the first workspace-root
 * root watch start past every deadline that used to retire them. The spec asserts product
 * behaviour only: the folder indexes, the index reaches ready with a VECTOR profile (the paused
 * semantic setup of workspace-index-bootstrap, which embeds nothing), the same indexer process
 * serves each configuration (none is retired or killed for being slow), and no lifecycle family
 * logs an error.
 */
test.use({
  electronEnv: {
    BRAINSTRIKE_E2E_LIFECYCLE_DELAYS:
      'indexer-request:7000,canonical-attach:7000,root-watch-subscribe:12000',
  },
});

/** Main's log scopes for the workers and hosts this spec slows down. */
const LIFECYCLE_SCOPE =
  /^(IndexerHostManager|NativeIndex|HostRequestChannel|RootWatchers|AgentHostStateIndex|HostLease)/u;

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

test('@desktop-slow-machine-workers slow workers are waited for, never retired or failed', async ({
  electron,
}) => {
  // Every delay is paid once; the rest is the ordinary first run on a slow runner.
  test.setTimeout(8 * 60_000);
  const folder = realpathSync(await mkdtemp(join(tmpdir(), 'brainstrike-slow-workers-')));
  electron.removeAfterClose(folder);
  await writeFile(
    join(folder, 'slow-proof.md'),
    '# Slow machine\nThe workers proof indexes this document while every worker is slow.\n'
  );
  const { app, window } = await electron.ensureContext();

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

  // Paused semantic setup reaches a VECTOR profile without inference
  // (workspace-index-bootstrap "completes paused semantic setup", smoke45's test).
  await updateIndexConfig(window, { paused: true });
  await updateIndexConfig(window, { mode: 'semantic', model: HOSTED_INDEX_MODEL });
  await expect
    .poll(() => readIndexDigest(window).then((digest) => digest.indexMode), {
      intervals: [1000],
      timeout: 180_000,
    })
    .toBe('vector-configured');

  // The semantic configuration's new collection scope opens its own indexer generation: the
  // previous one closed cooperatively, so one indexer process serves now, and none was killed.
  expect(await indexerPids(app)).toHaveLength(1);

  const logs = await getMainBufferedLogs(window);
  const lifecycleErrors = logs.filter(
    (record) => record.level === 'error' && LIFECYCLE_SCOPE.test(record.scope ?? '')
  );
  expect(lifecycleErrors).toEqual([]);
  // No close escalated to a kill (R5(b)) and no worker was slow enough to stall a close.
  expect(
    logs.filter(
      (record) =>
        record.scope === 'IndexerHostManager' &&
        /killing it|kill was refused/u.test(record.message ?? '')
    )
  ).toEqual([]);
});
