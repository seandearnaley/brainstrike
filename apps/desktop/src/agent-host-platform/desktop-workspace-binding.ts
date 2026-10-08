import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import type { HostPlatform } from '@brainstrike/agent-host';
import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import type { ManagedWorktreeRow } from '@brainstrike/types';

type BindingRequest = Parameters<NonNullable<HostPlatform['validateWorkspaceBinding']>>[0];
type RuntimeWorkspaceRoot = NonNullable<RuntimeData['workspaceRoots']>[number];

export interface DesktopWorkspaceBindingDependencies {
  borrowRoot(root: RuntimeWorkspaceRoot): Promise<CanonicalWorkspaceLease>;
  readRoots(): Promise<readonly RuntimeWorkspaceRoot[]>;
  readWorktree(id: string): Promise<ManagedWorktreeRow | null>;
}

export interface DesktopWorkspaceBindingBorrow {
  close(): Promise<void>;
  revalidate(signal: AbortSignal): Promise<void>;
  readonly roots: readonly RuntimeWorkspaceRoot[];
}

/** Borrows the existing catalog and pinned mount; owns no root, grant or writer. */
export class DesktopWorkspaceBindingAuthority {
  private readonly stopping = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly borrows = new Set<() => Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(private readonly dependencies: DesktopWorkspaceBindingDependencies) {}

  readonly validateWorkspaceBinding: NonNullable<HostPlatform['validateWorkspaceBinding']> = async (
    request
  ) => {
    const borrowed = await this.acquire(request);
    await borrowed.close();
  };

  acquire(request: BindingRequest): Promise<DesktopWorkspaceBindingBorrow> {
    const signal = AbortSignal.any([request.signal, this.stopping.signal]);
    signal.throwIfAborted();
    const work = this.acquireOwned({ ...request, signal });
    this.pending.add(work);
    const settled = (): void => {
      this.pending.delete(work);
    };
    work.then(settled, settled);
    return work;
  }

  close(): Promise<void> {
    this.stopping.abort(new Error('Desktop workspace binding owner is closing'));
    this.closing ??= (async () => {
      // Acquisition owns and retires partial borrows before it rejects.
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.borrows].map((close) => close()));
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Desktop workspace binding retirement failed');
      }
    })();
    return this.closing;
  }

  private async acquireOwned(request: BindingRequest): Promise<DesktopWorkspaceBindingBorrow> {
    const binding = ThreadWorkspaceBindingSchema.parse(request.binding);
    if (binding.checkoutMode && !binding.operatingRootId) {
      throw new Error('Checkout requires a committed operating root');
    }
    const ids = [
      ...new Set([
        ...(binding.operatingRootId ? [binding.operatingRootId] : []),
        ...(binding.secondaryRootIds ?? []),
        ...(binding.checkoutLocalRootId ? [binding.checkoutLocalRootId] : []),
      ]),
    ];
    const roots = await this.dependencies.readRoots();
    request.signal.throwIfAborted();
    const selected = ids.map((id) => {
      const matches = roots.filter((root) => root.rootId === id);
      if (matches.length !== 1) {
        throw new Error('Thread binding requires one live catalog record for every root');
      }
      return matches[0] as RuntimeWorkspaceRoot;
    });
    const assertCatalog = async (signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const current = await this.dependencies.readRoots();
      signal.throwIfAborted();
      for (const captured of selected) {
        const matches = current.filter((root) => root.rootId === captured.rootId);
        if (matches.length !== 1 || matches[0]?.path !== captured.path) {
          throw new Error('Thread workspace catalog grant was revoked or replaced');
        }
      }
    };
    const leases: CanonicalWorkspaceLease[] = [];
    let retirement: Promise<void> | undefined;
    const close = (): Promise<void> => {
      retirement ??= (async () => {
        const results = await Promise.allSettled(leases.map((lease) => lease.retire()));
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Thread workspace borrows failed to retire');
        }
        this.borrows.delete(close);
      })();
      return retirement;
    };
    this.borrows.add(close);
    const revalidate = async (signal: AbortSignal): Promise<void> => {
      const currentSignal = AbortSignal.any([signal, request.signal, this.stopping.signal]);
      currentSignal.throwIfAborted();
      await assertCatalog(currentSignal);
      for (const lease of leases) {
        await assertCatalog(currentSignal);
        lease.signal.throwIfAborted();
        // The existing asynchronous native operation checks this exact mount
        // both before and after access, including registry revocation.
        const result = await lease.listDir('.', 1, {
          requestId: request.threadId,
          signal: currentSignal,
        });
        if (!result) {
          throw new Error('Thread workspace pinned mount is unavailable');
        }
        await assertCatalog(currentSignal);
      }
      const primary = selected.find((root) => root.rootId === binding.operatingRootId);
      const primaryLease = primary ? leases[selected.indexOf(primary)] : undefined;
      if (
        binding.operatingRootPath &&
        primaryLease &&
        ![primary?.path, primaryLease.canonicalPath].includes(
          path.normalize(binding.operatingRootPath)
        )
      ) {
        throw new Error('Thread operating-root hint conflicts with its catalog mount');
      }
      if (binding.checkoutMode === 'worktree') {
        const worktree = await this.dependencies.readWorktree(binding.checkoutWorktreeId ?? '');
        currentSignal.throwIfAborted();
        if (
          !worktree ||
          worktree.archivedAt !== null ||
          !primaryLease ||
          path.normalize(worktree.path) !== primaryLease.canonicalPath ||
          path.normalize(binding.checkoutWorktreePath ?? '') !== primaryLease.canonicalPath
        ) {
          throw new Error(
            'Thread checkout requires the live worktree ledger and its exact mounted root'
          );
        }
      }
      await assertCatalog(currentSignal);
      currentSignal.throwIfAborted();
    };
    try {
      for (const root of selected) {
        await assertCatalog(request.signal);
        const lease = await this.dependencies.borrowRoot(root);
        leases.push(lease);
        request.signal.throwIfAborted();
      }
      await revalidate(request.signal);
      const admittedIds = [binding.operatingRootId, ...(binding.secondaryRootIds ?? [])];
      return {
        close,
        revalidate,
        roots: selected.filter((root) => admittedIds.includes(root.rootId)),
      };
    } catch (cause) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          'Thread workspace acquisition and retirement failed'
        );
      }
      throw cause;
    }
  }
}
