import type { Page } from '@playwright/test';
import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  ERROR_LOCATOR,
  clearEmbeddingQueue,
  createImportTargetCollection,
  getEmbeddingSetCounts,
  isDatabaseError,
  reloadRendererInTest,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  waitForBackfillButtonEnabled,
} = shared;

// The collection must exceed EMBEDDING_BACKFILL_MAX_QUEUE_DEPTH (64) or the
// backfill enqueues everything in one pass and never reaches the queue-capacity
// wait — which is why every pre-existing backfill spec (2 files, 4 chunks) missed
// this entirely.
const FILE_COUNT = 33;
const CHUNKS_PER_FILE = 5;
const TOTAL_CHUNKS = FILE_COUNT * CHUNKS_PER_FILE;

async function seedLargeImportFixture(
  page: Page,
  embeddingSetId: string
): Promise<{ fileCount: number; totalChunks: number }> {
  return await page.evaluate<
    { fileCount: number; totalChunks: number },
    { chunksPerFile: number; embeddingSetId: string; fileCount: number }
  >(
    async ({ chunksPerFile, embeddingSetId: id, fileCount }) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: unknown[]
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }
      const now = new Date().toISOString();
      let totalChunks = 0;
      for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
        const fileId = `import-file-${crypto.randomUUID()}`;
        const chunks = Array.from(
          { length: chunksPerFile },
          (_unused, chunkIndex) =>
            `Fixture file ${fileIndex} chunk ${chunkIndex}: deterministic content for capacity-wait backfill coverage.`
        );
        const content = chunks.join('\n');
        await api.db.query(
          `INSERT INTO file_records (
             id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            fileId,
            `/mock/test/capacity/file-${fileIndex}.txt`,
            `file-${fileIndex}.txt`,
            content.length,
            content,
            `content-hash-${fileId}`,
            Math.max(1, Math.ceil(content.length / 8)),
            id,
            now,
          ]
        );
        for (const [chunkIndex, chunkContent] of chunks.entries()) {
          const lineNumber = chunkIndex + 1;
          await api.db.query(
            `INSERT INTO file_chunks (
               id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, start_line, end_line, created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
            [
              `${fileId}-chunk-${chunkIndex}`,
              fileId,
              chunkIndex,
              chunkContent,
              `chunk-hash-${fileId}-${chunkIndex}`,
              Math.max(1, Math.ceil(chunkContent.length / 8)),
              'text',
              chunkContent.length,
              lineNumber,
              lineNumber,
              now,
            ]
          );
        }
        await api.db.query(
          `UPDATE file_records
              SET chunks_processed_at = $2,
                  chunks_count = $3,
                  chunking_strategy = $4,
                  updated_at = $2
            WHERE id = $1`,
          [fileId, now, chunks.length, 'sentence']
        );
        totalChunks += chunks.length;
      }
      return { fileCount, totalChunks };
    },
    { chunksPerFile: CHUNKS_PER_FILE, embeddingSetId, fileCount: FILE_COUNT }
  );
}

/**
 * Hold the main-window renderer's DB lane busy for the duration of the backfill.
 *
 * This is not synthetic load: every renderer `db.query` defaults to `foreground`
 * priority (desktop-database-work's resolveDefaultDatabaseWorkPriority), so a
 * user sitting on the Explorer/Database surface produces exactly this signal.
 * It is the condition under which the embedding worker's claim admission used to
 * pause indefinitely, leaving the backfill waiting on capacity only that worker
 * could free.
 */
async function startForegroundDatabasePressure(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const targetWindow = window as Window & {
      __capacityReproPressure?: {
        failure: string | null;
        inFlight: number;
        lastEnqueueAt: number | null;
        maxGapMs: number;
        stop: () => void;
      };
      electronAPI?: {
        db?: {
          query?: (sql: string) => Promise<{ rows: unknown[] }>;
          schedulerSnapshot?: () => Promise<{ backgroundYieldCount: number }>;
        };
      };
    };
    const query = targetWindow.electronAPI?.db?.query;
    const schedulerSnapshot = targetWindow.electronAPI?.db?.schedulerSnapshot;
    if (!(query && schedulerSnapshot)) {
      throw new Error('Database query and scheduler snapshot APIs are required');
    }
    const backgroundYieldBaseline = (await schedulerSnapshot()).backgroundYieldCount;
    // A successful query is the pressure-loop handshake. Without it, a broken
    // IPC bridge could make the detached loop swallow every rejection and let
    // the starvation regression pass while applying no foreground pressure.
    await query('SELECT COUNT(*)::int AS count FROM file_chunks');
    let running = true;
    let consecutiveFailures = 0;
    let pressureTimer: number | null = null;
    const maxInFlight = 3;
    const pressure = {
      failure: null as string | null,
      inFlight: 0,
      lastEnqueueAt: null as number | null,
      maxGapMs: 0,
      stop: () => {
        running = false;
        if (pressureTimer !== null) {
          window.clearInterval(pressureTimer);
          pressureTimer = null;
        }
      },
    };
    targetWindow.__capacityReproPressure = pressure;
    const enqueuePressureQuery = (): void => {
      const observedAt = performance.now();
      if (pressure.lastEnqueueAt !== null) {
        pressure.maxGapMs = Math.max(pressure.maxGapMs, observedAt - pressure.lastEnqueueAt);
      }
      if (pressure.inFlight >= maxInFlight) {
        return;
      }
      pressure.lastEnqueueAt = observedAt;
      pressure.inFlight += 1;
      void query('SELECT COUNT(*)::int AS count FROM file_chunks')
        .then(
          () => {
            if (!running) {
              return;
            }
            consecutiveFailures = 0;
          },
          (error: unknown) => {
            if (!running) {
              return;
            }
            consecutiveFailures += 1;
            if (consecutiveFailures >= 3) {
              pressure.failure = `Foreground database pressure failed 3 consecutive times: ${
                error instanceof Error ? error.message : String(error)
              }`;
              pressure.stop();
            }
          }
        )
        .finally(() => {
          pressure.inFlight -= 1;
        });
    };
    // Enqueue on a fixed cadence rather than sleeping after each response. A
    // slow query must not stretch foreground arrivals beyond the scheduler's
    // 75ms quiet window and let the regression pass without exercising the
    // starvation bound.
    pressureTimer = window.setInterval(enqueuePressureQuery, 40);
    enqueuePressureQuery();
    return backgroundYieldBaseline;
  });
}

async function assertForegroundDatabasePressureHealthy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pressure = (
      window as Window & {
        __capacityReproPressure?: {
          failure: string | null;
          lastEnqueueAt: number | null;
          maxGapMs: number;
        };
      }
    ).__capacityReproPressure;
    if (!pressure) {
      throw new Error('Foreground database pressure was not started.');
    }
    if (pressure.failure) {
      throw new Error(pressure.failure);
    }
    if (pressure.lastEnqueueAt === null) {
      throw new Error('Foreground database pressure did not enqueue a query.');
    }
    const maxGapMs = Math.max(pressure.maxGapMs, performance.now() - pressure.lastEnqueueAt);
    if (maxGapMs >= 75) {
      throw new Error(
        `Foreground database pressure enqueue gap reached ${maxGapMs.toFixed(1)}ms; the scheduler quiet window is 75ms.`
      );
    }
  });
}

async function assertBackgroundYieldObserved(page: Page, baseline: number): Promise<void> {
  const backgroundYieldCount = await page.evaluate(async () => {
    const schedulerSnapshot = (
      window as Window & {
        electronAPI?: {
          db?: { schedulerSnapshot?: () => Promise<{ backgroundYieldCount: number }> };
        };
      }
    ).electronAPI?.db?.schedulerSnapshot;
    if (!schedulerSnapshot) {
      throw new Error('Database scheduler snapshot API is not available');
    }
    return (await schedulerSnapshot()).backgroundYieldCount;
  });
  expect(backgroundYieldCount).toBeGreaterThan(baseline);
}

async function stopForegroundDatabasePressure(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as Window & { __capacityReproPressure?: { stop: () => void } }
    ).__capacityReproPressure?.stop();
  });
}

async function runCapacityBackfill(
  page: Page,
  options: { readonly foregroundPressure: boolean }
): Promise<void> {
  let activeWindow = await showDatabaseDemoPanel(page);
  if (await isDatabaseError(activeWindow)) {
    await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
    return;
  }
  await clearEmbeddingQueue(activeWindow);

  const collectionName = `Capacity Backfill ${Date.now()}`;
  const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);
  const fixture = await seedLargeImportFixture(activeWindow, embeddingSetId);
  expect(fixture.totalChunks).toBe(TOTAL_CHUNKS);
  await setVectorDevicePreference(activeWindow, 'wasm');
  await reloadRendererInTest(activeWindow, 'embedding-backfill-capacity');
  activeWindow = await showDatabaseDemoPanel(activeWindow);

  const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
  await expect(collectionOption).toBeVisible({ timeout: 15_000 });
  await collectionOption.click({ timeout: 5000 });

  const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
  const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
  await expect(backfillButton).toBeVisible({ timeout: 15_000 });
  await waitForBackfillButtonEnabled(activeWindow, backfillButton);

  const backgroundYieldBaseline = options.foregroundPressure
    ? await startForegroundDatabasePressure(activeWindow)
    : null;
  try {
    await backfillButton.click({ timeout: 5000 });

    if (options.foregroundPressure) {
      // The regression is starvation, not bulk-throughput policy: keep the
      // foreground lane continuously active until the background worker has
      // both claimed and completed real work. Before BST-1231 this remains at
      // zero forever because the claim query itself cannot enter the DB host.
      await expect
        .poll(
          async () => {
            await assertForegroundDatabasePressureHealthy(activeWindow);
            return (await getEmbeddingSetCounts(activeWindow, embeddingSetId)).embeddedChunks;
          },
          {
            intervals: [1000],
            timeout: 45_000,
          }
        )
        .toBeGreaterThan(0);
      if (backgroundYieldBaseline === null) {
        throw new Error('Foreground pressure scheduler baseline was not captured');
      }
      await assertBackgroundYieldObserved(activeWindow, backgroundYieldBaseline);
      return;
    }

    await expect
      .poll(
        async () => (await getEmbeddingSetCounts(activeWindow, embeddingSetId)).embeddedChunks,
        {
          intervals: [2000],
          timeout: 180_000,
        }
      )
      .toBe(TOTAL_CHUNKS);

    // A terminal backfill must not leave the control stuck in its in-flight label.
    await expect(backfillButton).toContainText('Backfill', { timeout: 15_000 });
  } finally {
    if (options.foregroundPressure) {
      await stopForegroundDatabasePressure(activeWindow);
    }
  }
}

test.describe('Embedding backfill - queue capacity wait', () => {
  test('@desktop-embedding-backfill-capacity drains a collection larger than the queue-depth bound', async ({
    window,
  }) => {
    test.setTimeout(300_000);
    await runCapacityBackfill(window, { foregroundPressure: false });
  });

  test('@desktop-embedding-backfill-capacity makes bounded claim and completion progress while the foreground database lane stays saturated', async ({
    window,
  }) => {
    test.setTimeout(300_000);
    await runCapacityBackfill(window, { foregroundPressure: true });
  });
});
