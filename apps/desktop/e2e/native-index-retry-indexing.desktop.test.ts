import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMainBufferedLogs } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import { seedPausedWorkspace } from './utils/foreground-latency-bench';
import {
  closeIndexingPopover,
  configureNativeIndex,
  openResumeControl,
  readNativeIndexSummary,
  waitForReadyIndex,
} from './utils/native-index-build';

/**
 * An embedding host that stops responding blocks indexing with its cause and offers Retry
 * indexing, which restarts the host and completes the index (BST-2104). The E2E-only stall seam
 * withholds the first document batch in Main, so Main's real 60 s liveness window expires exactly
 * as it does for a hung host; nothing restarts on its own.
 */
test.use({ electronEnv: { BRAINSTRIKE_E2E_STALL_EMBEDDING_DOCUMENT_BATCHES: '1' } });

const FILE_COUNT = 3;
const ROOT_ID = 'native-retry-indexing-root';

let rootDir = '';

test.beforeAll(() => {
  // The host records the folder's real path (macOS tmpdir is a symlink).
  rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'brainstrike-retry-indexing-')));
  mkdirSync(path.join(rootDir, 'notes'));
  for (let index = 0; index < FILE_COUNT; index += 1) {
    writeFileSync(
      path.join(rootDir, 'notes', `note-${index}.md`),
      `# Note ${index}\n\nA short note about topic ${index}, kept small so its vectors embed fast.\n`
    );
  }
});

test.afterAll(() => {
  rmSync(rootDir, { force: true, recursive: true });
});

test('@desktop-embedding-native-retry a host that stops responding blocks with its cause, and Retry indexing completes the index', async ({
  window: page,
}) => {
  test.setTimeout(8 * 60 * 1000);
  await seedPausedWorkspace(page, [{ path: rootDir, rootId: ROOT_ID }], 'wasm', 'retry-seeded');
  await configureNativeIndex(page, 'wasm');
  await waitForReadyIndex(page, 300_000);
  const resume = await openResumeControl(page);
  await resume.click();
  await closeIndexingPopover(page);

  // One 60 s window, then the joined Stop that retires the silent host (at most 10 s).
  const trigger = page.getByTestId('indexing-status-trigger');
  await expect(trigger).toContainText('Blocked', { timeout: 150_000 });
  await trigger.click();
  const popover = page.getByTestId('indexing-status-popover');
  await expect(popover.getByTestId('indexing-activity-region')).toContainText(
    'The embedding model stopped responding before it started on a batch.'
  );
  // The cause names no internal identity; Main's log keeps the request.
  await expect(popover.getByTestId('indexing-activity-region')).not.toContainText('embedding-host');
  const timedOut = (await getMainBufferedLogs(page)).filter((record) =>
    JSON.stringify(record).includes('Embedding host document batch timed out')
  );
  expect(timedOut).toHaveLength(1);
  expect(JSON.stringify(timedOut[0])).toContain('"stage":"no-report"');
  expect(JSON.stringify(timedOut[0])).toContain('"requestId"');

  const retry = popover.getByRole('button', { name: 'Retry indexing' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect
    .poll(async () => await readNativeIndexSummary(page), { timeout: 300_000 })
    .toMatchObject({
      missingVectors: 0,
      roots: [{ indexedFiles: FILE_COUNT, rootId: ROOT_ID, scanComplete: true }],
      status: 'ready',
      vectorCoverageComplete: true,
    });
  await expect(trigger).not.toContainText('Blocked');
  // The seam withheld only the first batch: the retried host answered every later one.
  expect(
    (await getMainBufferedLogs(page)).filter((record) =>
      JSON.stringify(record).includes('Embedding host document batch timed out')
    )
  ).toHaveLength(1);
});
