/** Snapshot diff endpoints come exclusively from the current host log. */
import type {
  ChangedFileEntry,
  Changeset,
  ChangesetView,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import type { HostThreadTurns } from './changeset-host-turns';
import {
  type ResolvedTurnTargets,
  type RootDiffTarget,
  snapshotMissingError,
} from './changeset-snapshot-targets';
import type { SnapshotService } from './snapshot-service';

type SnapshotChangeset = Extract<Changeset, { kind: 'agent-run' | 'run-range' }>;
export interface SnapshotChangesetResolverDeps {
  readonly hostThreads: HostThreadTurns;
  readonly resolveService: () => SnapshotService | null;
}

export interface SnapshotChangesetResolver {
  readonly fileDiff: (
    rootId: unknown,
    changeset: SnapshotChangeset,
    path: string
  ) => Promise<GitResult<StructuredFileDiff>>;
  readonly resolveView: (changeset: SnapshotChangeset) => Promise<GitResult<ChangesetView>>;
}

/** Bounded memo for IMMUTABLE oid↔oid per-root diffs (never worktree diffs). */
const DIFF_MEMO_MAX_ENTRIES = 16;
const MEMO_KEY_SEPARATOR = String.fromCharCode(0);

/** Map one root's structured diffs to `ChangedFileEntry` rows. */
function entriesOfDiffs(
  rootId: string,
  diffs: readonly StructuredFileDiff[],
  toolAttributedFor: ((path: string) => boolean) | null
): ChangedFileEntry[] {
  return diffs.map((diff) => ({
    additions: diff.additions,
    deletions: diff.deletions,
    ...(diff.oldPath === undefined ? {} : { oldPath: diff.oldPath }),
    path: diff.path,
    repositoryRoot: null,
    // The snapshot engine can restore every captured file (T3's rewind);
    // per-entry chain bookkeeping died with the journal fold.
    revertible: true,
    rootId,
    status: diff.status,
    ...(toolAttributedFor === null ? {} : { toolAttributed: toolAttributedFor(diff.path) }),
    worktreePath: null,
  }));
}

export function createSnapshotChangesetResolver(
  deps: SnapshotChangesetResolverDeps
): SnapshotChangesetResolver {
  const diffMemo = new Map<string, readonly StructuredFileDiff[]>();

  function requireService(): GitResult<SnapshotService> {
    const service = deps.resolveService();
    if (!service) {
      return {
        error:
          'snapshot-engine-unavailable: the workspace snapshot service is not running. ' +
          'Restart the app; if this persists it is a wiring bug.',
        ok: false,
      };
    }
    return { ok: true, value: service };
  }

  /** diffRefs with a bounded memo for immutable oid↔oid pairs. */
  async function diffTarget(
    service: SnapshotService,
    target: RootDiffTarget
  ): Promise<readonly StructuredFileDiff[]> {
    const isImmutablePair = typeof target.to === 'string';
    const memoKey = isImmutablePair
      ? `${target.rootId}${MEMO_KEY_SEPARATOR}${target.fromOid}${MEMO_KEY_SEPARATOR}${String(target.to)}`
      : null;
    if (memoKey !== null) {
      const cached = diffMemo.get(memoKey);
      if (cached) {
        return cached;
      }
    }
    const handle = await service.ensureShadowRepo({ path: target.rootPath, rootId: target.rootId });
    const diffs = await service.diffRefs(handle, target.fromOid, target.to);
    if (memoKey !== null) {
      diffMemo.set(memoKey, diffs);
      while (diffMemo.size > DIFF_MEMO_MAX_ENTRIES) {
        const oldest = diffMemo.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        diffMemo.delete(oldest);
      }
    }
    return diffs;
  }

  async function resolveTargets(
    changeset: SnapshotChangeset
  ): Promise<GitResult<ResolvedTurnTargets>> {
    const host = deps.hostThreads;
    if (!(host.knows(changeset.threadId) || (await host.owns(changeset.threadId)))) {
      return snapshotMissingError(`thread "${changeset.threadId}" is not owned by the agent host`);
    }
    if (changeset.kind === 'agent-run') {
      return await host.targetsOf(changeset.threadId, changeset.runId);
    }
    if (changeset.toRunId !== undefined) {
      return {
        error:
          'run-range-unsupported: host ranges resolve to the live work-tree, not a terminal run.',
        ok: false,
      };
    }
    return await host.rangeTargetsOf(changeset.threadId, changeset.fromRunId);
  }

  async function resolveView(changeset: SnapshotChangeset): Promise<GitResult<ChangesetView>> {
    const serviceResult = requireService();
    if (!serviceResult.ok) {
      return serviceResult;
    }
    const targetsResult = await resolveTargets(changeset);
    if (!targetsResult.ok) {
      return targetsResult;
    }
    const { attribution: records, targets } = targetsResult.value;

    const files: ChangedFileEntry[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const target of targets) {
      const diffs = await diffTarget(serviceResult.value, target);
      for (const diff of diffs) {
        totalAdditions += diff.additions ?? 0;
        totalDeletions += diff.deletions ?? 0;
      }
      const scopedAttribution =
        records === null
          ? null
          : (path: string) =>
              records.some(
                (record) =>
                  record.rootId === target.rootId &&
                  (record.path === path || record.fromPath === path)
              );
      files.push(...entriesOfDiffs(target.rootId, diffs, scopedAttribution));
    }
    return { ok: true, value: { changeset, files, totalAdditions, totalDeletions } };
  }

  async function fileDiff(
    rootId: unknown,
    changeset: SnapshotChangeset,
    path: string
  ): Promise<GitResult<StructuredFileDiff>> {
    if (typeof rootId !== 'string' || rootId.trim().length === 0) {
      return { error: 'snapshot fileDiff requires a non-empty rootId string.', ok: false };
    }
    const serviceResult = requireService();
    if (!serviceResult.ok) {
      return serviceResult;
    }
    const targetsResult = await resolveTargets(changeset);
    if (!targetsResult.ok) {
      return targetsResult;
    }
    const target = targetsResult.value.targets.find(
      (candidate) => candidate.rootId === rootId.trim()
    );
    if (!target) {
      return {
        error: `no snapshot-captured root "${rootId.trim()}" in this changeset`,
        ok: false,
      };
    }
    const diffs = await diffTarget(serviceResult.value, target);
    const diff = diffs.find((candidate) => candidate.path === path);
    if (!diff) {
      return {
        error: `no snapshot-captured change for path "${path}" in root "${rootId.trim()}" for this changeset`,
        ok: false,
      };
    }
    return { ok: true, value: diff };
  }

  return { fileDiff, resolveView };
}
