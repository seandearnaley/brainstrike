/// <reference path="../src/types/electron.d.ts" />

import type { Page } from '@playwright/test';
import {
  waitForAppReadyInTest,
  withTemporaryProcessEnv,
} from './embedding-worker-renderer/electron-app-fixture';
import {
  getEmbeddingHostPage,
  getMainBufferedLogs,
  getRendererLogRecords,
  recordContainsText,
} from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';

test.skip(
  process.env['BRAINSTRIKE_E2E_TURSO_QUEUE_PROFILE'] !== '1',
  'Turso queue profile proof is opt-in.'
);

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
        reason: 'within-thresholds',
        status: 'accepted',
      });
      expect(profile.backgroundCompleted ?? 0).toBeGreaterThan(0);
      expect(profile.ownerCompleted ?? 0).toBeGreaterThan(0);
      expect(profile.schedulerForegroundCompleted ?? 0).toBeGreaterThan(0);
    } finally {
      restoreEnv();
    }
  });
});

async function runQueueProfileProbe(page: Page): Promise<{
  backgroundCompleted?: number;
  ownerCompleted?: number;
  observedBackgroundWork: boolean;
  observedForegroundWork: boolean;
  reason: string;
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
    ownerCompleted?: number;
    reason: string;
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
            ownerCompleted: diagnostics.tursoOwnerClientQoS.totalCompletedOperations,
            reason: profile.reason,
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
      reason: 'within-thresholds',
      status: 'accepted',
    });

  if (!latestProfile) {
    throw new Error('Turso queue profile proof did not produce diagnostics.');
  }
  return latestProfile;
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
