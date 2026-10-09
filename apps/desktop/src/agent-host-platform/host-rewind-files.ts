import { randomUUID } from 'node:crypto';
import type {
  HostRewindConflict,
  HostRewindFileOutcome,
  HostTurnSnapshot,
} from '@brainstrike/agent-host';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { listThreadSnapshotChain } from '../assistant-server/snapshot-chains';
import { execFileSnapshotGitRunner } from '../assistant-server/snapshot-git';
import type {
  PerFileOutcome,
  ShadowRepoHandle,
  SnapshotService,
} from '../assistant-server/snapshot-service';
import {
  PlatformRewindApplySchema,
  PlatformRewindConflictsSchema,
  PlatformRewindDriftSchema,
  PlatformRewindOutcomesSchema,
  PlatformRewindPreviewResultSchema,
  PlatformRewindPreviewSchema,
  PlatformRewindRedoConflictsSchema,
  PlatformRewindRedoSchema,
} from './platform-wire';

/** Previews kept for their rewind; an evicted one refuses as `preview-required`. */
const MAX_STORED_PREVIEWS = 32;

interface StoredPreview {
  /** rootId → path → blob oid of the live work-tree when the preview was shown. */
  readonly fingerprint: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly threadId: string;
}

/** Main's owners a host rewind borrows: the one shadow-git service and the live root owner. */
export interface HostRewindFilesOwners {
  /** The live path of a mounted root; rejects an unmounted one. */
  readonly resolveWorkspaceRoot: (rootId: string) => Promise<string>;
  readonly snapshots: () => SnapshotService | null;
}

function outcomeOf(rootId: string, outcome: PerFileOutcome): HostRewindFileOutcome {
  switch (outcome.outcome) {
    case 'conflict':
    case 'failed':
      return { detail: outcome.message, path: outcome.path, rootId, status: outcome.outcome };
    default:
      return { path: outcome.path, rootId, status: outcome.outcome };
  }
}

function sortedDrift(
  rootId: string,
  recorded: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>
): HostRewindConflict[] {
  return [...new Set([...recorded.keys(), ...current.keys()])]
    .sort()
    .filter((path) => recorded.get(path) !== current.get(path))
    .map((path) => ({ path, rootId }));
}

/**
 * A host thread's rewind restores over Main's one shadow-git owner, with the
 * legacy rewind engine's rules (`rewind-snapshot-engine.ts`):
 * - a preview fingerprints each root's live work-tree, and an apply refuses
 *   as drift every path that changed since;
 * - an apply snapshots each root `pre-revert` first, under the rewind's ID
 *   on the thread's own ref, then restores the target turn's tree, so a write
 *   racing the restore is still in the pre-revert snapshot;
 * - a redo restores that pre-revert snapshot, found by the rewind's ID even
 *   when the rewind's outcome was never committed, and names as conflicts the
 *   paths that changed after the rewind (checked against the target turn).
 *
 * Each root is revalidated against its live owner, so an unmounted root
 * refuses rather than restoring into a stale path. Roots go one at a time.
 * The host log is the record: no ledger row is written.
 */
export function createHostRewindFiles(owners: HostRewindFilesOwners) {
  const previews = new Map<string, StoredPreview>();

  async function rootHandle(
    service: SnapshotService,
    target: HostTurnSnapshot
  ): Promise<ShadowRepoHandle> {
    const path = await owners.resolveWorkspaceRoot(target.rootId);
    return await service.ensureShadowRepo({ path, rootId: target.rootId });
  }

  function service(): SnapshotService {
    const owner = owners.snapshots();
    if (!owner) {
      throw new Error('This desktop has no workspace snapshot owner');
    }
    return owner;
  }

  function storedPreview(threadId: string, previewId: string): StoredPreview {
    const stored = previews.get(previewId);
    if (!stored || stored.threadId !== threadId) {
      throw new Error('preview-required: open the restore preview again before restoring files');
    }
    return stored;
  }

  /** Each root's pre-revert snapshot for `rewindId`, with its handle. */
  async function preRevertOf(
    owner: SnapshotService,
    threadId: string,
    rewindId: string,
    target: HostTurnSnapshot
  ): Promise<{ readonly handle: ShadowRepoHandle; readonly preRevertOid: string }> {
    const handle = await rootHandle(owner, target);
    const chain = await listThreadSnapshotChain(execFileSnapshotGitRunner, handle, threadId);
    const preRevert = chain.find(
      (entry) => entry.kind === 'pre-revert' && entry.runId === rewindId
    );
    if (!preRevert) {
      throw new Error(
        `snapshot-missing: root "${target.rootId}" has no pre-revert snapshot for this rewind`
      );
    }
    return { handle, preRevertOid: preRevert.commitOid };
  }

  /** A root's redo plan: a fresh diff anchor, and conflicts against the target turn. */
  async function redoPlan(
    owner: SnapshotService,
    threadId: string,
    rewindId: string,
    target: HostTurnSnapshot
  ) {
    const { handle, preRevertOid } = await preRevertOf(owner, threadId, rewindId, target);
    const { commitOid: freshOid } = await owner.snapshot(handle, { kind: 'pre-revert', threadId });
    const currentHashes = await owner.snapshotFileHashes(handle, freshOid);
    const plan = await owner.computeRestorePlan(handle, preRevertOid, freshOid);
    const turnStartHashes = await owner.snapshotFileHashes(handle, target.commitOid);
    const conflicts = plan.actions
      .filter((action) => action.kind !== 'nested-repo')
      .filter((action) => currentHashes.get(action.path) !== turnStartHashes.get(action.path))
      .map((action) => ({ path: action.path, rootId: target.rootId }));
    return { conflicts, currentHashes, handle, plan, turnStartHashes };
  }

  return {
    apply: async (request: {
      readonly previewId: string;
      readonly rewindId: string;
      readonly targets: readonly HostTurnSnapshot[];
      readonly threadId: string;
    }): Promise<HostRewindFileOutcome[]> => {
      storedPreview(request.threadId, request.previewId);
      previews.delete(request.previewId);
      const owner = service();
      const outcomes: HostRewindFileOutcome[] = [];
      for (const target of request.targets) {
        const handle = await rootHandle(owner, target);
        const { commitOid: preRevertOid } = await owner.snapshot(handle, {
          kind: 'pre-revert',
          runId: request.rewindId,
          threadId: request.threadId,
        });
        const plan = await owner.computeRestorePlan(handle, target.commitOid, preRevertOid);
        const expected = await owner.snapshotFileHashes(handle, preRevertOid);
        const applied = await owner.applyRestorePlan(handle, plan, {
          expectedPreRevertHashes: expected,
        });
        outcomes.push(...applied.map((outcome) => outcomeOf(target.rootId, outcome)));
      }
      return outcomes;
    },
    drift: async (request: {
      readonly previewId: string;
      readonly threadId: string;
    }): Promise<HostRewindConflict[]> => {
      const stored = storedPreview(request.threadId, request.previewId);
      const owner = service();
      const conflicts: HostRewindConflict[] = [];
      for (const [rootId, recorded] of stored.fingerprint) {
        const path = await owners.resolveWorkspaceRoot(rootId);
        const handle = await owner.ensureShadowRepo({ path, rootId });
        conflicts.push(...sortedDrift(rootId, recorded, await owner.worktreeFileHashes(handle)));
      }
      return conflicts;
    },
    preview: async (request: {
      readonly targets: readonly HostTurnSnapshot[];
      readonly threadId: string;
    }): Promise<{ previewId: string }> => {
      const owner = service();
      const fingerprint = new Map<string, ReadonlyMap<string, string>>();
      for (const target of request.targets) {
        fingerprint.set(
          target.rootId,
          await owner.worktreeFileHashes(await rootHandle(owner, target))
        );
      }
      const previewId = randomUUID();
      previews.set(previewId, { fingerprint, threadId: request.threadId });
      for (const oldest of previews.keys()) {
        if (previews.size <= MAX_STORED_PREVIEWS) {
          break;
        }
        previews.delete(oldest);
      }
      return { previewId };
    },
    redo: async (request: {
      readonly acknowledged: readonly HostRewindConflict[];
      readonly rewindId: string;
      readonly targets: readonly HostTurnSnapshot[];
      readonly threadId: string;
    }): Promise<HostRewindFileOutcome[]> => {
      const owner = service();
      const outcomes: HostRewindFileOutcome[] = [];
      for (const target of request.targets) {
        const planned = await redoPlan(owner, request.threadId, request.rewindId, target);
        // Force is per path, and only for what the user acknowledged.
        const expected = new Map(planned.turnStartHashes);
        for (const { path, rootId } of request.acknowledged) {
          const current = planned.currentHashes.get(path);
          if (rootId !== target.rootId) {
            continue;
          }
          if (current === undefined) {
            expected.delete(path);
          } else {
            expected.set(path, current);
          }
        }
        const applied = await owner.applyRestorePlan(planned.handle, planned.plan, {
          expectedPreRevertHashes: expected,
        });
        outcomes.push(...applied.map((outcome) => outcomeOf(target.rootId, outcome)));
      }
      return outcomes;
    },
    redoConflicts: async (request: {
      readonly rewindId: string;
      readonly targets: readonly HostTurnSnapshot[];
      readonly threadId: string;
    }): Promise<HostRewindConflict[]> => {
      const owner = service();
      const conflicts: HostRewindConflict[] = [];
      for (const target of request.targets) {
        conflicts.push(
          ...(await redoPlan(owner, request.threadId, request.rewindId, target)).conflicts
        );
      }
      return conflicts;
    },
  };
}

export type HostRewindFilesOwner = ReturnType<typeof createHostRewindFiles>;

type Execute = <T>(
  token: CancellationToken,
  work: (signal: AbortSignal) => Promise<T>
) => Promise<T>;

/**
 * Serve a host thread's rewind restores (`platform/rewind/*`) over Main's
 * snapshot owner. Rewinds run with no admitted selection; each root is
 * revalidated against the live root owner instead.
 */
export function serveHostRewindFiles(
  connection: MessageConnection,
  execute: Execute,
  owners: {
    readonly resolveWorkspaceRoot?: (rootId: string) => Promise<string>;
    readonly workspaceSnapshots?: () => SnapshotService | null;
  }
): void {
  const files = createHostRewindFiles({
    resolveWorkspaceRoot: (rootId) => {
      if (!owners.resolveWorkspaceRoot) {
        throw new Error('Desktop has no live workspace root owner');
      }
      return owners.resolveWorkspaceRoot(rootId);
    },
    snapshots: () => owners.workspaceSnapshots?.() ?? null,
  });
  const serve = (method: string, run: (input: unknown) => Promise<unknown>): void => {
    connection.onRequest(method, (input: unknown, token: CancellationToken) =>
      execute(token, () => run(input))
    );
  };
  serve('platform/rewind/preview', async (input) =>
    PlatformRewindPreviewResultSchema.parse(
      await files.preview(PlatformRewindPreviewSchema.parse(input))
    )
  );
  serve('platform/rewind/drift', async (input) =>
    PlatformRewindConflictsSchema.parse(await files.drift(PlatformRewindDriftSchema.parse(input)))
  );
  serve('platform/rewind/apply', async (input) =>
    PlatformRewindOutcomesSchema.parse(await files.apply(PlatformRewindApplySchema.parse(input)))
  );
  serve('platform/rewind/redo-conflicts', async (input) =>
    PlatformRewindConflictsSchema.parse(
      await files.redoConflicts(PlatformRewindRedoConflictsSchema.parse(input))
    )
  );
  serve('platform/rewind/redo', async (input) =>
    PlatformRewindOutcomesSchema.parse(await files.redo(PlatformRewindRedoSchema.parse(input)))
  );
}
