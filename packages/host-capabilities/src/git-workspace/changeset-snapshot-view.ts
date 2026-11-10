/**
 * Snapshot diff endpoints come exclusively from the current host log.
 *
 * A settled turn's view offers to revert each file the live work-tree still
 * holds exactly as the turn left it, and only the whole file (Sean's call,
 * 2026-11-05): a revert puts it back as it was at the turn's start. A live
 * turn, a range, a thread with a run in progress and a folder that moved
 * since the turn offer nothing.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
  ChangedFileEntry,
  ChangesApplyParams,
  ChangesApplyResult,
  Changeset,
  ChangesetView,
  ChangesFileRevision,
  StructuredFileDiff,
} from '@brainstrike/types';
import type { HostThreadTurns } from './changeset-host-turns.ts';
import {
  type ResolvedTurnTargets,
  type RootDiffTarget,
  snapshotMissingError,
} from './changeset-snapshot-targets.ts';
import { gitFault, gitInvalid, gitRefused, refuseStale, refuseUnoffered } from './git-failure.ts';
import type { SnapshotService, TurnEndpoints, TurnRevertResult } from './snapshot-service.ts';
import { boundViewPatches, completePatch, fileRevision } from './structured-diff-content.ts';

type SnapshotChangeset = Extract<Changeset, { kind: 'agent-run' | 'run-range' }>;
export interface SnapshotChangesetResolverDeps {
  readonly hostThreads: HostThreadTurns;
  /** A mounted root's canonical path, or why there is none. */
  readonly resolveRootPath: (rootId: string) => Promise<BoundaryResult<string>>;
  readonly resolveService: () => SnapshotService | null;
}

export interface SnapshotChangesetResolver {
  readonly apply: (
    params: ChangesApplyParams & { readonly changeset: SnapshotChangeset }
  ) => Promise<BoundaryResult<ChangesApplyResult>>;
  readonly fileDiff: (
    rootId: unknown,
    changeset: SnapshotChangeset,
    path: string
  ) => Promise<BoundaryResult<StructuredFileDiff>>;
  readonly resolveView: (changeset: SnapshotChangeset) => Promise<BoundaryResult<ChangesetView>>;
}

/** Bounded memo for IMMUTABLE oid↔oid per-root diffs (never worktree diffs). */
const DIFF_MEMO_MAX_ENTRIES = 16;
const MEMO_KEY_SEPARATOR = String.fromCharCode(0);

const NO_PATHS: ReadonlySet<string> = new Set();

/** The paths a file's revert writes: where it is, and where it moved from. */
function pathsOf(file: Pick<StructuredFileDiff, 'oldPath' | 'path'>): readonly string[] {
  return file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
}

/** Map one root's structured diffs to `ChangedFileEntry` rows; `revertible` paths offer a revert. */
function entriesOfDiffs(
  rootId: string,
  diffs: readonly StructuredFileDiff[],
  toolAttributedFor: ((path: string) => boolean) | null,
  revertible: ReadonlySet<string>
): ChangedFileEntry[] {
  return diffs.map((diff) => {
    const patch = completePatch(diff.content);
    return {
      actions: pathsOf(diff).every((path) => revertible.has(path)) ? ['revert'] : [],
      additions: diff.additions,
      deletions: diff.deletions,
      ...(diff.oldPath === undefined ? {} : { oldPath: diff.oldPath }),
      patch,
      path: diff.path,
      // A turn's files are listed from the root itself.
      pathInRoot: diff.path,
      repositoryRoot: null,
      revision: fileRevision({ ...diff, patch }),
      rootId,
      status: diff.status,
      ...(toolAttributedFor === null ? {} : { toolAttributed: toolAttributedFor(diff.path) }),
      wholeFile: true,
      worktreePath: null,
    };
  });
}

/** The paths of the targeted files, each in the view at the revision the target names. */
function drawnAsTargeted(
  drawn: readonly ChangedFileEntry[],
  files: readonly ChangesFileRevision[]
): BoundaryResult<readonly string[]> {
  const byPath = new Map(drawn.map((entry) => [entry.path, entry]));
  const paths: string[] = [];
  for (const file of files) {
    const entry = byPath.get(file.path);
    if (!entry) {
      return refuseStale(`"${file.path}" is no longer in this view.`);
    }
    if (entry.revision !== file.revision) {
      return refuseStale(`"${file.path}" changed since this view was drawn.`);
    }
    paths.push(...pathsOf(entry));
  }
  return { ok: true, value: paths };
}

/** The paths a turn revert wrote, or why it wrote none or only some. */
function revertedPaths(result: TurnRevertResult): BoundaryResult<ChangesApplyResult> {
  if (result.kind === 'busy') {
    return gitRefused('conflict', 'changeset.run-active', 'The thread has a run in progress.');
  }
  if (result.kind === 'changed') {
    const [first, ...others] = result.paths;
    return refuseStale(
      others.length === 0
        ? `"${first}" changed since this turn.`
        : `${result.paths.length} files changed since this turn.`
    );
  }
  const { outcomes } = result;
  const unwritten = outcomes.find(
    (outcome) => outcome.outcome !== 'restored' && outcome.outcome !== 'deleted'
  );
  if (unwritten) {
    return gitFault(
      'changeset.apply-partial',
      `Only part of the revert applied: "${unwritten.path}" was not reverted.`
    );
  }
  return { ok: true, value: { paths: outcomes.map((outcome) => outcome.path) } };
}

/** A settled turn's endpoints, or null for a view against the live work-tree. */
function settledTurn(target: RootDiffTarget): TurnEndpoints | null {
  return typeof target.to === 'string' ? { fromOid: target.fromOid, toOid: target.to } : null;
}

export function createSnapshotChangesetResolver(
  deps: SnapshotChangesetResolverDeps
): SnapshotChangesetResolver {
  const diffMemo = new Map<string, readonly StructuredFileDiff[]>();

  function requireService(): BoundaryResult<SnapshotService> {
    const service = deps.resolveService();
    if (!service) {
      return gitRefused(
        'availability',
        'changeset.snapshot-engine-unavailable',
        'The workspace snapshot service is not running. ' +
          'Restart the app; if this persists it is a wiring bug.'
      );
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

  /** Whether the root is mounted where the turn found it: a write goes nowhere else. */
  async function mountedAsRecorded(target: RootDiffTarget): Promise<boolean> {
    const live = await deps.resolveRootPath(target.rootId);
    return live.ok && live.value === target.rootPath;
  }

  /** The files of one root a settled turn's view offers to revert. */
  async function revertibleIn(
    service: SnapshotService,
    changeset: SnapshotChangeset,
    target: RootDiffTarget
  ): Promise<ReadonlySet<string>> {
    const turn = settledTurn(target);
    if (
      changeset.kind !== 'agent-run' ||
      turn === null ||
      (await deps.hostThreads.running(changeset.threadId)) ||
      !(await mountedAsRecorded(target))
    ) {
      return NO_PATHS;
    }
    const handle = await service.ensureShadowRepo({ path: target.rootPath, rootId: target.rootId });
    return await service.unchangedSinceTurn(handle, turn);
  }

  async function resolveTargets(
    changeset: SnapshotChangeset
  ): Promise<BoundaryResult<ResolvedTurnTargets>> {
    const host = deps.hostThreads;
    if (!(host.knows(changeset.threadId) || (await host.owns(changeset.threadId)))) {
      return snapshotMissingError(`thread "${changeset.threadId}" is not owned by the agent host`);
    }
    if (changeset.kind === 'agent-run') {
      return await host.targetsOf(changeset.threadId, changeset.runId);
    }
    if (changeset.toRunId !== undefined) {
      return gitRefused(
        'input',
        'changeset.run-range-unsupported',
        'Host ranges resolve to the live work-tree, not a terminal run.'
      );
    }
    return await host.rangeTargetsOf(changeset.threadId, changeset.fromRunId);
  }

  async function resolveView(changeset: SnapshotChangeset): Promise<BoundaryResult<ChangesetView>> {
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
      const revertible = await revertibleIn(serviceResult.value, changeset, target);
      files.push(...entriesOfDiffs(target.rootId, diffs, scopedAttribution, revertible));
    }
    return {
      ok: true,
      value: { changeset, files: boundViewPatches(files), totalAdditions, totalDeletions },
    };
  }

  async function fileDiff(
    rootId: unknown,
    changeset: SnapshotChangeset,
    path: string
  ): Promise<BoundaryResult<StructuredFileDiff>> {
    if (typeof rootId !== 'string' || rootId.trim().length === 0) {
      return gitInvalid('snapshot fileDiff requires a non-empty rootId string.');
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
      return gitRefused(
        'input',
        'changeset.not-in-snapshot',
        `no snapshot-captured root "${rootId.trim()}" in this changeset`
      );
    }
    const diffs = await diffTarget(serviceResult.value, target);
    const diff = diffs.find((candidate) => candidate.path === path);
    if (!diff) {
      return gitRefused(
        'input',
        'changeset.not-in-snapshot',
        `no snapshot-captured change for path "${path}" in root "${rootId.trim()}" for this changeset`
      );
    }
    return { ok: true, value: diff };
  }

  /** A settled turn's root that can take a revert now: mounted where the turn found it. */
  async function revertibleRoot(
    changeset: Extract<SnapshotChangeset, { kind: 'agent-run' }>,
    rootId: string
  ): Promise<BoundaryResult<{ readonly root: RootDiffTarget; readonly turn: TurnEndpoints }>> {
    const targetsResult = await resolveTargets(changeset);
    if (!targetsResult.ok) {
      return targetsResult;
    }
    const root = targetsResult.value.targets.find((candidate) => candidate.rootId === rootId);
    const turn = root ? settledTurn(root) : null;
    if (!(root && turn)) {
      return refuseUnoffered('This turn offers no revert until it ends.');
    }
    if (!(await mountedAsRecorded(root))) {
      return refuseStale('The folder is no longer where this turn found it.');
    }
    return { ok: true, value: { root, turn } };
  }

  /**
   * Revert whole files of a settled turn in one root: refused once the
   * folder moved and for a file the view no longer draws as it was, and,
   * writing nothing, while the thread runs or any file is no longer as the
   * turn left it. Both of those are checked under the root's snapshot lock.
   */
  async function apply(
    params: ChangesApplyParams & { readonly changeset: SnapshotChangeset }
  ): Promise<BoundaryResult<ChangesApplyResult>> {
    const { action, changeset, rootId, target } = params;
    if (changeset.kind !== 'agent-run' || action !== 'revert') {
      return refuseUnoffered(`This view does not offer ${action}.`);
    }
    if (target.kind !== 'files') {
      return refuseUnoffered(`"${target.path}" reverts as a whole file in a turn.`);
    }
    const serviceResult = requireService();
    if (!serviceResult.ok) {
      return serviceResult;
    }
    const service = serviceResult.value;
    const revertible = await revertibleRoot(changeset, rootId);
    if (!revertible.ok) {
      return revertible;
    }
    const { root, turn } = revertible.value;
    const drawn = entriesOfDiffs(rootId, await diffTarget(service, root), null, NO_PATHS);
    const targeted = drawnAsTargeted(drawn, target.files);
    if (!targeted.ok) {
      return targeted;
    }
    const handle = await service.ensureShadowRepo({ path: root.rootPath, rootId });
    const idle = async () => !(await deps.hostThreads.running(changeset.threadId));
    return revertedPaths(await service.revertTurnPaths(handle, turn, targeted.value, idle));
  }

  return { apply, fileDiff, resolveView };
}
