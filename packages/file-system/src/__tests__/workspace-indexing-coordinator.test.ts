import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceIndexingCoordinator,
  type WorkspaceIndexingCoordinatorInputs,
  type WorkspaceIndexingCoordinatorService,
} from '../workspace-indexing-coordinator.js';

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

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    readPaused: () => false,
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
    coordinator.updateInputs(createInputs(service, { readRootDirectoryHandle: () => focusedRoot }));

    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.detach).not.toHaveBeenCalled();
    activePass.resolve();
    await flushAsyncWork();
    expect(service.sync).toHaveBeenCalledTimes(1);
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
    await flushAsyncWork();

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
    await flushAsyncWork();
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
    await flushAsyncWork();

    expect(
      vi.mocked(service.sync).mock.calls.map(([request]) => request.rootDirectoryHandle?.path)
    ).toEqual([ROOT.path, replacementRoot.path]);
  });

  it('reports a failed cancellation sweep and still starts the requested replacement', async () => {
    const activePass = deferred();
    const onError = vi.fn();
    const service = createService();
    vi.mocked(service.sync)
      .mockImplementationOnce(async () => activePass.promise)
      .mockResolvedValue(undefined);
    vi.mocked(service.cancel).mockRejectedValueOnce(new Error('cancel sweep failed'));
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(createInputs(service, { onError }));
    coordinator.trigger();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(1));

    coordinator.trigger({ mode: 'full' }, { restartActive: true });

    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenCalledWith('cancel', new Error('cancel sweep failed'));
    activePass.resolve();
    await flushAsyncWork();
  });

  it('does not resurrect replacement work after its cancellation sweep is superseded', async () => {
    const activePass = deferred();
    const restartSweep = deferred();
    const onError = vi.fn();
    const service = createService();
    vi.mocked(service.sync).mockImplementation(async () => activePass.promise);
    vi.mocked(service.cancel)
      .mockImplementationOnce(async () => restartSweep.promise)
      .mockResolvedValueOnce(undefined);
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(createInputs(service, { onError }));
    coordinator.trigger();
    await vi.waitFor(() => expect(service.sync).toHaveBeenCalledTimes(1));

    coordinator.trigger({ mode: 'full' }, { restartActive: true });
    await vi.waitFor(() => expect(service.cancel).toHaveBeenCalledTimes(1));
    await coordinator.cancel();
    restartSweep.reject(new Error('superseded sweep failed'));
    await flushAsyncWork();

    expect(service.cancel).toHaveBeenCalledTimes(2);
    expect(service.sync).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('cancel', new Error('superseded sweep failed'));
    activePass.resolve();
    await flushAsyncWork();
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
    await flushAsyncWork();

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
    await flushAsyncWork();

    expect(onError).not.toHaveBeenCalled();
  });

  it('reports failures from the current service pass', async () => {
    const onError = vi.fn();
    const service = createService();
    vi.mocked(service.sync).mockRejectedValueOnce(new Error('current sync failure'));
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(createInputs(service, { onError }));

    coordinator.trigger();

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('sync', new Error('current sync failure'))
    );
  });

  it('reports target-resolution failures from the current pass', async () => {
    const onError = vi.fn();
    const service = createService();
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(
      createInputs(service, {
        onError,
        resolveTargets: async () => {
          throw new Error('current resolution failure');
        },
      })
    );

    coordinator.trigger();

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('sync loop', new Error('current resolution failure'))
    );
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
        readPaused: () => true,
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

  it('cancels and publishes pause state when a paused snapshot has no labels', async () => {
    const service = createService();
    const publishPaused = vi.fn();
    const coordinator = new WorkspaceIndexingCoordinator();
    coordinator.updateInputs(
      createInputs(service, {
        publishPaused,
        readPaused: () => true,
        readPauseReasons: () => [],
      })
    );

    coordinator.trigger();
    await vi.waitFor(() => expect(service.cancel).toHaveBeenCalledTimes(1));
    expect(service.sync).not.toHaveBeenCalled();
    expect(publishPaused).toHaveBeenCalledWith({
      activeRootPath: ROOT.path,
      managedCollectionId: 'collection-1',
      pauseReasons: [],
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
