import path from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import type { SecureWorkspaceDirEntry } from '@brainstrike/file-system/workspace-root-nodes';
import { MAX_DIRECTORY_ENTRIES } from '@brainstrike/file-system/workspace-root-nodes';
import { resolveReadAgainstMountedRoot } from './workspace-root-read.ts';
import type { MountedWorkspaceRoot } from './workspace-root-types.ts';

/** One operation on a borrowed root: a bounded request identity and its cancellation. */
export interface WorkspaceRootOperationContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

/** A borrow of the registry's SAME pinned mount. Paths/IDs alone cannot construct it. */
export interface WorkspaceRootLease {
  readonly canonicalPath: string;
  listDir(
    relativePath: string,
    maxEntries: number,
    context: WorkspaceRootOperationContext
  ): Promise<{
    readonly entries: readonly SecureWorkspaceDirEntry[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null>;
  /** Join/release this borrow's operations only; never close a shared mounted root. */
  retire(): Promise<void>;
  readonly rootId: string;
  readonly signal: AbortSignal;
}

/** The owner took the mount back (removal, replacement, root data deletion, retirement). */
export function mountedRootRevoked(message: string): Error {
  return refusalError(
    'availability',
    'workspace.root-unmounted',
    message,
    'Open the folder in the workspace again.'
  );
}

interface SourceLeaseDependencies {
  readonly assertCurrent: () => void;
  readonly mounted: MountedWorkspaceRoot;
  readonly resolveReadPath: (requestedPath: string, canonicalRoot: string) => Promise<string>;
}

/** Borrowed operations never close or reopen the registry's mounted native handle. */
export function createWorkspaceRootSourceLease(
  dependencies: SourceLeaseDependencies
): WorkspaceRootLease {
  return new WorkspaceRootSourceLease(dependencies);
}

class WorkspaceRootSourceLease implements WorkspaceRootLease {
  readonly canonicalPath: string;
  readonly rootId: string;
  readonly signal: AbortSignal;
  private readonly stopping = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private retirement: Promise<void> | undefined;

  private readonly dependencies: SourceLeaseDependencies;

  constructor(dependencies: SourceLeaseDependencies) {
    this.dependencies = dependencies;
    this.canonicalPath = dependencies.mounted.canonicalPath;
    this.rootId = dependencies.mounted.rootId;
    this.signal = this.stopping.signal;
  }

  listDir(
    relativePath: string,
    maxEntries: number,
    context: WorkspaceRootOperationContext
  ): ReturnType<WorkspaceRootLease['listDir']> {
    return this.own(context, async (signal) => {
      assertRelativeSourcePath(relativePath);
      if (
        !(Number.isSafeInteger(maxEntries) && maxEntries > 0 && maxEntries <= MAX_DIRECTORY_ENTRIES)
      ) {
        throw new Error('Source directory limit must be within the mounted directory-entry bound.');
      }
      const resolved = await this.resolveRead(relativePath, signal);
      return this.dependencies.mounted.root.listDir(resolved.relativePath, maxEntries);
    });
  }

  retire(): Promise<void> {
    // The owner retired this mount (removal, replacement, reset) or the borrower ended its own
    // lease: work still in flight is superseded, typed so, and settles before retirement ends.
    this.stopping.abort(mountedRootRevoked('Mounted source lease was retired.'));
    this.retirement ??= Promise.allSettled(this.pending).then(() => undefined);
    return this.retirement;
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
    context: WorkspaceRootOperationContext,
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
    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }
}

function assertRelativeSourcePath(relativePath: string): void {
  if (relativePath === '.') {
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
