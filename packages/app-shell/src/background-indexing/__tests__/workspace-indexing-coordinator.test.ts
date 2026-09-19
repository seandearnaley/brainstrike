import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceIndexingCoordinator,
  type WorkspaceIndexingCoordinatorInputs,
  type WorkspaceIndexingCoordinatorService,
} from '../workspace-indexing-coordinator';

const ROOT = {
  kind: 'directory' as const,
  name: 'root',
  path: '/workspace/root',
  platform: 'electron' as const,
};

function deferred(): {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  let reject = (_error: Error): void => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function createService(): WorkspaceIndexingCoordinatorService {
  return {
    cancel: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
  };
}

function createInputs(
  service: WorkspaceIndexingCoordinatorService,
  overrides: Partial<WorkspaceIndexingCoordinatorInputs> = {}
): WorkspaceIndexingCoordinatorInputs {
  return {
    enabled: true,
    hasHydrated: true,
    indexingPolicyPreset: 'balanced',
    isAccessLoading: false,
    managedCollectionId: 'collection-1',
    onBootstrap: () => false,
    onError: vi.fn(),
    publishPaused: vi.fn(),
    publishRuntimeUnavailable: vi.fn(),
    publishWaiting: vi.fn(),
    readPauseReasons: () => [],
    readRootDirectoryHandle: () => ROOT,
    resolveTargets: async () => [
      {
        adapterRootId: 'adapter-root-1',
        backfillMode: 'enqueue',
        dbRootId: 'db-root-1',
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'collection-1',
        rootDirectoryHandle: ROOT,
        scope: { mode: 'full' },
      },
    ],
    service,
    ...overrides,
  };
}

describe('WorkspaceIndexingCoordinator', () => {
  it('coalesces triggers behind the active pass and replays the merged scope once', async () => {
    const firstPass = deferred();
    const service = createService();
    vi.mocked(service.sync)
      .mockImplementationOnce(async () => firstPass.promise)
      .mockResolvedValue(undefined);
    const inputs = createInputs(service);
    const resolveTargets = vi.fn(inputs.resolveTargets);
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs({ ...inputs, resolveTargets });

    coordinator.trigger({ mode: 'full' });
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(1));
    coordinator.trigger({
      mode: 'paths',
      roots: [{ changes: [], rootId: 'root-1' }],
    });
    coordinator.trigger({ mode: 'full' });

    expect(service.cancel).not.toHaveBeenCalled();
    firstPass.resolve();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(2));
    expect(resolveTargets).toHaveBeenCalledTimes(2);
    expect(resolveTargets.mock.calls[1]?.[0]).toEqual({ mode: 'full' });
  });

  it('updates focused-root inputs without invalidating host-owned work', async () => {
    const activePass = deferred();
    const service = createService();
    vi.mocked(service.sync).mockImplementation(async () => activePass.promise);
    const coordinator = new WorkspaceIndexingCoordinator();
    let focusedRoot = ROOT;
    coordinator.updateInputs(createInputs(service, { readRootDirectoryHandle: () => focusedRoot }));
    coordinator.trigger();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(1));

    focusedRoot = { ...ROOT, path: '/workspace/focused-root' };

    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.detach).not.toHaveBeenCalled();
    activePass.resolve();
  });

  it('invalidates a stale multi-root pass before the next root when explicitly cancelled', async () => {
    const firstRoot = deferred();
    const service = createService();
    vi.mocked(service.sync).mockImplementationOnce(async () => firstRoot.promise);
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(
      createInputs(service, {
        resolveTargets: async () => [
          {
            enabled: true,
            indexingPolicyPreset: 'balanced',
            managedCollectionId: 'collection-1',
            rootDirectoryHandle: ROOT,
            scope: { mode: 'full' },
          },
          {
            enabled: true,
            indexingPolicyPreset: 'balanced',
            managedCollectionId: 'collection-1',
            rootDirectoryHandle: { ...ROOT, path: '/workspace/root-2' },
            scope: { mode: 'full' },
          },
        ],
      })
    );
    coordinator.trigger();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(1));

    const cancel = coordinator.cancel();
    firstRoot.resolve();
    await cancel;

    expect(service.cancel).toHaveBeenCalledTimes(1);
    expect(service.sync).toHaveBeenCalledTimes(1);
  });

  it('does not let a superseded finalizer erase the replacement pass pending trigger', async () => {
    const firstPass = deferred();
    const replacementPass = deferred();
    const service = createService();
    vi.mocked(service.sync)
      .mockImplementationOnce(async () => firstPass.promise)
      .mockImplementationOnce(async () => replacementPass.promise)
      .mockResolvedValue(undefined);
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(createInputs(service));
    coordinator.trigger();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(1));

    coordinator.trigger({ mode: 'full' }, { restartActive: true });
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(2));
    coordinator.trigger({
      mode: 'paths',
      roots: [{ changes: [], rootId: 'root-1' }],
    });

    firstPass.resolve();
    await Promise.resolve();
    replacementPass.resolve();

    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(3));
  });

  it('waits for restart cancellation and prevents the stale pass from reaching its next root', async () => {
    const firstRoot = deferred();
    const cancellation = deferred();
    const service = createService();
    vi.mocked(service.cancel).mockImplementation(async () => cancellation.promise);
    vi.mocked(service.sync)
      .mockImplementationOnce(async () => firstRoot.promise)
      .mockResolvedValue(undefined);
    const replacementRoot = { ...ROOT, path: '/workspace/replacement' };
    const resolveTargets = vi
      .fn<WorkspaceIndexingCoordinatorInputs['resolveTargets']>()
      .mockResolvedValueOnce([
        {
          enabled: true,
          indexingPolicyPreset: 'balanced',
          managedCollectionId: 'collection-1',
          rootDirectoryHandle: ROOT,
          scope: { mode: 'full' },
        },
        {
          enabled: true,
          indexingPolicyPreset: 'balanced',
          managedCollectionId: 'collection-1',
          rootDirectoryHandle: { ...ROOT, path: '/workspace/stale-root-2' },
          scope: { mode: 'full' },
        },
      ])
      .mockResolvedValueOnce([
        {
          enabled: true,
          indexingPolicyPreset: 'balanced',
          managedCollectionId: 'collection-1',
          rootDirectoryHandle: replacementRoot,
          scope: { mode: 'full' },
        },
      ]);
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(createInputs(service, { resolveTargets }));
    coordinator.trigger();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(1));

    coordinator.trigger({ mode: 'full' }, { restartActive: true });
    await vi.waitFor(() => expect(service.cancel).toHaveBeenCalledTimes(1));
    expect(service.sync).toHaveBeenCalledTimes(1);

    cancellation.resolve();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(2));
    firstRoot.resolve();
    await Promise.resolve();

    expect(
      vi.mocked(service.sync).mock.calls.map(([request]) => request.rootDirectoryHandle?.path)
    ).toEqual([ROOT.path, replacementRoot.path]);
  });

  it('does not report stale service failures after cancellation', async () => {
    const activePass = deferred();
    const onError = vi.fn();
    const service = createService();
    vi.mocked(service.sync).mockImplementation(async () => activePass.promise);
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(createInputs(service, { onError }));
    coordinator.trigger();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(1));

    await coordinator.cancel();
    activePass.reject(new Error('stale failure'));
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it('does not report stale target-resolution failures after cancellation', async () => {
    const targetResolution = deferred();
    const onError = vi.fn();
    const service = createService();
    const resolveTargets = vi.fn(async () => {
      await targetResolution.promise;
      return [];
    });
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(createInputs(service, { onError, resolveTargets }));
    coordinator.trigger();
    await vi.waitFor(() => expect(resolveTargets).toHaveBeenCalledTimes(1));

    await coordinator.cancel();
    targetResolution.reject(new Error('stale resolution failure'));
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it('detaches local tracking without cancelling the durable service run', async () => {
    const service = createService();
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(createInputs(service));

    await coordinator.detach(service);

    expect(service.detach).toHaveBeenCalledTimes(1);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('publishes pause state and cancels when updated inputs become paused', async () => {
    const service = createService();
    const publishPaused = vi.fn();
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(
      createInputs(service, {
        publishPaused,
        readPauseReasons: () => ['Paused manually'],
      })
    );

    coordinator.trigger();
    await vi.waitFor(() => expect(service.cancel).toHaveBeenCalledTimes(1));
    expect(publishPaused).toHaveBeenCalledWith({
      activeRootPath: ROOT.path,
      managedCollectionId: 'collection-1',
      pauseReasons: ['Paused manually'],
    });
  });

  it('publishes runtime availability from current inputs', () => {
    const publishRuntimeUnavailable = vi.fn();
    let focusedRoot = ROOT;
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(
      createInputs(createService(), {
        publishRuntimeUnavailable,
        readRootDirectoryHandle: () => focusedRoot,
        service: null,
      })
    );

    focusedRoot = { ...ROOT, path: '/workspace/focused-root' };

    coordinator.trigger();

    expect(publishRuntimeUnavailable).toHaveBeenCalledWith({
      activeRootPath: '/workspace/focused-root',
      enabled: true,
      managedCollectionId: 'collection-1',
    });
  });
});
