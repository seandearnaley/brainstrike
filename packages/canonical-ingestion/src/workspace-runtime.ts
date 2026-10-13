import { randomUUID } from 'node:crypto';
import {
  WorkspaceIndexingCoordinator,
  type WorkspaceIndexingCoordinatorService,
  type WorkspaceIndexingTriggerScope,
} from '@brainstrike/file-system/workspace-indexing-coordinator';
import { normalizeScopedChangePath } from '@brainstrike/file-system/workspace-scan-paths';
import type {
  DirectoryHandle,
  FileSystemChange,
  WatcherHealthTransition,
} from '@brainstrike/types';
import {
  type CanonicalIngestionDependencies,
  CanonicalIngestionHost,
  CanonicalScanIncompleteError,
} from './host.js';
import type {
  CanonicalManifestFile,
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalScanRequest,
} from './ports.js';
import { CanonicalWorkspaceSource } from './workspace-source.js';
import type {
  CanonicalWorkspaceLease,
  CanonicalWorkspaceSourceDependencies,
} from './workspace-source-ports.js';

type WithoutSource<T> = T extends unknown ? Omit<T, 'source'> : never;
export type CanonicalWorkspaceRuntimeDependencies =
  WithoutSource<CanonicalIngestionDependencies> & {
    /** The workspace's collection, or null for the native TEXT partition (BST-1988). */
    readonly managedCollectionId: string | null;
    readonly onError: (operation: string, error: unknown) => void;
    readonly onReceipt: (receipt: CanonicalScanReceipt, sourceInvalidated?: true) => void;
    readonly onWatchHealth: (health: WatcherHealthTransition) => void;
    readonly request: Omit<CanonicalScanRequest, 'requestId' | 'scope' | 'forceFileIds'>;
    readonly source: Omit<CanonicalWorkspaceSourceDependencies, 'lease' | 'resolveScanScope'> & {
      readonly lease: CanonicalWorkspaceLease;
    };
  };
interface ActivePass {
  readonly context: CanonicalOperationContext;
  readonly controller: AbortController;
  error?: unknown;
  scanStarted: boolean;
  settled: Promise<void>;
  sourceInvalidated: boolean;
}

/** Existing WorkspaceIndexingCoordinator, driven by the existing main watch owner. */
export class CanonicalWorkspaceIngestionRuntime {
  private readonly coordinator = new WorkspaceIndexingCoordinator();
  private readonly source: CanonicalWorkspaceSource;
  private readonly host: CanonicalIngestionHost;
  private readonly watching = new AbortController();
  private readonly rootHandle: DirectoryHandle;
  private active: ActivePass | undefined;
  private closing = false;
  private started = false;
  private closePromise: Promise<void> | undefined;
  private readonly onLeaseRevoked = (): void => {
    void this.close().catch((error) =>
      this.dependencies.onError('mounted source retirement', error)
    );
  };

  constructor(private readonly dependencies: CanonicalWorkspaceRuntimeDependencies) {
    const { managedCollectionId, request } = dependencies;
    if (
      !(
        Number.isSafeInteger(request.batchSize) &&
        request.batchSize > 0 &&
        Number.isSafeInteger(request.maxFileBytes) &&
        request.maxFileBytes > 0 &&
        (managedCollectionId === null || managedCollectionId.trim())
      )
    ) {
      throw new Error(
        'Workspace runtime requires its actual partition and finite positive source bounds.'
      );
    }
    this.source = new CanonicalWorkspaceSource(dependencies.source);
    this.host = new CanonicalIngestionHost({ ...dependencies, source: this.source });
    const lease = dependencies.source.lease;
    this.rootHandle = {
      kind: 'directory',
      name: lease.rootId,
      path: lease.canonicalPath,
      platform: 'electron',
      rootId: lease.rootId,
    };
    const service: WorkspaceIndexingCoordinatorService = {
      cancel: () => this.cancelPass(),
      detach: () => this.cancelPass(),
      sync: (request) => this.sync(request.scope?.mode === 'paths' ? request.scope.changes : []),
    };
    const base = {
      enabled: true,
      indexingPolicyPreset: dependencies.source.indexingPolicyPreset,
      managedCollectionId,
      rootDirectoryHandle: this.rootHandle,
    };
    this.coordinator.updateInputs({
      enabled: base.enabled,
      hasHydrated: true,
      indexingPolicyPreset: base.indexingPolicyPreset,
      isAccessLoading: false,
      onBootstrap: () => false,
      onError: dependencies.onError,
      partition:
        managedCollectionId === null
          ? { kind: 'text' }
          : { kind: 'collection', managedCollectionId },
      publishPaused: () => {},
      publishRuntimeUnavailable: () => {},
      publishWaiting: () => {},
      readPaused: () => false,
      readPauseReasons: () => [],
      readRootDirectoryHandle: () => this.rootHandle,
      resolveTargets: async (scope) => {
        if (scope.mode === 'full') {
          return [{ ...base, scope: { mode: 'full' } }];
        }
        return scope.roots
          .filter((root) => root.rootId === lease.rootId)
          .map((root) => ({
            ...base,
            scope: root.fullResync
              ? { mode: 'full' as const }
              : { changes: root.changes, mode: 'paths' as const },
          }));
      },
      service,
    });
    lease.signal.addEventListener('abort', this.onLeaseRevoked, { once: true });
  }

  async start(): Promise<void> {
    if (this.closing || this.started) {
      throw new Error('Workspace runtime is closed or already started.');
    }
    this.started = true;
    await this.source.subscribe(
      (changes) =>
        this.trigger({
          mode: 'paths',
          roots: [{ changes, rootId: this.dependencies.source.lease.rootId }],
        }),
      (signal) => {
        if (signal.type === 'overflow') {
          if (this.active) {
            this.active.sourceInvalidated = true;
          }
          this.trigger({
            mode: 'paths',
            roots: [
              { changes: [], fullResync: true, rootId: this.dependencies.source.lease.rootId },
            ],
          });
          return;
        }
        this.dependencies.onError('watch', new Error(signal.message));
      },
      this.dependencies.onWatchHealth,
      { requestId: randomUUID(), signal: this.watching.signal }
    );
    if (!this.closing) {
      this.trigger();
    }
  }

  trigger(scope: WorkspaceIndexingTriggerScope = { mode: 'full' }): void {
    if (!this.closing) {
      this.coordinator.trigger(scope);
    }
  }

  cancel(): Promise<void> {
    return this.coordinator.cancel();
  }

  close(): Promise<void> {
    this.closing = true;
    this.watching.abort(new DOMException('Workspace watch retired.', 'AbortError'));
    this.closePromise ??= this.retire().finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }

  private async sync(changes: readonly FileSystemChange[]): Promise<void> {
    if (this.closing || this.active) {
      throw new Error('Workspace pass is closed or still owned.');
    }
    const controller = new AbortController();
    const context = { requestId: randomUUID(), signal: controller.signal };
    const active: ActivePass = {
      context,
      controller,
      scanStarted: false,
      settled: Promise.resolve(),
      sourceInvalidated: false,
    };
    this.active = active;
    const running = this.runPass(active, changes);
    active.settled = running.then(
      () => {},
      (error: unknown) => {
        active.error = error;
      }
    );
    try {
      await running;
    } finally {
      if (this.active === active) {
        this.active = undefined;
      }
    }
  }

  private async runPass(active: ActivePass, changes: readonly FileSystemChange[]): Promise<void> {
    const { catalog, publication, request, source } = this.dependencies;
    const scope = { kind: 'workspace' as const, rootId: source.lease.rootId };
    const inventory = await this.source.loadInventory(scope, active.context);
    const expected: CanonicalManifestFile[] = [];
    for (let offset = 0; offset < inventory.length; offset += request.batchSize) {
      const files = await catalog.loadAuthorizedBatch(
        { files: inventory.slice(offset, offset + request.batchSize), scope },
        active.context
      );
      active.context.signal.throwIfAborted();
      for (const file of files) {
        if (file.contentHash !== null) {
          expected.push({ ...file, contentHash: file.contentHash });
        }
      }
    }
    const coverage = await publication.verifyManifest({ files: expected, scope });
    active.context.signal.throwIfAborted();
    const forcedPaths = new Set(
      changes
        .filter((change) => change.kind === 'file' && change.type !== 'removed')
        .map((change) => normalizeScopedChangePath(change, source.lease.canonicalPath))
    );
    const forceFileIds = new Set(
      inventory
        .filter((file) => file.relativePath !== null && forcedPaths.has(file.relativePath))
        .map((file) => file.fileId)
    );
    const inventoryIds = new Set(inventory.map((file) => file.fileId));
    for (const file of [...coverage.missing, ...coverage.changed]) {
      if (!inventoryIds.has(file.fileId)) {
        throw new Error('Native coverage returned a foreign canonical identity.');
      }
      forceFileIds.add(file.fileId);
    }
    // Accepted watch policy: one full affected-root metadata pass, explicit changed
    // paths force reads, unchanged native-covered survivors keep their stat shortcut.
    active.scanStarted = true;
    try {
      const receipt = await this.host.scan({
        ...request,
        forceFileIds: [...forceFileIds],
        requestId: active.context.requestId,
        scope,
      });
      active.context.signal.throwIfAborted();
      this.dependencies.onReceipt(receipt);
    } catch (error) {
      if (
        error instanceof CanonicalScanIncompleteError &&
        error.receipt.reason === 'manifest-mismatch' &&
        error.receipt.ticket.requestId === active.context.requestId &&
        active.sourceInvalidated &&
        !active.context.signal.aborted
      ) {
        // The watch owner already queued this root's full recovery. Release only
        // this settled source proof; storage and independent scan failures throw.
        this.dependencies.onReceipt(error.receipt, true);
        return;
      }
      throw error;
    } finally {
      active.scanStarted = false;
    }
  }

  private async cancelPass(): Promise<void> {
    const active = this.active;
    if (!active) {
      return;
    }
    active.controller.abort(new DOMException('Workspace pass cancelled.', 'AbortError'));
    const failures: unknown[] = [];
    if (active.scanStarted) {
      try {
        await this.host.cancel(active.context.requestId);
      } catch (error) {
        failures.push(error);
      }
    }
    await active.settled;
    const leaseSignal = this.dependencies.source.lease.signal;
    const expectedCancellation =
      active.error === active.controller.signal.reason ||
      (leaseSignal.aborted && active.error === leaseSignal.reason) ||
      (active.error instanceof Error && active.error.name === 'AbortError');
    if (active.error !== undefined && !expectedCancellation) {
      failures.push(active.error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Workspace pass cancellation failed.');
    }
  }

  private async retire(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.coordinator.cancel();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.host.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Workspace runtime retirement failed.');
    }
    this.dependencies.source.lease.signal.removeEventListener('abort', this.onLeaseRevoked);
  }
}
