// @vitest-environment node

import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAgentHostMainClient } from '../agent-host-main-client';
import { createDesktopWorkspaceRootCatalog } from '../agent-host-platform/workspace-root-client';
// BST-2247: quitting while the agent host is still starting. Main's real shutdown runner and
// the owners its steps call (native index activation, its profile runtime, the desktop
// catalog client, Main's own host client and the startup snapshot maintenance), over a host
// start-up that never completes on its own. The step order mirrors main.ts.
import type { SnapshotService } from '../assistant-server/snapshot-service';
import {
  HOST_LEASE_CLOSED,
  isRetirementRefusal,
  markDesktopShuttingDown,
  resetDesktopShutdownStateForTests,
} from '../desktop-shutdown-state';
import {
  createDesktopGracefulShutdown,
  DESKTOP_SHUTDOWN_STEP_ORDER,
  type DesktopShutdownStepName,
  type DesktopShutdownStepRun,
} from '../main/desktop-graceful-shutdown';
import { startSnapshotStartupMaintenance } from '../main/snapshot-lifecycle';
import { fixture, mocks, resetActivationFixture } from './native-index-activation-fixture';

beforeEach(resetActivationFixture);
afterEach(resetDesktopShutdownStateForTests);

/** Far above what this shutdown needs; a quit that waits for the start-up exhausts it. */
const STEP_DEADLINE_MS = 1000;

it('a quit while the host is still starting stops its borrowers at the fence, cancels the start-up through its owner, and completes within the step deadline', async () => {
  const { activation } = fixture();
  // The host start-up never completes; only its owner's close ends it, with the lease's own
  // closing refusal (BST-2118), as the real lease's close aborts a start in flight.
  const startup = Promise.withResolvers<undefined>();
  mocks.acquireProfile.mockImplementation(() => startup.promise);
  mocks.closeProfile.mockImplementation(async (reason: unknown) => {
    startup.reject(reason ?? new BoundaryFailureError(HOST_LEASE_CLOSED));
  });
  const mainClient = createAgentHostMainClient(
    () => activation.acquireProfile(),
    () => undefined,
    async () => undefined
  );
  const maintenanceLog = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const maintenance = startSnapshotStartupMaintenance({
    logger: maintenanceLog,
    readHostThreadIds: async () =>
      new Set((await mainClient.request('ledger/read', {})).threads.map((row) => row.threadId)),
    readHostThreadRows: async (threadId) =>
      (await mainClient.request('thread/read', { fromSeq: 0, threadId })).rows,
    snapshotService: {} as SnapshotService,
    snapshotsBaseDir: '/unused/snapshots',
    workspaceRoots: createDesktopWorkspaceRootCatalog(() => activation.acquireProfile()),
  });
  // Main's own client is waiting on the same start-up.
  const ledgerRead = mainClient.request('ledger/read', {});
  ledgerRead.catch(() => undefined);
  await vi.waitFor(() => expect(mocks.acquireProfile).toHaveBeenCalledOnce());

  const noop: DesktopShutdownStepRun = () => undefined;
  const steps = Object.fromEntries(
    DESKTOP_SHUTDOWN_STEP_ORDER.map((step) => [step, noop])
  ) as Record<DesktopShutdownStepName, DesktopShutdownStepRun>;
  steps['snapshot-maintenance'] = () => maintenance.stop();
  steps['native-index'] = async () => {
    await mainClient.close();
    await activation.close();
  };
  const exitProcess = vi.fn();
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const shutdown = createDesktopGracefulShutdown({
    deadlineMs: STEP_DEADLINE_MS,
    exitProcess,
    logger,
    markShuttingDown: markDesktopShuttingDown,
    planRun: () => ({
      closeDatabase: () => activation.close(),
      closeErrorLogSink: () => undefined,
      steps,
    }),
    retireBackgroundAdmission: () => activation.fenceTerminal(),
  });

  await shutdown.run('before-quit', 'before-quit');

  expect(exitProcess).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith(
    'Graceful shutdown completed',
    expect.objectContaining({ trigger: 'before-quit' })
  );
  // The borrowers stopped as quit began, with the typed retirement refusal.
  expect(maintenanceLog.info).toHaveBeenCalledWith(
    'Workspace snapshot orphan sweep stopped: the app is quitting',
    expect.objectContaining({ reason: expect.stringContaining('terminal retirement') })
  );
  expect(maintenanceLog.error).not.toHaveBeenCalled();
  const refused = await ledgerRead.then(
    () => undefined,
    (error: unknown) => error
  );
  expect(isRetirementRefusal(refused)).toBe(true);
  // The start-up was cancelled through its owner once, and nothing started another.
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
  await expect(startup.promise).rejects.toSatisfy(isRetirementRefusal);
  expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
  await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
});
