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
async function startForegroundDatabasePressure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as Window & {
      __capacityReproPressure?: { stop: () => void };
      electronAPI?: {
        db?: { query?: (sql: string) => Promise<{ rows: unknown[] }> };
      };
    };
    const query = targetWindow.electronAPI?.db?.query;
    if (!query) {
      throw new Error('Database API not available');
    }
    let running = true;
    void (async () => {
      while (running) {
        try {
          await query('SELECT COUNT(*)::int AS count FROM file_chunks');
        } catch {
          // A transient failure must not end the pressure loop.
        }
        // Paced, not saturating: one foreground query every 40ms keeps
        // `lastForegroundAt` inside the scheduler's 75ms quiet window — the same
        // signal a live-query-driven panel produces — without monopolising the
        // DB host, which would starve host startup instead of claim admission.
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();
    targetWindow.__capacityReproPressure = {
      stop: () => {
        running = false;
      },
    };
  });
}

async function stopForegroundDatabasePressure(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as Window & { __capacityReproPressure?: { stop: () => void } }
    ).__capacityReproPressure?.stop();
  });
}

test.describe('Embedding backfill - queue capacity wait', () => {
  test('@desktop-embedding-backfill-capacity drains a collection larger than the queue-depth bound', async ({
    window,
  }) => {
    test.setTimeout(300_000);
    let activeWindow = await showDatabaseDemoPanel(window);
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

    await backfillButton.click({ timeout: 5000 });

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
  });

  // Documented gap, deliberately not asserted as a passing test.
  //
  // With the main window issuing a foreground query faster than the DB
  // scheduler's 75ms foreground quiet window, the embedding worker still cannot
  // make progress: the claim-admission starvation bound (this change) lets the
  // worker DECIDE to claim, but the claim query itself is background-priority DB
  // work and `DatabaseWorkScheduler.#nextDelayMs` keeps deferring the background
  // lane for as long as `lastForegroundAt` stays inside the quiet window. The
  // scheduler tracks `backgroundWaitingSince`/`backgroundWaitingMs` but never
  // uses them to force a background task through, so the background lane has no
  // starvation guarantee at all.
  //
  // Closing this means giving `DatabaseWorkScheduler` a background-lane
  // starvation bound — shared fairness policy for every background consumer
  // (embedding host, chunking host, scheduled maintenance), which is a larger,
  // separately reviewable change than the claim-admission bound.
  //
  // Live evidence (this spec, with startForegroundDatabasePressure active at a
  // 40ms cadence): pre-fix the run reproduced the report byte-for-byte —
  // "Backfill timed out while waiting for queue capacity below 64 jobs
  // (queued=64, running=0, failed=0, succeeded=0)."; post-fix the starvation
  // warning fires and `running` reaches 1, but completions still stall.
  test.fixme('@desktop-embedding-backfill-capacity claims and completes while the foreground database lane stays saturated', async ({
    window,
  }) => {
    await startForegroundDatabasePressure(window);
    await stopForegroundDatabasePressure(window);
  });
});
