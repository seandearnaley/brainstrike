// @vitest-environment node

import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import type { HostAttachment, HostRecord } from '@brainstrike/host-lease';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAgentHostMainClient } from '../agent-host-main-client';
import { createDesktopWorkspaceRootCatalog } from '../agent-host-platform/workspace-root-client';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
// BST-2247: quitting while the agent host is still starting. Main's real shutdown runner and
// the owners its steps call (host profile admission, its profile runtime, the desktop
// catalog client and Main's own host client), over a host start-up that never completes on
// its own. The step order mirrors main.ts.
import {
  HOST_LEASE_CLOSED,
  isQuitTerminalRefusal,
  isRetirementRefusal,
  markDesktopShuttingDown,
  resetDesktopShutdownStateForTests,
} from '../desktop-shutdown-state';
import { createDesktopHostLease } from '../host-lease-manager';
import { createHostProfileAdmission, type HostProfileAdmission } from '../host-profile-admission';
import {
  createDesktopGracefulShutdown,
  DESKTOP_SHUTDOWN_STEP_ORDER,
  type DesktopShutdownStepName,
  type DesktopShutdownStepRun,
} from '../main/desktop-graceful-shutdown';
import { prepareMainCatalogClose } from '../main/main-catalog-close';

const mocks = vi.hoisted(() => ({
  acquireProfile: vi.fn(),
  closeProfile: vi.fn(),
  createProfileOwner: vi.fn(),
}));
vi.mock('../host-lease-manager', () => ({
  createDesktopHostLease: () => {
    mocks.createProfileOwner();
    return { acquire: () => mocks.acquireProfile(), close: mocks.closeProfile };
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(resetDesktopShutdownStateForTests);

function admission(): HostProfileAdmission {
  return createHostProfileAdmission(
    createDesktopProfileRuntime(() => createDesktopHostLease({ root: '/owned/profile' }))
  );
}

/** Main's borrowers wait on the start-up, then the app quits; `fenced` runs right after the fence. */
async function quitWhileStarting(
  profile: HostProfileAdmission,
  fenced: () => void = () => undefined
) {
  const mainClient = createAgentHostMainClient(
    () => profile.acquire(),
    () => undefined
  );
  const workspaceRoots = createDesktopWorkspaceRootCatalog(() => profile.acquire());
  const catalogWrite = workspaceRoots.workspaceRoots({
    operation: 'register',
    root: {
      canonicalPath: '/disposable/startup-root',
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
  steps['main-catalog'] = () =>
    prepareMainCatalogClose({ prepareClose: async () => undefined }, workspaceRoots);
  steps['host-profile'] = async () => {
    await mainClient.close();
    await profile.retire();
  };
  const exitProcess = vi.fn();
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  await createDesktopGracefulShutdown({
    exitProcess,
    logger,
    markShuttingDown: markDesktopShuttingDown,
    planRun: () => ({
      closeDatabase: () => profile.retire(),
      closeErrorLogSink: () => undefined,
      steps,
    }),
    retireBackgroundAdmission: () => {
      profile.fenceTerminal();
      fenced();
    },
    // No deadline (ADR-0026): a quit that waited on the start-up would hang this test.
  }).run('before-quit');

  await expect(catalogWrite).rejects.toSatisfy(isQuitTerminalRefusal);
  expect(exitProcess).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith(
    'Graceful shutdown completed',
    expect.objectContaining({ trigger: 'before-quit' })
  );
  // The borrowers stopped as quit began, with the typed retirement refusal.
  const refused = await ledgerRead.then(
    () => undefined,
    (error: unknown) => error
  );
  expect(isQuitTerminalRefusal(refused)).toBe(true);
}

it('a quit while the host is still starting stops its borrowers at the fence, cancels the start-up through its owner, and completes without waiting for it', async () => {
  const profile = admission();
  // The host start-up never completes; only its owner's close ends it, with the lease's own
  // closing refusal (BST-2118), as the real lease's close aborts a start in flight.
  const startup = Promise.withResolvers<undefined>();
  mocks.acquireProfile.mockImplementation(() => startup.promise);
  mocks.closeProfile.mockImplementation(async (reason: unknown) => {
    startup.reject(reason ?? new BoundaryFailureError(HOST_LEASE_CLOSED));
  });

  await quitWhileStarting(profile);

  // The start-up was cancelled through its owner once, and nothing started another.
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
  await expect(startup.promise).rejects.toSatisfy(isRetirementRefusal);
  expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
  await expect(profile.acquire()).rejects.toSatisfy(isQuitTerminalRefusal);
});

it('a start-up that completes after the fence leaves its attachment to the lease, which closes it exactly once', async () => {
  const profile = admission();
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
  await quitWhileStarting(profile, () => startup.resolve(late));

  expect(late.close).toHaveBeenCalledOnce();
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
  expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
});
