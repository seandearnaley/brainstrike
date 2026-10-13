import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import type {
  CanonicalOperationContext,
  CanonicalSourceSubscription,
  CanonicalWorkspaceLease,
} from '@brainstrike/canonical-ingestion';
import { getFileSizeConfig } from '@brainstrike/file-system';
import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import { NATIVE_MAX_READ_BYTES } from '@brainstrike/file-system/secure-file-read';
import { MAX_DIRECTORY_ENTRIES } from '@brainstrike/file-system/workspace-root-nodes';
import { resolveReadAgainstMountedRoot } from './workspace-root-read.js';
import type { MountedWorkspaceRoot } from './workspace-root-types.js';

interface SourceLeaseDependencies {
  readonly assertCurrent: () => void;
  readonly mounted: MountedWorkspaceRoot;
  readonly resolveReadPath: (requestedPath: string, canonicalRoot: string) => Promise<string>;
  readonly subscribe: CanonicalWorkspaceLease['subscribe'];
}

interface PendingSourceOperation {
  readonly promise: Promise<unknown>;
  readonly signal: AbortSignal;
}

/** Borrowed operations never close or reopen the registry's mounted native handle. */
export function createWorkspaceRootSourceLease(
  dependencies: SourceLeaseDependencies
): CanonicalWorkspaceLease {
  return new WorkspaceRootSourceLease(dependencies);
}

class WorkspaceRootSourceLease implements CanonicalWorkspaceLease {
  readonly canonicalPath: string;
  readonly generation = randomUUID();
  readonly rootId: string;
  readonly signal: AbortSignal;
  private readonly stopping = new AbortController();
  private readonly pending = new Set<PendingSourceOperation>();
  private readonly subscriptions = new Set<CanonicalSourceSubscription>();
  private retirement: Promise<void> | undefined;
  private retired = false;

  constructor(private readonly dependencies: SourceLeaseDependencies) {
    this.canonicalPath = dependencies.mounted.canonicalPath;
    this.rootId = dependencies.mounted.rootId;
    this.signal = this.stopping.signal;
  }

  listDir(
    relativePath: string,
    maxEntries: number,
    context: CanonicalOperationContext
  ): ReturnType<CanonicalWorkspaceLease['listDir']> {
    return this.own(context, async (signal) => {
      assertRelativeSourcePath(relativePath, true);
      if (
        !(Number.isSafeInteger(maxEntries) && maxEntries > 0 && maxEntries <= MAX_DIRECTORY_ENTRIES)
      ) {
        throw new Error('Source directory limit must be within the mounted directory-entry bound.');
      }
      const resolved = await this.resolveRead(relativePath, signal);
      return this.dependencies.mounted.root.listDir(resolved.relativePath, maxEntries);
    });
  }

  readFile(
    relativePath: string,
    maxBytes: number,
    context: CanonicalOperationContext
  ): ReturnType<CanonicalWorkspaceLease['readFile']> {
    return this.own(context, async (signal) => {
      assertRelativeSourcePath(relativePath, false);
      const { maxFileSize } = getFileSizeConfig();
      if (maxFileSize > NATIVE_MAX_READ_BYTES) {
        throw new Error('Configured maxFileSize exceeds the native secure-read cap.');
      }
      if (!(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= maxFileSize)) {
        throw new Error('Source byte limit must be within configured maxFileSize.');
      }
      const resolved = await this.resolveRead(relativePath, signal);
      return this.dependencies.mounted.root.readFile(resolved.relativePath, maxBytes);
    });
  }

  subscribe(
    onBatch: Parameters<CanonicalWorkspaceLease['subscribe']>[0],
    onSignal: Parameters<CanonicalWorkspaceLease['subscribe']>[1],
    onHealth: Parameters<CanonicalWorkspaceLease['subscribe']>[2],
    context: CanonicalOperationContext
  ): ReturnType<CanonicalWorkspaceLease['subscribe']> {
    return this.own(context, async (signal) => {
      const stopping = new AbortController();
      const subscriptionSignal = AbortSignal.any([signal, stopping.signal]);
      const forward =
        <T extends readonly unknown[]>(callback: (...args: T) => void) =>
        (...args: T): void => {
          if (subscriptionSignal.aborted) {
            return;
          }
          this.dependencies.assertCurrent();
          callback(...args);
        };
      try {
        const subscription = await this.dependencies.subscribe(
          forward(onBatch),
          forward(onSignal),
          forward(onHealth),
          { requestId: context.requestId, signal: subscriptionSignal }
        );
        return this.retainSubscription(subscription, stopping);
      } catch (error) {
        stopping.abort(error);
        if (error instanceof ParcelWatchRetirementError) {
          this.retainSubscription({ close: error.retire }, stopping);
        }
        throw error;
      }
    });
  }

  retire(): Promise<void> {
    if (this.retired) {
      return Promise.resolve();
    }
    this.stopping.abort(new Error('Mounted source lease was retired.'));
    this.retirement ??= this.joinRetirement().finally(() => {
      this.retirement = undefined;
    });
    return this.retirement;
  }

  private retainSubscription(
    subscription: CanonicalSourceSubscription,
    stopping: AbortController
  ): CanonicalSourceSubscription {
    const owned: CanonicalSourceSubscription = {
      close: async (): Promise<void> => {
        stopping.abort(new Error('Mounted source watch subscription was closed.'));
        await subscription.close();
        this.subscriptions.delete(owned);
      },
    };
    this.subscriptions.add(owned);
    return owned;
  }

  private async resolveRead(
    relativePath: string,
    signal: AbortSignal
  ): ReturnType<typeof resolveReadAgainstMountedRoot> {
    const resolved = await resolveReadAgainstMountedRoot(
      path.join(this.canonicalPath, relativePath),
      this.dependencies.mounted,
      this.dependencies.resolveReadPath
    );
    signal.throwIfAborted();
    this.dependencies.assertCurrent();
    return resolved;
  }

  private async own<T>(
    context: CanonicalOperationContext,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (!(context.requestId.trim() && context.requestId.length <= 128)) {
      throw new Error('Mounted source operation requires a bounded request identity.');
    }
    const signal = AbortSignal.any([context.signal, this.signal]);
    signal.throwIfAborted();
    this.dependencies.assertCurrent();
    const promise = operation(signal).then((value) => {
      signal.throwIfAborted();
      this.dependencies.assertCurrent();
      return value;
    });
    const pending = { promise, signal };
    this.pending.add(pending);
    try {
      return await promise;
    } finally {
      this.pending.delete(pending);
    }
  }

  private async joinRetirement(): Promise<void> {
    const pending = [...this.pending];
    const results = await Promise.allSettled(pending.map((operation) => operation.promise));
    const errors: unknown[] = [];
    results.forEach((result, index) => {
      const signal = pending[index]?.signal;
      if (result.status === 'rejected' && !(signal?.aborted && result.reason === signal.reason)) {
        errors.push(result.reason);
      }
    });
    for (const subscription of this.subscriptions) {
      try {
        await subscription.close();
        this.subscriptions.delete(subscription);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Mounted source lease retirement failed.');
    }
    this.retired = true;
  }
}

function assertRelativeSourcePath(relativePath: string, allowRoot: boolean): void {
  if (allowRoot && relativePath === '.') {
    return;
  }
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    [...relativePath].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath) ||
    relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw refusalError(
      'input',
      'workspace.path-invalid',
      'Source path must be normalized and root-relative.',
      'Choose a file inside a connected folder.'
    );
  }
}
