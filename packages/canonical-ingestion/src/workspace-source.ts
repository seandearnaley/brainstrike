import { readResolvedWorkspaceFile } from '@brainstrike/file-system/secure-file-read';
import { getContentIndexingError } from '@brainstrike/file-system/workspace-source-content';
import type { IFileNode } from '@brainstrike/types';
import { BINARY_CONTENT_MESSAGE } from '@brainstrike/types';
import { fileContent } from '@brainstrike/utils/file-content';
import { getFileExtension, isBinaryExtension } from '@brainstrike/utils/file-utils';
import { utf8ByteLength } from '@brainstrike/utils/utf8';
import type {
  CanonicalDiscoveredSourceFile,
  CanonicalDiscoveryCompletion,
  CanonicalOperationContext,
  CanonicalScanRequest,
  CanonicalSourceBatch,
  CanonicalSourceFile,
  CanonicalSourcePort,
} from './ports.js';
import { CanonicalSourceContentExcludedError } from './source-content-exclusion.js';
import { discoverCanonicalWorkspace } from './workspace-source-discovery.js';
import type {
  CanonicalSourceSubscription,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceSourceDependencies,
} from './workspace-source-ports.js';

type SourceFile = CanonicalSourceFile | CanonicalDiscoveredSourceFile;
interface SourceRun {
  readonly admitted: WeakSet<SourceFile>;
  readonly context: CanonicalOperationContext;
  readonly nodes: ReadonlyMap<string, IFileNode>;
  readonly request: CanonicalScanRequest;
}
interface PendingOperation {
  readonly promise: Promise<unknown>;
  readonly signal: AbortSignal;
}
const incomplete: CanonicalDiscoveryCompletion = {
  errors: [],
  full: false,
  truncatedDirectories: [],
};

/** Utility-owned orchestration over a borrowed main mount and authoritative PG inventory. */
export class CanonicalWorkspaceSource implements CanonicalSourcePort {
  private readonly stopping = new AbortController();
  private readonly pending = new Set<PendingOperation>();
  private readonly iterators = new Set<ReturnType<CanonicalSourcePort['discover']>>();
  private readonly runs = new Map<string, SourceRun>();
  private readonly subscriptions = new Set<CanonicalSourceSubscription>();
  private closePromise: Promise<void> | undefined;
  private retired = false;

  constructor(private readonly dependencies: CanonicalWorkspaceSourceDependencies) {
    const lease = dependencies.lease;
    lease?.signal.throwIfAborted();
    if (lease && !(lease.rootId.trim() && lease.generation.trim() && lease.canonicalPath.trim())) {
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
      if (run.request.scope.kind === 'collection') {
        if (!('fileId' in file)) {
          throw new Error('Retained source requires its real catalog identity.');
        }
        const result = await this.dependencies.inventory.readRetained(
          file,
          maxFileBytes,
          readContext
        );
        readContext.signal.throwIfAborted();
        if (utf8ByteLength(result.content) > maxFileBytes) {
          throw new Error('Retained source exceeds its explicit byte bound.');
        }
        this.assertContent(result.content, file.fileName, false);
        return result;
      }
      const lease = this.dependencies.lease;
      if (!lease || file.rootId !== lease.rootId || !file.relativePath) {
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
      this.assertContent(content, file.fileName, true);
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
    if (!lease) {
      throw new Error('Watch requires an authorized mounted lease.');
    }
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
      const discovery = await this.own(context, async () => {
        if (request.scope.kind === 'workspace') {
          return discoverCanonicalWorkspace(this.dependencies, request, context);
        }
        const files = await this.dependencies.inventory.loadFiles(request.scope, context);
        const embeddingSetId = request.scope.embeddingSetId;
        if (files.some((file) => file.embeddingSetId !== embeddingSetId)) {
          throw new Error('Retained inventory belongs to another collection.');
        }
        return {
          completion: { errors: [], full: true, truncatedDirectories: [] },
          discovered: [],
          files,
          nodes: new Map<string, IFileNode>(),
          removed: [],
        };
      });
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
    const signals = [context.signal, this.stopping.signal];
    if (this.dependencies.lease) {
      signals.push(this.dependencies.lease.signal);
    }
    return { requestId: context.requestId, signal: AbortSignal.any(signals) };
  }

  private async own<T>(
    context: CanonicalOperationContext,
    operation: () => Promise<T>
  ): Promise<T> {
    context.signal.throwIfAborted();
    const promise = operation();
    const pending = { promise, signal: context.signal };
    this.pending.add(pending);
    try {
      const value = await promise;
      context.signal.throwIfAborted();
      return value;
    } finally {
      this.pending.delete(pending);
    }
  }

  private assertOpen(): void {
    this.stopping.signal.throwIfAborted();
  }

  private assertContent(content: string, fileName: string, filesystem: boolean): void {
    const error = getContentIndexingError({ content, status: 'accessible' });
    if (error) {
      throw filesystem
        ? new CanonicalSourceContentExcludedError('null-byte-content', error)
        : new Error(error);
    }
    if (isBinaryExtension(getFileExtension(fileName)) || !fileContent.isTextContent(content)) {
      throw filesystem
        ? new CanonicalSourceContentExcludedError('binary-content', BINARY_CONTENT_MESSAGE)
        : new Error(BINARY_CONTENT_MESSAGE);
    }
  }

  private async retire(): Promise<void> {
    const pending = [...this.pending];
    const results = await Promise.allSettled(pending.map((operation) => operation.promise));
    const errors: unknown[] = [];
    results.forEach((result, index) => {
      const signal = pending[index]?.signal;
      if (result.status === 'rejected' && !isExpectedAbort(result.reason, signal)) {
        errors.push(result.reason);
      }
    });
    for (const iterator of this.iterators) {
      try {
        await iterator.return(incomplete);
        this.iterators.delete(iterator);
      } catch (error) {
        if (!isExpectedAbort(error, this.stopping.signal)) {
          errors.push(error);
        }
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
    await this.dependencies.lease?.retire();
    this.retired = true;
  }
}

function isExpectedAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true &&
    (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
  );
}
