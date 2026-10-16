/**
 * Canonical ingestion in the file index worker (BST-1940): desktop's
 * workspace runtime, with desktop's catalog, publication, scan admission and
 * source inventory, over this worker's scoped store and the writer's
 * catalogs. Only the source differs: a File System Access folder, lent by
 * `fsaWorkspaceLease`. TEXT only; vectors come with the index's profile.
 */
import {
  type CanonicalScanReceipt,
  CanonicalWorkspaceIngestionRuntime,
  createNativeCanonicalCatalog,
  createNativeCanonicalPublication,
  createNativeScanAdmission,
  createNativeSourceInventory,
  decodeNativeCanonicalCatalogRecords,
  type NativeCanonicalCatalogRecord,
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
}

interface RootIngestion {
  /** The folder the root's runtime reads. */
  readonly folder: FileSystemDirectoryHandle;
  readonly lease: FsaWorkspaceLease;
  readonly runtime: CanonicalWorkspaceIngestionRuntime;
  /** Callers waiting for the next pass's receipt, or its failure. */
  readonly waiting: {
    readonly reject: (error: unknown) => void;
    readonly resolve: (receipt: CanonicalScanReceipt) => void;
  }[];
}

export class FileIngestion {
  readonly #roots = new Map<string, Promise<RootIngestion>>();
  #closed = false;

  constructor(private readonly dependencies: FileIngestionDependencies) {}

  /**
   * Runs a pass over a live root's folder; resolves with its receipt. A root
   * keeps the folder its runtime started on: another folder for it is refused.
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
    const receipt = new Promise<CanonicalScanReceipt>((resolve, reject) =>
      root.waiting.push({ reject, resolve })
    );
    if (existing) {
      root.runtime.trigger();
    } else {
      // A started runtime runs its first full pass.
      await root.runtime.start();
    }
    return receipt;
  }

  async #open(rootId: string, folder: FileSystemDirectoryHandle): Promise<RootIngestion> {
    const { catalog: sourceCatalog, port } = this.dependencies;
    const root = (await this.dependencies.roots()).find((current) => current.id === rootId);
    if (root?.status !== 'live') {
      throw new Error('Only a live workspace root can be scanned.');
    }
    const lease = fsaWorkspaceLease(rootId, folder);
    const scope = { kind: 'workspace', rootId } as const;
    const assertSource = (): void => lease.signal.throwIfAborted();
    const admission = createNativeScanAdmission(assertSource, lease.signal);
    const loadRecords = async (): Promise<readonly NativeCanonicalCatalogRecord[]> => {
      // The TEXT partition: the root's files in no collection.
      const { files } = await sourceCatalog.sourceCatalog({
        embeddingSetId: null,
        operation: 'inventory',
      });
      return decodeNativeCanonicalCatalogRecords(files).filter(
        (record) => record.rootId === rootId
      );
    };
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
      resolveProfile: async () => {
        throw new Error('The browser file index publishes TEXT only.');
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
          embeddingSetId: null,
          resolveIdentity: fileIdentity,
        };
      },
    });
    const ingestion: RootIngestion = {
      folder,
      lease,
      runtime: new CanonicalWorkspaceIngestionRuntime({
        catalog,
        chunker: createBrowserChunker(),
        managedCollectionId: null,
        mode: 'TEXT',
        // A pass that fails reports no receipt: its waiting scans fail with it, visibly.
        onError: (operation, error) => {
          this.dependencies.onError(operation, error);
          for (const waiter of ingestion.waiting.splice(0)) {
            waiter.reject(error);
          }
        },
        onReceipt: (receipt, sourceInvalidated) => {
          if (sourceInvalidated) {
            admission.releaseInvalidatedWorkspace(receipt);
          } else {
            admission.completeWorkspace(receipt);
          }
          for (const waiter of ingestion.waiting.splice(0)) {
            waiter.resolve(receipt);
          }
        },
        onWatchHealth: () => {},
        publication: admission.workspacePublication(
          createNativeCanonicalPublication(port, [scope])
        ),
        request: {
          batchSize: this.dependencies.scan.batchSize,
          chunkingOptions: { strategy: 'auto' },
          maxFileBytes: this.dependencies.scan.maxFileBytes,
        },
        source: {
          indexingPolicyPreset: 'balanced',
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
      waiting: [],
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
        settled.value.lease.revoke(new DOMException('File ingestion retired.', 'AbortError'));
        await settled.value.runtime.close();
        await settled.value.lease.retire();
      }
    }
  }
}
