/**
 * Canonical ingestion in the file index worker (BST-1940): desktop's
 * workspace runtime, with desktop's catalog, publication, scan admission and
 * source inventory, over this worker's scoped store and the writer's
 * catalogs. Only the source differs: a File System Access folder, lent by
 * `fsaWorkspaceLease`. The saved settings' partition holds the root's files:
 * their collection, or the TEXT partition with none (BST-1988). VECTOR embeds
 * through desktop's canonical inference, with the collection's profile as the
 * saved settings resolve it and the index worker's own embedder.
 */
import {
  type CanonicalScanReceipt,
  CanonicalWorkspaceIngestionRuntime,
  createNativeCanonicalCatalog,
  createNativeCanonicalPublication,
  createNativeScanAdmission,
  createNativeSourceInventory,
  isPartitionRoot,
  loadPartitionRecords,
  NativeCanonicalInference,
  type NativeCanonicalInferenceDependencies,
  type NativeCanonicalProfileResolver,
  type NativeIndexSettings,
} from '@brainstrike/canonical-ingestion/browser';
import { createBrowserChunker } from '@brainstrike/chunking-worker/canonical';
import type { IndexerPort, ScopedIndexerPort, VectorProfile } from '@brainstrike/indexer';
import type { SourceCatalogPort, WorkspaceRootRecord } from '@brainstrike/state-store';
import { webRootPath } from '@brainstrike/web-state-store';
import { fileIdentity } from './file-index-authority';
import type { FileIndexScanOptions } from './file-index-protocol';
import { type FsaWorkspaceLease, fsaWorkspaceLease } from './fsa-workspace-lease';

export interface FileIngestionDependencies {
  /** The writer's source catalog, in its request order. */
  readonly catalog: SourceCatalogPort;
  readonly onError: (operation: string, error: unknown) => void;
  /** The scoped store as it stands, after any reopen. */
  readonly port: ScopedIndexerPort & Pick<IndexerPort, 'info'>;
  /** Rebinds the store to the catalogs' full current authority, as desktop re-acquires its index. */
  readonly rebind: () => Promise<void>;
  /** The writer's workspace roots. */
  readonly roots: () => Promise<readonly WorkspaceRootRecord[]>;
  readonly scan: FileIndexScanOptions;
  /** The saved partition and policy every root's ingestion follows. */
  readonly settings: Pick<
    NativeIndexSettings,
    'indexingPolicyPreset' | 'managedCollectionId' | 'worktreeOptIns'
  >;
  /** VECTOR only: the saved collection's profile and the embedder that produces its vectors. */
  readonly vectors?: {
    readonly resolver: Pick<NativeCanonicalProfileResolver, 'resolve' | 'resolveProfile'>;
    readonly transport: NativeCanonicalInferenceDependencies['transport'];
  };
}

export interface RootIngestion {
  /** The scan whose pass is running: that pass's receipt or failure answers it, and no other. */
  current:
    | {
        readonly reject: (error: unknown) => void;
        readonly resolve: (receipt: CanonicalScanReceipt) => void;
      }
    | undefined;
  /** The folder the root's runtime reads. */
  readonly folder: FileSystemDirectoryHandle;
  /** VECTOR only: the root's inference, retired with its runtime. */
  readonly inference: NativeCanonicalInference | undefined;
  readonly lease: FsaWorkspaceLease;
  /** The root's scans, one pass each, in the order they were asked for. */
  queue: Promise<void>;
  /** Retired with the index's configuration or the root: no further pass runs. */
  retired: boolean;
  readonly runtime: CanonicalWorkspaceIngestionRuntime;
  started: boolean;
}

/**
 * Retires one root's ingestion as desktop retires its sources: the runtime
 * first, which cancels its own pass, then its inference, then the folder's
 * lease. A lease revoked under a running pass would fail the pass, and its
 * retirement with it. Every step runs even when an earlier one fails, so no
 * owner is left unretired once the root is gone; the failures surface together.
 */
export async function retireRootIngestion(
  root: Pick<RootIngestion, 'current' | 'inference' | 'lease' | 'runtime'>
): Promise<void> {
  const retired = new DOMException('File ingestion retired.', 'AbortError');
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<void> | undefined): Promise<void> => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(() => root.runtime.close());
  await attempt(() => root.inference?.close());
  // A pass the runtime cancelled reports nothing: the scan waiting for it fails with the retirement.
  root.current?.reject(retired);
  root.lease.revoke(retired);
  await attempt(() => root.lease.retire());
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'File ingestion retirement failed.');
  }
}

/**
 * Retires a root's ingestion and gives up its place in `roots`, so the next
 * scan opens it afresh. A retirement that fails keeps the place, with its
 * failure: every later scan of the root refuses with it, rather than open a
 * second owner beside one that did not retire.
 */
export async function retireOwnedRoot<T>(
  roots: Map<string, Promise<T>>,
  rootId: string,
  owned: Promise<T>,
  retire: () => Promise<void>
): Promise<void> {
  try {
    await retire();
  } catch (error) {
    if (roots.get(rootId) === owned) {
      const kept = Promise.reject(error);
      kept.catch(() => undefined);
      roots.set(rootId, kept);
    }
    throw error;
  }
  if (roots.get(rootId) === owned) {
    roots.delete(rootId);
  }
}

export class FileIngestion {
  readonly #roots = new Map<string, Promise<RootIngestion>>();
  #closed = false;

  constructor(private readonly dependencies: FileIngestionDependencies) {}

  /**
   * Runs one pass over a live root's folder, after any pass already asked for;
   * resolves with that pass's own receipt. A root keeps the folder its runtime
   * started on: another folder for it is refused.
   */
  async scan(rootId: string, folder: FileSystemDirectoryHandle): Promise<CanonicalScanReceipt> {
    if (this.#closed) {
      throw new Error('File ingestion is closed');
    }
    const existing = this.#roots.get(rootId);
    if (existing && !(await (await existing).folder.isSameEntry(folder))) {
      throw new Error('The workspace root is already ingesting another folder.');
    }
    const opening = existing ?? this.#open(rootId, folder);
    if (!existing) {
      this.#roots.set(rootId, opening);
      opening.catch(() => this.#roots.delete(rootId));
    }
    const root = await opening;
    const pass = root.queue.then(() => this.#pass(rootId, root, opening));
    root.queue = pass.then(
      () => undefined,
      () => undefined
    );
    return pass;
  }

  /** One pass, once the root is confirmed live: a root deleted or disconnected since retires instead. */
  async #pass(
    rootId: string,
    root: RootIngestion,
    owned: Promise<RootIngestion>
  ): Promise<CanonicalScanReceipt> {
    if (root.retired) {
      // Retired since this scan was asked for: after a failed pass a fresh runtime answers it,
      // and a closed index or a root no longer indexed refuses.
      return this.scan(rootId, root.folder);
    }
    if (!(await this.#isLive(rootId))) {
      await retireOwnedRoot(this.#roots, rootId, owned, () => this.#retire(root));
      throw new Error('Only a live workspace root the saved settings index can be scanned.');
    }
    try {
      return await new Promise<CanonicalScanReceipt>((resolve, reject) => {
        root.current = { reject, resolve };
        if (root.started) {
          root.runtime.trigger();
        } else {
          // A started runtime runs its first full pass.
          root.started = true;
          root.runtime.start().catch(reject);
        }
      }).finally(() => {
        root.current = undefined;
      });
    } catch (error) {
      if (!root.retired) {
        // A failed pass keeps its scan admission until its sources retire, as desktop's does:
        // the root's ingestion retires, and the next scan opens it afresh.
        try {
          await retireOwnedRoot(this.#roots, rootId, owned, () => this.#retire(root));
        } catch (retirement) {
          throw new AggregateError(
            [error, retirement],
            "The scan failed, and so did its root's retirement."
          );
        }
      }
      throw error;
    }
  }

  /** A live root the saved settings index: a worktree only once it is opted in. */
  async #isLive(rootId: string): Promise<boolean> {
    const root = (await this.dependencies.roots()).find((current) => current.id === rootId);
    return root !== undefined && isPartitionRoot(root, this.dependencies.settings);
  }

  async #retire(root: RootIngestion): Promise<void> {
    root.retired = true;
    await retireRootIngestion(root);
  }

  async #open(rootId: string, folder: FileSystemDirectoryHandle): Promise<RootIngestion> {
    const { catalog: sourceCatalog, port, settings, vectors } = this.dependencies;
    if (!(await this.#isLive(rootId))) {
      throw new Error('Only a live workspace root the saved settings index can be scanned.');
    }
    const lease = fsaWorkspaceLease(rootId, folder);
    const scope = { kind: 'workspace', rootId } as const;
    const assertSource = (): void => lease.signal.throwIfAborted();
    const admission = createNativeScanAdmission(assertSource, lease.signal);
    // The saved partition's records of this root, as desktop's native index loads its partition's.
    const loadRecords = () =>
      loadPartitionRecords(sourceCatalog, settings, (id) => id === rootId, assertSource);
    const catalog = createNativeCanonicalCatalog<VectorProfile>({
      catalog: sourceCatalog,
      joinNativeRemoval: async (files, removed) => {
        for (const file of files) {
          await port.removeScopedFile({ fileId: file.fileId, scope: removed });
        }
        assertSource();
      },
      replaceTrustedBindings: async (_scope, context) => {
        await admission.acquireBindings(context, () => this.dependencies.rebind());
        assertSource();
      },
      resolveProfile: async (requested, _authority, context) => {
        if (!vectors) {
          throw new Error('TEXT search resolves no vector profile.');
        }
        return vectors.resolver.resolveProfile({ scope: requested }, context);
      },
      resolveScope: async (requested) => {
        assertSource();
        if (requested.kind !== 'workspace' || requested.rootId !== rootId) {
          throw new Error('Canonical catalog scope is not this lease.');
        }
        return {
          assertCurrent: assertSource,
          assertDiscoveredSource: (file) => {
            if (
              file.rootId !== rootId ||
              file.sourcePath !== `${webRootPath(rootId)}/${file.relativePath}`
            ) {
              throw new Error('Canonical discovery differs from its lent folder.');
            }
            assertSource();
          },
          embeddingSetId: settings.managedCollectionId,
          resolveIdentity: fileIdentity,
        };
      },
    });
    const publication = admission.workspacePublication(
      createNativeCanonicalPublication(port, [scope])
    );
    const inference = vectors
      ? new NativeCanonicalInference({
          resolver: vectors.resolver,
          scope,
          transport: vectors.transport,
        })
      : undefined;
    const ingestion: RootIngestion = {
      current: undefined,
      folder,
      inference,
      lease,
      queue: Promise.resolve(),
      retired: false,
      runtime: new CanonicalWorkspaceIngestionRuntime({
        ...(inference
          ? { catalog, inference, mode: 'VECTOR' as const, publication }
          : { catalog, mode: 'TEXT' as const, publication }),
        chunker: createBrowserChunker(),
        managedCollectionId: settings.managedCollectionId,
        // A pass that fails reports no receipt: the scan that asked for it fails with it, visibly.
        onError: (operation, error) => {
          this.dependencies.onError(operation, error);
          ingestion.current?.reject(error);
        },
        onReceipt: (receipt, sourceInvalidated) => {
          if (sourceInvalidated) {
            admission.releaseInvalidatedWorkspace(receipt);
          } else {
            admission.completeWorkspace(receipt);
          }
          ingestion.current?.resolve(receipt);
        },
        onWatchHealth: () => {},
        request: {
          batchSize: this.dependencies.scan.batchSize,
          chunkingOptions: { strategy: 'auto' },
          maxFileBytes: this.dependencies.scan.maxFileBytes,
        },
        source: {
          indexingPolicyPreset: settings.indexingPolicyPreset,
          inventory: createNativeSourceInventory({
            assertSource,
            catalog,
            identity: fileIdentity,
            loadRecords,
            retainCollection: () => {},
            scanAdmission: admission,
            scope,
          }),
          lease,
        },
      }),
      started: false,
    };
    return ingestion;
  }

  /** Retires every root's runtime and its lease. */
  async close(): Promise<void> {
    this.#closed = true;
    const roots = await Promise.allSettled([...this.#roots.values()]);
    this.#roots.clear();
    for (const settled of roots) {
      if (settled.status === 'fulfilled') {
        await this.#retire(settled.value);
      }
    }
  }
}
