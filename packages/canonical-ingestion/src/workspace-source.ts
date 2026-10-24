import { readResolvedWorkspaceFile } from '@brainstrike/file-system/secure-file-read';
import { getContentIndexingError } from '@brainstrike/file-system/workspace-source-content';
import type { IFileNode } from '@brainstrike/types';
import { BINARY_CONTENT_MESSAGE } from '@brainstrike/types';
import { fileContent } from '@brainstrike/utils/file-content';
import { getFileExtension, isBinaryExtension } from '@brainstrike/utils/file-utils';
import type {
  CanonicalDiscoveredSourceFile,
  CanonicalDiscoveryCompletion,
  CanonicalOperationContext,
  CanonicalScanRequest,
  CanonicalSourceBatch,
  CanonicalSourceFile,
  CanonicalSourcePort,
} from './ports.ts';
import { CanonicalSourceContentExcludedError } from './source-content-exclusion.ts';
import { discoverCanonicalWorkspace } from './workspace-source-discovery.ts';
import type {
  CanonicalSourceSubscription,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceSourceDependencies,
} from './workspace-source-ports.ts';

type SourceFile = CanonicalSourceFile | CanonicalDiscoveredSourceFile;
interface SourceRun {
  readonly admitted: WeakSet<SourceFile>;
  readonly context: CanonicalOperationContext;
  readonly nodes: ReadonlyMap<string, IFileNode>;
  readonly request: CanonicalScanRequest;
}
const incomplete: CanonicalDiscoveryCompletion = {
  errors: [],
  full: false,
  truncatedDirectories: [],
};

/** Utility-owned orchestration over a borrowed main mount and authoritative PG inventory. */
export class CanonicalWorkspaceSource implements CanonicalSourcePort {
  private readonly stopping = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly iterators = new Set<ReturnType<CanonicalSourcePort['discover']>>();
  private readonly runs = new Map<string, SourceRun>();
  private readonly subscriptions = new Set<CanonicalSourceSubscription>();
  private closePromise: Promise<void> | undefined;
  private retired = false;

  private readonly dependencies: CanonicalWorkspaceSourceDependencies;

  constructor(dependencies: CanonicalWorkspaceSourceDependencies) {
    this.dependencies = dependencies;
    const lease = dependencies.lease;
    lease.signal.throwIfAborted();
    if (!(lease.rootId.trim() && lease.generation.trim() && lease.canonicalPath.trim())) {
      throw new Error(
        'Mounted source lease requires its actual root, generation and canonical path.'
      );
    }
  }

  discover(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext
  ): ReturnType<CanonicalSourcePort['discover']> {
    this.assertOpen();
    if (
      !(Number.isSafeInteger(request.batchSize) && request.batchSize > 0) ||
      request.requestId !== context.requestId
    ) {
      throw new Error(
        'Source discovery requires exact request identity and a positive batch bound.'
      );
    }
    const localContext = this.context(context);
    const iterator = this.discoverOwned(request, localContext, () =>
      this.iterators.delete(iterator)
    );
    this.iterators.add(iterator);
    return iterator;
  }

  async read(
    file: SourceFile,
    maxFileBytes: number,
    context: CanonicalOperationContext
  ): ReturnType<CanonicalSourcePort['read']> {
    this.assertOpen();
    const run = this.runs.get(context.requestId);
    if (!(run?.admitted.has(file) && Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0)) {
      throw new Error('Source read requires an admitted canonical file and positive byte bound.');
    }
    const readContext = {
      requestId: context.requestId,
      signal: AbortSignal.any([context.signal, run.context.signal]),
    };
    return this.own(readContext, async () => {
      const lease = this.dependencies.lease;
      if (file.rootId !== lease.rootId || !file.relativePath) {
        throw new Error('Source read belongs to another mounted lease.');
      }
      const node = run.nodes.get(file.relativePath);
      if (!node) {
        throw new Error('Source read has no admitted directory metadata.');
      }
      const content = await readResolvedWorkspaceFile(
        file.sourcePath ?? node.path,
        {
          mounted: {
            root: {
              readFile: (relativePath, maxBytes) =>
                lease.readFile(relativePath, maxBytes, readContext),
            },
          },
          relativePath: file.relativePath,
          traversedSymlink: node.isSymbolicLink === true,
        },
        maxFileBytes
      );
      readContext.signal.throwIfAborted();
      this.assertContent(content, file.fileName);
      return {
        content,
        stat: { mtimeMs: node.lastModified ?? null, size: node.size ?? content.length },
      };
    });
  }

  loadInventory(
    scope: CanonicalScanRequest['scope'],
    context: CanonicalOperationContext
  ): Promise<readonly CanonicalSourceFile[]> {
    this.assertOpen();
    const localContext = this.context(context);
    return this.own(localContext, () => this.dependencies.inventory.loadFiles(scope, localContext));
  }

  async subscribe(
    onBatch: Parameters<CanonicalWorkspaceLease['subscribe']>[0],
    onSignal: Parameters<CanonicalWorkspaceLease['subscribe']>[1],
    onHealth: Parameters<CanonicalWorkspaceLease['subscribe']>[2],
    context: CanonicalOperationContext
  ): Promise<CanonicalSourceSubscription> {
    this.assertOpen();
    const lease = this.dependencies.lease;
    const localContext = this.context(context);
    return this.own(localContext, async () => {
      const subscription = await lease.subscribe(
        (changes, metadata) => {
          if (!localContext.signal.aborted) {
            onBatch(changes, metadata);
          }
        },
        (signal) => {
          if (!localContext.signal.aborted) {
            onSignal(signal);
          }
        },
        (health) => {
          if (!localContext.signal.aborted) {
            onHealth(health);
          }
        },
        localContext
      );
      // Retain even a late acquisition: close joins it after admission has stopped.
      let closing: Promise<void> | undefined;
      const owned: CanonicalSourceSubscription = {
        close: () => {
          closing ??= subscription.close().then(
            () => {
              this.subscriptions.delete(owned);
            },
            (error: unknown) => {
              closing = undefined;
              throw error;
            }
          );
          return closing;
        },
      };
      this.subscriptions.add(owned);
      return owned;
    });
  }

  close(): Promise<void> {
    if (this.retired) {
      return Promise.resolve();
    }
    if (!this.stopping.signal.aborted) {
      this.stopping.abort(new Error('Canonical workspace source closed.'));
    }
    this.closePromise ??= this.retire().finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }

  private async *discoverOwned(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext,
    onRetired: () => void
  ): ReturnType<CanonicalSourcePort['discover']> {
    if (this.runs.has(request.requestId)) {
      throw new Error('Source request is already admitted.');
    }
    this.runs.set(request.requestId, {
      admitted: new WeakSet(),
      context,
      nodes: new Map(),
      request,
    });
    try {
      const discovery = await this.own(context, () =>
        discoverCanonicalWorkspace(this.dependencies, request, context)
      );
      const admitted = new WeakSet<SourceFile>([...discovery.files, ...discovery.discovered]);
      this.runs.set(request.requestId, { admitted, context, nodes: discovery.nodes, request });
      const entries = [
        ...discovery.files.map((file) => ({ file, kind: 'file' as const })),
        ...discovery.discovered.map((file) => ({ file, kind: 'discovered' as const })),
        ...discovery.removed.map((file) => ({ file, kind: 'removed' as const })),
      ];
      for (let offset = 0; offset < entries.length; offset += request.batchSize) {
        context.signal.throwIfAborted();
        const batch: {
          files: CanonicalSourceFile[];
          discovered: CanonicalDiscoveredSourceFile[];
          removed: CanonicalSourceBatch['removed'][number][];
        } = { discovered: [], files: [], removed: [] };
        for (const entry of entries.slice(offset, offset + request.batchSize)) {
          if (entry.kind === 'file') {
            batch.files.push(entry.file);
          } else if (entry.kind === 'discovered') {
            batch.discovered.push(entry.file);
          } else {
            batch.removed.push(entry.file);
          }
        }
        yield batch;
      }
      context.signal.throwIfAborted();
      return discovery.completion;
    } finally {
      this.runs.delete(request.requestId);
      onRetired();
    }
  }

  private context(context: CanonicalOperationContext): CanonicalOperationContext {
    const signals = [context.signal, this.stopping.signal, this.dependencies.lease.signal];
    return { requestId: context.requestId, signal: AbortSignal.any(signals) };
  }

  private async own<T>(
    context: CanonicalOperationContext,
    operation: () => Promise<T>
  ): Promise<T> {
    context.signal.throwIfAborted();
    const promise = operation();
    this.pending.add(promise);
    try {
      const value = await promise;
      context.signal.throwIfAborted();
      return value;
    } finally {
      this.pending.delete(promise);
    }
  }

  private assertOpen(): void {
    this.stopping.signal.throwIfAborted();
  }

  private assertContent(content: string, fileName: string): void {
    const error = getContentIndexingError({ content, status: 'accessible' });
    if (error) {
      throw new CanonicalSourceContentExcludedError('null-byte-content', error);
    }
    if (isBinaryExtension(getFileExtension(fileName)) || !fileContent.isTextContent(content)) {
      throw new CanonicalSourceContentExcludedError('binary-content', BINARY_CONTENT_MESSAGE);
    }
  }

  /**
   * Work this close cancelled settles first, however it ends: its callers own its outcome. Only
   * what this source owns failing to close fails the retirement.
   */
  private async retire(): Promise<void> {
    await Promise.allSettled(this.pending);
    const errors: unknown[] = [];
    for (const iterator of this.iterators) {
      try {
        await iterator.return(incomplete);
        this.iterators.delete(iterator);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const subscription of this.subscriptions) {
      try {
        await subscription.close();
        this.subscriptions.delete(subscription);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Canonical source retirement failed.');
    }
    await this.dependencies.lease.retire();
    this.retired = true;
  }
}
