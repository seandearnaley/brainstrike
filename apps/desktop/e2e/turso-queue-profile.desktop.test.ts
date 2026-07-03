/// <reference path="../src/types/electron.d.ts" />

import type { Page } from '@playwright/test';
import {
  waitForAppReadyInTest,
  withTemporaryProcessEnv,
} from './embedding-worker-renderer/electron-app-fixture';
import {
  clearEmbeddingQueue,
  getEmbeddingHostPage,
  getMainBufferedLogs,
  getRendererLogRecords,
  recordContainsText,
  setVectorDevicePreference,
  startBackfillViaBridge,
} from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';

test.skip(
  process.env['BRAINSTRIKE_E2E_TURSO_QUEUE_PROFILE'] !== '1',
  'Turso queue profile proof is opt-in.'
);

const SUSTAINED_FOREGROUND_PROBE_LABEL = 'turso.queue-profile.sustained-foreground-probe';

test.describe('Turso queue profile proof', () => {
  test('@desktop-turso-queue-profile accepts foreground probes after background Turso queue work', async ({
    electronHarness,
  }) => {
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_DB_RUNTIME: 'turso',
    });

    try {
      const context = await electronHarness.restart();
      const page = context.window;
      await waitForAppReadyInTest(page);

      const profile = await runQueueProfileProbe(page);
      await assertEmbeddingHostTursoProviderInitialized(page);
      await assertNoTursoProviderBootstrapErrors(page);

      expect(profile).toMatchObject({
        observedBackgroundWork: true,
        observedForegroundWork: true,
        ownerRecentLabels: expect.arrayContaining([
          'background:turso.embedding-worker.queue.claimMany',
          'foreground:turso.queue-profile.foreground-probe',
        ]),
        reason: 'within-thresholds',
        status: 'accepted',
      });
      expect(profile.backgroundCompleted ?? 0).toBeGreaterThan(0);
      expect(profile.schedulerForegroundCompleted ?? 0).toBeGreaterThan(0);
    } finally {
      restoreEnv();
    }
  });

  test('@desktop-turso-sustained-queue-profile accepts repeated foreground probes while the hidden worker processes a real Turso backfill', async ({
    electronHarness,
  }) => {
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_DB_RUNTIME: 'turso',
    });
    let page: Page | null = null;

    try {
      const context = await electronHarness.restart();
      page = context.window;
      await waitForAppReadyInTest(page);

      await clearEmbeddingQueue(page);
      await setVectorDevicePreference(page, 'wasm');
      const fixture = await createTursoSustainedBackfillFixture(page, {
        chunksPerFile: 16,
        fileCount: 8,
      });
      await assertEmbeddingHostTursoProviderInitialized(page);
      await assertNoTursoProviderBootstrapErrors(page);

      const summary = await runSustainedHiddenWorkerQueueProfile(page, fixture);
      await test.info().attach('turso-sustained-queue-profile.json', {
        body: JSON.stringify(summary, null, 2),
        contentType: 'application/json',
      });

      expect(summary.finalProfile).toMatchObject({
        observedBackgroundWork: true,
        observedForegroundWork: true,
        reason: 'within-thresholds',
        status: 'accepted',
      });
      expect(summary.hiddenWorkerOwnerLabelCount).toBeGreaterThan(0);
      expect(summary.activeBackfillProbeSamples).toBeGreaterThanOrEqual(3);
      expect(summary.foregroundProbeOwnerLabelCount).toBeGreaterThanOrEqual(3);
      expect(summary.foregroundProbeSamples).toBeGreaterThanOrEqual(3);
      expect(summary.finalProfile.ownerSlowForegroundQueuedOperationCount).toBe(0);
      expect(summary.finalProfile.foregroundWorstWaitMs).toBeLessThan(
        summary.finalProfile.thresholdMs
      );
      expect(summary.finalProfile.foregroundWaitP95Ms).toBeLessThan(
        summary.finalProfile.thresholdMs
      );
    } finally {
      if (page) {
        await cancelSustainedBackfills(page);
      }
      restoreEnv();
    }
  });
});

async function runQueueProfileProbe(page: Page): Promise<{
  backgroundCompleted?: number;
  observedBackgroundWork: boolean;
  observedForegroundWork: boolean;
  ownerRecentLabels: string[];
  reason: string;
  schedulerLabels: string[];
  schedulerForegroundCompleted?: number;
  status: string;
}> {
  await seedQueuedEmbeddingJob(page);

  const claimedCount = await page.evaluate(async () => {
    const api = window.electronAPI;
    const db = api?.db;
    if (!(db?.query && db.tursoEmbeddingWorkerQueue)) {
      throw new Error('Required Turso queue profile DB bridge methods are unavailable.');
    }

    const claimed = await db.tursoEmbeddingWorkerQueue(
      'claimMany',
      {
        leaseMs: 60_000,
        limit: 1,
        now: new Date().toISOString(),
        queue: 'embeddings',
        workerId: 'e2e-turso-queue-profile',
      },
      { label: 'turso.embedding-worker.queue.claimMany', priority: 'background' }
    );

    await db.query('SELECT 1 AS value', [], {
      label: 'turso.queue-profile.foreground-probe',
      priority: 'foreground',
    });

    if (!Array.isArray(claimed)) {
      throw new Error('Turso queue claimMany did not return a job array.');
    }
    return claimed.length;
  });

  expect(claimedCount).toBe(1);

  let latestProfile: {
    backgroundCompleted?: number;
    observedBackgroundWork: boolean;
    observedForegroundWork: boolean;
    ownerRecentLabels: string[];
    reason: string;
    schedulerLabels: string[];
    schedulerForegroundCompleted?: number;
    status: string;
  } | null = null;

  await expect
    .poll(
      async () => {
        latestProfile = await page.evaluate(async () => {
          const api = window.electronAPI;
          const db = api?.db;
          if (!(db?.diagnostics && db.schedulerSnapshot)) {
            throw new Error('Required Turso queue profile diagnostics bridges are unavailable.');
          }

          const diagnostics = await db.diagnostics();
          const scheduler = await db.schedulerSnapshot();
          const desktop = await window.desktopDiagnostics?.getSnapshot();
          const profile = desktop?.tursoQueueProfile;

          if (diagnostics.profileBootstrapReport?.runtime.engine !== 'turso') {
            throw new Error(
              `Expected Turso runtime, got ${diagnostics.profileBootstrapReport?.runtime.engine ?? 'missing'}`
            );
          }
          if (!diagnostics.tursoOwnerClientQoS.available) {
            throw new Error(
              `Expected Turso owner QoS diagnostics, got ${diagnostics.tursoOwnerClientQoS.reason}`
            );
          }
          if (!profile) {
            throw new Error('Desktop Turso queue profile diagnostics are missing.');
          }
          if (profile.status === 'blocked') {
            throw new Error(`Turso queue profile blocked: ${profile.reason}`);
          }

          return {
            backgroundCompleted: profile.backgroundCompleted,
            observedBackgroundWork: profile.observedBackgroundWork,
            observedForegroundWork: profile.observedForegroundWork,
            ownerRecentLabels: diagnostics.tursoOwnerClientQoS.recentCompletedOperations.map(
              (operation) => `${operation.priority}:${operation.label}`
            ),
            reason: profile.reason,
            schedulerLabels: [
              scheduler.priorityStats.background.lastStartedLabel,
              scheduler.priorityStats.background.lastCompletedLabel,
              scheduler.priorityStats.foreground.lastStartedLabel,
              scheduler.priorityStats.foreground.lastCompletedLabel,
              scheduler.priorityStats.normal.lastStartedLabel,
              scheduler.priorityStats.normal.lastCompletedLabel,
            ].filter((label): label is string => typeof label === 'string'),
            schedulerForegroundCompleted: scheduler.priorityStats.foreground.completed,
            status: profile.status,
          };
        });
        return latestProfile;
      },
      {
        intervals: [250, 500, 1000],
        timeout: 15_000,
      }
    )
    .toMatchObject({
      observedBackgroundWork: true,
      observedForegroundWork: true,
      ownerRecentLabels: expect.arrayContaining([
        'background:turso.embedding-worker.queue.claimMany',
        'foreground:turso.queue-profile.foreground-probe',
      ]),
      reason: 'within-thresholds',
      status: 'accepted',
    });

  if (!latestProfile) {
    throw new Error('Turso queue profile proof did not produce diagnostics.');
  }
  return latestProfile;
}

interface SustainedBackfillFixture {
  readonly embeddingSetId: string;
  readonly totalChunks: number;
}

interface SustainedQueueProfile {
  readonly backgroundCompleted: number;
  readonly foregroundWaitP95Ms: number;
  readonly foregroundWorstWaitMs: number;
  readonly observedBackgroundWork: boolean;
  readonly observedForegroundWork: boolean;
  readonly ownerQueuedOperationCount: number;
  readonly ownerSlowForegroundQueuedOperationCount: number;
  readonly ownerSlowQueuedOperationCount: number;
  readonly reason: string;
  readonly status: string;
  readonly thresholdMs: number;
}

interface SustainedQueueProfileSample {
  readonly activeBackfillProbeSamples: number;
  readonly foregroundProbeOwnerLabelCount: number;
  readonly foregroundProbeSamples: number;
  readonly hiddenWorkerOwnerLabelCount: number;
  readonly ownerLabels: readonly string[];
  readonly profile: SustainedQueueProfile;
  readonly queueStatsAfterProbe: SustainedQueueStats;
  readonly queueStatsBeforeProbe: SustainedQueueStats;
  readonly schedulerBackgroundCompleted: number;
  readonly schedulerForegroundCompleted: number;
}

interface SustainedQueueProfileSummary {
  readonly activeBackfillProbeSamples: number;
  readonly finalProfile: SustainedQueueProfile;
  readonly foregroundProbeOwnerLabelCount: number;
  readonly foregroundProbeSamples: number;
  readonly hiddenWorkerOwnerLabelCount: number;
  readonly samples: readonly SustainedQueueProfileSample[];
  readonly totalChunks: number;
}

interface SustainedQueueStats {
  readonly failed: number;
  readonly queued: number;
  readonly running: number;
  readonly succeeded: number;
}

async function createTursoSustainedBackfillFixture(
  page: Page,
  options: { readonly chunksPerFile: number; readonly fileCount: number }
): Promise<SustainedBackfillFixture> {
  return await page.evaluate<
    SustainedBackfillFixture,
    { readonly chunksPerFile: number; readonly fileCount: number }
  >(async ({ chunksPerFile, fileCount }) => {
    const db = window.electronAPI?.db;
    if (!db?.query) {
      throw new Error('Required Turso sustained queue profile DB bridge is unavailable.');
    }

    const now = new Date().toISOString();
    const suffix = Math.random().toString(36).slice(2, 10);
    const embeddingSetId = `sustained-queue-profile-set-${suffix}`;
    const modelId = 'Xenova/all-MiniLM-L6-v2';
    const modelKey = `local::${modelId}`;

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [embeddingSetId, modelKey, modelId, 384, 'cosine', 'Sustained Queue Profile', now],
      { label: 'turso.queue-profile.fixture.embedding-set', priority: 'foreground' }
    );

    for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
      const fileRecordId = `${embeddingSetId}-file-${fileIndex}`;
      await db.query(
        `INSERT INTO file_records (
           id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fileRecordId,
          `/turso-queue-profile/${embeddingSetId}/file-${fileIndex}.ts`,
          `file-${fileIndex}.ts`,
          chunksPerFile * 256,
          `Sustained queue profile file ${fileIndex}`,
          `file-hash-${embeddingSetId}-${fileIndex}`,
          chunksPerFile * 32,
          embeddingSetId,
          now,
          now,
        ],
        { label: 'turso.queue-profile.fixture.file-record', priority: 'foreground' }
      );

      for (let chunkIndex = 0; chunkIndex < chunksPerFile; chunkIndex += 1) {
        const chunkId = `${fileRecordId}-chunk-${chunkIndex}`;
        await db.query(
          `INSERT INTO file_chunks (
             id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type,
             chunk_size, embedding_set_id, created_at, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)`,
          [
            chunkId,
            fileRecordId,
            chunkIndex,
            [
              `export const fileIndex = ${fileIndex};`,
              `export const chunkIndex = ${chunkIndex};`,
              `export const sustainedQueueProfileSet = "${embeddingSetId}";`,
              'export const diagnostic = "turso-hidden-worker-sustained-profile";',
            ].join('\n'),
            `chunk-hash-${chunkId}`,
            32,
            32,
            embeddingSetId,
            now,
            now,
          ],
          { label: 'turso.queue-profile.fixture.file-chunk', priority: 'foreground' }
        );
      }
    }

    return { embeddingSetId, totalChunks: fileCount * chunksPerFile };
  }, options);
}

async function runSustainedHiddenWorkerQueueProfile(
  page: Page,
  fixture: SustainedBackfillFixture
): Promise<SustainedQueueProfileSummary> {
  await startBackfillViaBridge(page, fixture.embeddingSetId);
  const queueMovement = await waitForTursoBackfillQueueMovementOrFatalError(
    page,
    fixture.embeddingSetId,
    90_000
  );
  expect(queueMovement).toBe('queued');

  const samples: SustainedQueueProfileSample[] = [];
  const startedAt = Date.now();
  let probeIndex = 0;

  while (Date.now() - startedAt < 45_000) {
    probeIndex += 1;
    const sample = await sampleTursoSustainedQueueProfile(page, {
      embeddingSetId: fixture.embeddingSetId,
      foregroundProbeLabel: SUSTAINED_FOREGROUND_PROBE_LABEL,
      probeIndex,
    });

    if (sample.profile.status === 'blocked') {
      throw new Error(`Turso sustained queue profile blocked: ${JSON.stringify(sample, null, 2)}`);
    }
    samples.push(sample);
    const summary = summarizeSustainedQueueProfileSamples(samples, fixture.totalChunks);

    if (
      sample.profile.status === 'accepted' &&
      summary.hiddenWorkerOwnerLabelCount > 0 &&
      summary.activeBackfillProbeSamples >= 3 &&
      summary.foregroundProbeOwnerLabelCount >= 3 &&
      summary.foregroundProbeSamples >= 3
    ) {
      return summary;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `Timed out waiting for sustained Turso queue profile evidence: ${JSON.stringify(
      summarizeSustainedQueueProfileSamples(samples, fixture.totalChunks),
      null,
      2
    )}`
  );
}

async function waitForTursoBackfillQueueMovementOrFatalError(
  page: Page,
  embeddingSetId: string,
  timeoutMs: number
): Promise<'error' | 'queued'> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const queueStats = await getTursoEmbeddingSetQueueStats(page, embeddingSetId);
    const hostStatus = await page.evaluate(async () => {
      const host = window.embeddingHost;
      if (!host?.getStatus) {
        throw new Error('Embedding host bridge is not available.');
      }
      return await host.getStatus();
    });

    if (hostStatus.state === 'error') {
      return 'error';
    }

    const totalObserved =
      queueStats.queued + queueStats.running + queueStats.failed + queueStats.succeeded;
    if (totalObserved > 0) {
      return 'queued';
    }

    await page.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for Turso set-scoped queue movement or fatal host error.');
}

async function sampleTursoSustainedQueueProfile(
  page: Page,
  options: {
    readonly embeddingSetId: string;
    readonly foregroundProbeLabel: string;
    readonly probeIndex: number;
  }
): Promise<SustainedQueueProfileSample> {
  return await page.evaluate<SustainedQueueProfileSample, typeof options>(async (input) => {
    const db = window.electronAPI?.db;
    if (!(db?.query && db.diagnostics && db.schedulerSnapshot)) {
      throw new Error('Required Turso sustained queue diagnostics bridge is unavailable.');
    }

    const readQueueStats = async (): Promise<SustainedQueueStats> => {
      const result = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
           COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS running,
           COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded
         FROM job_queue
         WHERE queue = 'embeddings'
           AND job_type = 'embed_chunk'
           AND embedding_set_id = ?`,
        [input.embeddingSetId],
        { label: 'turso.queue-profile.sustained-queue-stats', priority: 'background' }
      );
      const row = result.rows[0] as Partial<Record<keyof SustainedQueueStats, number | string>>;
      return {
        failed: Number(row.failed ?? 0),
        queued: Number(row.queued ?? 0),
        running: Number(row.running ?? 0),
        succeeded: Number(row.succeeded ?? 0),
      };
    };

    const queueStatsBeforeProbe = await readQueueStats();
    await db.query('SELECT ? AS value', [input.probeIndex], {
      label: input.foregroundProbeLabel,
      priority: 'foreground',
    });
    const queueStatsAfterProbe = await readQueueStats();

    const diagnostics = await db.diagnostics();
    const scheduler = await db.schedulerSnapshot();
    const desktop = await window.desktopDiagnostics?.getSnapshot();
    const profile = desktop?.tursoQueueProfile as SustainedQueueProfile | undefined;

    if (diagnostics.profileBootstrapReport?.runtime.engine !== 'turso') {
      throw new Error(
        `Expected Turso runtime, got ${diagnostics.profileBootstrapReport?.runtime.engine ?? 'missing'}`
      );
    }
    if (!diagnostics.tursoOwnerClientQoS.available) {
      throw new Error(
        `Expected Turso owner QoS diagnostics, got ${diagnostics.tursoOwnerClientQoS.reason}`
      );
    }
    if (!profile) {
      throw new Error('Desktop Turso queue profile diagnostics are missing.');
    }

    const ownerLabels = diagnostics.tursoOwnerClientQoS.recentCompletedOperations.map(
      (operation) => `${operation.priority}:${operation.label}`
    );
    const hiddenWorkerOwnerLabelCount = ownerLabels.filter((label) =>
      label.startsWith('background:turso.embedding-worker.queue.')
    ).length;
    const foregroundProbeOwnerLabelCount = ownerLabels.filter(
      (label) => label === `foreground:${input.foregroundProbeLabel}`
    ).length;
    const hadActiveBackfillBeforeProbe =
      queueStatsBeforeProbe.queued + queueStatsBeforeProbe.running > 0;

    return {
      activeBackfillProbeSamples: hadActiveBackfillBeforeProbe ? 1 : 0,
      foregroundProbeOwnerLabelCount,
      foregroundProbeSamples: input.probeIndex,
      hiddenWorkerOwnerLabelCount,
      ownerLabels,
      profile,
      queueStatsAfterProbe,
      queueStatsBeforeProbe,
      schedulerBackgroundCompleted: scheduler.priorityStats.background.completed,
      schedulerForegroundCompleted: scheduler.priorityStats.foreground.completed,
    };
  }, options);
}

async function getTursoEmbeddingSetQueueStats(
  page: Page,
  embeddingSetId: string
): Promise<SustainedQueueStats> {
  return await page.evaluate<SustainedQueueStats, string>(async (id) => {
    const db = window.electronAPI?.db;
    if (!db?.query) {
      throw new Error('Required Turso queue stats DB bridge is unavailable.');
    }
    const result = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
         COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS running,
         COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded
       FROM job_queue
       WHERE queue = 'embeddings'
         AND job_type = 'embed_chunk'
         AND embedding_set_id = ?`,
      [id],
      { label: 'turso.queue-profile.wait-queue-stats', priority: 'background' }
    );
    const row = result.rows[0] as Partial<Record<keyof SustainedQueueStats, number | string>>;
    return {
      failed: Number(row.failed ?? 0),
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      succeeded: Number(row.succeeded ?? 0),
    };
  }, embeddingSetId);
}

function summarizeSustainedQueueProfileSamples(
  samples: readonly SustainedQueueProfileSample[],
  totalChunks: number
): SustainedQueueProfileSummary {
  const finalSample = samples.at(-1);
  if (!finalSample) {
    throw new Error('Sustained Turso queue profile produced no samples.');
  }
  const activeBackfillProbeSamples = samples.reduce(
    (total, sample) => total + sample.activeBackfillProbeSamples,
    0
  );
  return {
    activeBackfillProbeSamples,
    finalProfile: finalSample.profile,
    foregroundProbeOwnerLabelCount: Math.max(
      ...samples.map((sample) => sample.foregroundProbeOwnerLabelCount)
    ),
    foregroundProbeSamples: Math.max(...samples.map((sample) => sample.foregroundProbeSamples)),
    hiddenWorkerOwnerLabelCount: Math.max(
      ...samples.map((sample) => sample.hiddenWorkerOwnerLabelCount)
    ),
    samples,
    totalChunks,
  };
}

async function cancelSustainedBackfills(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      await window.embeddingHost?.cancelAllBackfills?.();
    })
    .catch(() => undefined);
  await clearEmbeddingQueue(page).catch(() => undefined);
}

async function seedQueuedEmbeddingJob(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = window.electronAPI?.db;
    if (!db?.query) {
      throw new Error('Required Turso queue profile DB query bridge is unavailable.');
    }

    const now = new Date().toISOString();
    const suffix = Math.random().toString(36).slice(2, 10);
    await db.query(
      `INSERT INTO job_queue (
         id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, 'queued', ?, 0, 3, 0, ?, ?)`,
      [
        `turso-queue-profile-job-${suffix}`,
        'embeddings',
        'embed_chunk',
        JSON.stringify({ source: 'turso-queue-profile' }),
        now,
        now,
        now,
      ],
      { label: 'turso.queue-profile.seed-job', priority: 'background' }
    );
  });
}

async function assertEmbeddingHostTursoProviderInitialized(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const status = await window.embeddingHost.ensureStarted();
    if (status.state === 'error') {
      throw new Error(`Embedding host failed to start: ${status.lastError ?? 'unknown error'}`);
    }
  });

  const hostPage = await getEmbeddingHostPage(page);
  await expect
    .poll(
      async () => {
        const logs = await getRendererLogRecords(hostPage);
        return logs.some((record) =>
          recordContainsText(
            record,
            'Desktop Turso DB provider initialized with migrated repository coverage'
          )
        );
      },
      {
        intervals: [250, 500, 1000],
        timeout: 15_000,
      }
    )
    .toBe(true);
}

async function assertNoTursoProviderBootstrapErrors(page: Page): Promise<void> {
  const forbiddenPatterns = [
    /Failed to detect pgvector extension over IPC/i,
    /Desktop database initialization missing pgvector extension/i,
    /pgvector extension is required for desktop/i,
  ];
  const logs = [...(await getRendererLogRecords(page)), ...(await getMainBufferedLogs(page))].map(
    (entry) => JSON.stringify(entry)
  );
  const matchingLogs = logs.filter((line) =>
    forbiddenPatterns.some((pattern) => pattern.test(line))
  );

  expect(matchingLogs).toEqual([]);
}
