// @vitest-environment node

import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import type { HostAttachment, HostRecord } from '@brainstrike/host-lease';
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
import { prepareMainCatalogClose } from '../main/main-catalog-close';
import { startSnapshotStartupMaintenance } from '../main/snapshot-lifecycle';
import { fixture, mocks, resetActivationFixture } from './native-index-activation-fixture';

beforeEach(resetActivationFixture);
afterEach(resetDesktopShutdownStateForTests);

type Activation = ReturnType<typeof fixture>['activation'];

/** Main's borrowers wait on the start-up, then the app quits; `fenced` runs right after the fence. */
async function quitWhileStarting(activation: Activation, fenced: () => void = () => undefined) {
  const mainClient = createAgentHostMainClient(
    () => activation.acquireProfile(),
    () => undefined,
    async () => undefined
  );
  const maintenanceLog = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const workspaceRoots = createDesktopWorkspaceRootCatalog(() => activation.acquireProfile());
  const maintenance = startSnapshotStartupMaintenance({
    logger: maintenanceLog,
    readHostThreadIds: async () =>
      new Set((await mainClient.request('ledger/read', {})).threads.map((row) => row.threadId)),
    readHostThreadRows: async (threadId) =>
      (await mainClient.request('thread/read', { fromSeq: 0, threadId })).rows,
    snapshotService: {} as SnapshotService,
    snapshotsBaseDir: '/unused/snapshots',
    workspaceRoots,
  });
  const catalogWrite = workspaceRoots.workspaceRoots({
    operation: 'register',
    root: {
      displayName: 'disposable startup control',
      path: '/disposable/startup-root',
      preferredId: '44d3c0ba-9dac-40e9-871e-48c99173999a',
    },
  });
  void catalogWrite.catch(() => undefined);
  // Main's own client is waiting on the same start-up.
  const ledgerRead = mainClient.request('ledger/read', {});
  ledgerRead.catch(() => undefined);
  await vi.waitFor(() => expect(mocks.acquireProfile).toHaveBeenCalledOnce());

  const noop: DesktopShutdownStepRun = () => undefined;
  const steps = Object.fromEntries(
    DESKTOP_SHUTDOWN_STEP_ORDER.map((step) => [step, noop])
  ) as Record<DesktopShutdownStepName, DesktopShutdownStepRun>;
  steps['snapshot-maintenance'] = () => maintenance.stop();
  steps['main-catalog'] = () =>
    prepareMainCatalogClose({ prepareClose: async () => undefined }, null, workspaceRoots);
  steps['native-index'] = async () => {
    await mainClient.close();
    await activation.close();
  };
  const exitProcess = vi.fn();
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  await createDesktopGracefulShutdown({
    exitProcess,
    logger,
    markShuttingDown: markDesktopShuttingDown,
    planRun: () => ({
      closeDatabase: () => activation.close(),
      closeErrorLogSink: () => undefined,
      steps,
    }),
    retireBackgroundAdmission: () => {
      activation.fenceTerminal();
      fenced();
    },
    // No deadline (ADR-0026): a quit that waited on the start-up would hang this test.
  }).run('before-quit');

  await expect(catalogWrite).rejects.toMatchObject({ refusal: { kind: 'closed' } });
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
  expect(refused).toMatchObject({ message: expect.stringContaining('terminal retirement') });
}

it('a quit while the host is still starting stops its borrowers at the fence, cancels the start-up through its owner, and completes without waiting for it', async () => {
  const { activation } = fixture();
  // The host start-up never completes; only its owner's close ends it, with the lease's own
  // closing refusal (BST-2118), as the real lease's close aborts a start in flight.
  const startup = Promise.withResolvers<undefined>();
  mocks.acquireProfile.mockImplementation(() => startup.promise);
  mocks.closeProfile.mockImplementation(async (reason: unknown) => {
    startup.reject(reason ?? new BoundaryFailureError(HOST_LEASE_CLOSED));
  });

  await quitWhileStarting(activation);

  // The start-up was cancelled through its owner once, and nothing started another.
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
  await expect(startup.promise).rejects.toSatisfy(isRetirementRefusal);
  expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
  await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
});

it('a start-up that completes after the fence leaves its attachment to the lease, which closes it exactly once', async () => {
  const { activation, onError } = fixture();
  const late: HostAttachment = {
    close: vi.fn(async () => undefined),
    closed: new Promise<void>(() => undefined),
    record: {} as HostRecord,
  };
  const startup = Promise.withResolvers<HostAttachment>();
  mocks.acquireProfile.mockImplementation(() => startup.promise);
  // The real lease owns the attachment it hands out: it registers `closeAttachment` as a
  // finalizer of its Scope before returning it, and its close joins the start, then runs
  // that finalizer (host-lease-manager.ts). Borrowers share that one attachment.
  mocks.closeProfile.mockImplementation(async () => {
    await (await startup.promise).close();
  });

  // The start completes once the fence has already refused its borrowers.
  await quitWhileStarting(activation, () => startup.resolve(late));

  expect(late.close).toHaveBeenCalledOnce();
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
});
