import type { DirectoryHandle, FileSystemChange } from '@brainstrike/types';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import type { WorkspaceScanScope } from './workspace-scan.js';

interface WorkspaceIndexingRequest {
  enabled: boolean;
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  managedCollectionId: string | null;
  rootDirectoryHandle: DirectoryHandle | null;
  scope?: WorkspaceScanScope;
}

export type WorkspaceIndexingTriggerScope =
  | { mode: 'full' }
  | {
      mode: 'paths';
      roots: Array<{
        changes: readonly FileSystemChange[];
        fullResync?: boolean;
        rootId: string;
      }>;
    };

export interface WorkspaceIndexingTriggerOptions {
  restartActive?: boolean;
}

export interface WorkspaceIndexingCoordinatorService {
  cancel(): Promise<void>;
  detach(): Promise<void>;
  sync(request: WorkspaceIndexingRequest): Promise<void>;
}
type RootDirectoryHandle = WorkspaceIndexingRequest['rootDirectoryHandle'];

/**
 * The index partition a sync writes (BST-1988). A collection partition (the web
 * producer, desktop vectors) syncs only once its collection is chosen. The
 * native TEXT partition is per root and has no collection, so it never waits
 * for one: text search needs no embedding model.
 */
export type WorkspaceIndexPartition =
  | { readonly kind: 'collection'; readonly managedCollectionId: string | null }
  | { readonly kind: 'text' };

function partitionCollectionId(partition: WorkspaceIndexPartition): string | null {
  return partition.kind === 'collection' ? partition.managedCollectionId : null;
}

function isPartitionReady(partition: WorkspaceIndexPartition): boolean {
  return partition.kind === 'text' || Boolean(partition.managedCollectionId);
}

export interface WorkspaceIndexingCoordinatorInputs {
  enabled: boolean;
  hasHydrated: boolean;
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  isAccessLoading: boolean;
  onBootstrap: () => boolean;
  onError: (operation: string, error: unknown) => void;
  partition: WorkspaceIndexPartition;
  publishPaused: (args: {
    activeRootPath: string | null;
    managedCollectionId: string | null;
    pauseReasons: readonly string[];
  }) => void;
  publishRuntimeUnavailable: (args: {
    activeRootPath: string | null;
    enabled: boolean;
    managedCollectionId: string | null;
  }) => void;
  publishWaiting: (args: { activeRootPath: string; managedCollectionId: string | null }) => void;
  readPaused: () => boolean;
  readPauseReasons: () => readonly string[];
  readRootDirectoryHandle: () => RootDirectoryHandle;
  resolveTargets: (
    scope: WorkspaceIndexingTriggerScope,
    context: { isCurrent: () => boolean }
  ) => Promise<readonly WorkspaceIndexingRequest[]>;
  service: WorkspaceIndexingCoordinatorService | null;
}

function mergeScopes(
  current: WorkspaceIndexingTriggerScope | null,
  incoming: WorkspaceIndexingTriggerScope
): WorkspaceIndexingTriggerScope {
  if (current === null) {
    return incoming;
  }
  if (current.mode === 'full' || incoming.mode === 'full') {
    return { mode: 'full' };
  }

  const rootsById = new Map<
    string,
    { changes: FileSystemChange[]; fullResync?: boolean; rootId: string }
  >();
  for (const root of current.roots) {
    rootsById.set(root.rootId, {
      changes: [...root.changes],
      ...(root.fullResync === true ? { fullResync: true } : {}),
      rootId: root.rootId,
    });
  }
  for (const root of incoming.roots) {
    const existing = rootsById.get(root.rootId);
    rootsById.set(root.rootId, {
      changes: [...(existing?.changes ?? []), ...root.changes],
      ...(existing?.fullResync === true || root.fullResync === true ? { fullResync: true } : {}),
      rootId: root.rootId,
    });
  }
  return { mode: 'paths', roots: [...rootsById.values()] };
}

export class WorkspaceIndexingCoordinator {
  private active = false;
  private debugState: Record<string, unknown> = { state: 'not-started' };
  private generation = 0;
  private inputs: WorkspaceIndexingCoordinatorInputs | null = null;
  private pendingScope: WorkspaceIndexingTriggerScope | null = null;

  updateInputs(inputs: WorkspaceIndexingCoordinatorInputs): void {
    this.inputs = inputs;
  }

  getDebugState(): Readonly<Record<string, unknown>> {
    return this.debugState;
  }

  trigger(
    scope: WorkspaceIndexingTriggerScope = { mode: 'full' },
    options: WorkspaceIndexingTriggerOptions = {}
  ): void {
    const inputs = this.inputs;
    if (!inputs?.hasHydrated) {
      return;
    }

    const rootDirectoryHandle = inputs.readRootDirectoryHandle();
    const activeRootPath = rootDirectoryHandle?.path ?? null;
    const managedCollectionId = partitionCollectionId(inputs.partition);
    if (!inputs.service) {
      inputs.publishRuntimeUnavailable({
        activeRootPath,
        enabled: inputs.enabled,
        managedCollectionId,
      });
      return;
    }

    if (inputs.onBootstrap()) {
      return;
    }

    if (inputs.readPaused()) {
      const pauseReasons = inputs.readPauseReasons();
      this.invalidate();
      void inputs.service.cancel().catch((error) => inputs.onError('cancel', error));
      inputs.publishPaused({
        activeRootPath,
        managedCollectionId,
        pauseReasons,
      });
      return;
    }

    if (!(inputs.enabled && isPartitionReady(inputs.partition) && rootDirectoryHandle)) {
      this.invalidateActive(inputs.service, inputs.onError);
      void inputs.service
        .sync({
          enabled: inputs.enabled,
          indexingPolicyPreset: inputs.indexingPolicyPreset,
          managedCollectionId,
          rootDirectoryHandle,
          scope: { mode: 'full' },
        })
        .catch((error) => inputs.onError('sync', error));
      return;
    }

    if (inputs.isAccessLoading) {
      this.invalidate();
      void inputs.service.cancel().catch((error) => inputs.onError('cancel', error));
      inputs.publishWaiting({
        activeRootPath: rootDirectoryHandle.path,
        managedCollectionId,
      });
      return;
    }

    if (this.active) {
      if (options.restartActive === true) {
        this.restartAfterCancellation(scope, inputs, inputs.service);
        return;
      }
      this.pendingScope = mergeScopes(this.pendingScope, scope);
      this.debugState = {
        ...this.debugState,
        pendingScope: this.pendingScope.mode,
        state: 'queued-while-active',
        updatedAt: new Date().toISOString(),
      };
      return;
    }

    this.start(scope, inputs, inputs.service);
  }

  async cancel(): Promise<void> {
    const service = this.inputs?.service;
    this.invalidate();
    if (service) {
      await service.cancel();
    }
  }

  async detach(
    service: WorkspaceIndexingCoordinatorService | null = this.inputs?.service ?? null
  ): Promise<void> {
    this.invalidate();
    if (service) {
      await service.detach();
    }
  }

  private invalidate(): void {
    const cancelledGeneration = this.generation;
    const cancelledState = this.debugState['state'];
    this.generation += 1;
    this.active = false;
    this.pendingScope = null;
    this.debugState = {
      ...this.debugState,
      cancelledGeneration,
      cancelledState,
      state: 'cancelled',
      updatedAt: new Date().toISOString(),
    };
  }

  private invalidateActive(
    service: WorkspaceIndexingCoordinatorService,
    onError: WorkspaceIndexingCoordinatorInputs['onError']
  ): void {
    if (!(this.active || this.pendingScope)) {
      return;
    }
    this.invalidate();
    void service.cancel().catch((error) => onError('cancel', error));
  }

  private start(
    scope: WorkspaceIndexingTriggerScope,
    inputs: WorkspaceIndexingCoordinatorInputs,
    service: WorkspaceIndexingCoordinatorService
  ): void {
    this.generation += 1;
    const generation = this.generation;
    this.active = true;
    this.debugState = {
      ...this.debugState,
      generation,
      scope: scope.mode,
      state: 'resolving-targets',
      updatedAt: new Date().toISOString(),
    };

    const isCurrent = (): boolean => this.generation === generation;
    void this.runPass(scope, inputs, service, generation, isCurrent)
      .catch((error) => {
        if (!isCurrent()) {
          return;
        }
        this.debugState = {
          ...this.debugState,
          error: error instanceof Error ? error.message : String(error),
          generation,
          state: 'sync-loop-error',
          updatedAt: new Date().toISOString(),
        };
        inputs.onError('sync loop', error);
      })
      .finally(() => {
        if (!isCurrent()) {
          return;
        }
        this.active = false;
        const pendingScope = this.pendingScope;
        this.pendingScope = null;
        if (pendingScope) {
          this.trigger(pendingScope);
        }
      });
  }

  private async runPass(
    scope: WorkspaceIndexingTriggerScope,
    inputs: WorkspaceIndexingCoordinatorInputs,
    service: WorkspaceIndexingCoordinatorService,
    generation: number,
    isCurrent: () => boolean
  ): Promise<void> {
    const targets = await inputs.resolveTargets(scope, { isCurrent });
    if (!isCurrent()) {
      return;
    }
    this.debugState = {
      ...this.debugState,
      generation,
      state: targets.length > 0 ? 'syncing' : 'no-syncable-targets',
      syncableTargetCount: targets.length,
      syncableTargetPaths: targets.map((target) => target.rootDirectoryHandle?.path ?? null),
      updatedAt: new Date().toISOString(),
    };
    for (const request of targets) {
      const targetPath = request.rootDirectoryHandle?.path ?? null;
      if (!isCurrent()) {
        return;
      }
      this.debugState = {
        ...this.debugState,
        activeTargetPath: targetPath,
        generation,
        state: 'service-sync-started',
        updatedAt: new Date().toISOString(),
      };
      try {
        // eslint-disable-next-line react-doctor/async-await-in-loop -- Serial root sync prevents cancellation from overlapping root mutations.
        await service.sync(request);
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        this.debugState = {
          ...this.debugState,
          activeTargetPath: targetPath,
          error: error instanceof Error ? error.message : String(error),
          generation,
          state: 'service-sync-error',
          updatedAt: new Date().toISOString(),
        };
        inputs.onError('sync', error);
      }
      if (!isCurrent()) {
        return;
      }
      this.debugState = {
        ...this.debugState,
        activeTargetPath: targetPath,
        completedTargetPath: targetPath,
        generation,
        state: 'service-sync-completed',
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private restartAfterCancellation(
    scope: WorkspaceIndexingTriggerScope,
    inputs: WorkspaceIndexingCoordinatorInputs,
    service: WorkspaceIndexingCoordinatorService
  ): void {
    this.invalidate();
    const generation = this.generation;
    this.active = true;
    this.debugState = {
      ...this.debugState,
      generation,
      scope: scope.mode,
      state: 'restart-cancelling',
      updatedAt: new Date().toISOString(),
    };
    void service.cancel().then(
      () => {
        this.startReplacement(scope, inputs, service, generation);
      },
      (error: unknown) => {
        inputs.onError('cancel', error);
        if (this.generation !== generation) {
          return;
        }
        this.debugState = {
          ...this.debugState,
          error: error instanceof Error ? error.message : String(error),
          generation,
          state: 'restart-cancel-error',
          updatedAt: new Date().toISOString(),
        };
        this.startReplacement(scope, inputs, service, generation);
      }
    );
  }

  private startReplacement(
    scope: WorkspaceIndexingTriggerScope,
    inputs: WorkspaceIndexingCoordinatorInputs,
    service: WorkspaceIndexingCoordinatorService,
    generation: number
  ): void {
    if (this.generation !== generation) {
      return;
    }
    const replacementScope = this.pendingScope ? mergeScopes(scope, this.pendingScope) : scope;
    this.active = false;
    this.pendingScope = null;
    this.start(replacementScope, inputs, service);
  }
}
