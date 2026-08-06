/**
 * SnapshotService — the W7 shadow-git snapshot backbone (BST-1164 T0).
 *
 * One shadow git dir per workspace root under a caller-injected
 * `snapshotsBaseDir` (`<base>/<rootId>/git`; production passes
 * `userData/snapshots` in T1 — this module has NO Electron imports). Snapshot
 * commits are taken at turn boundaries via a private per-operation index
 * (`add -A` → `write-tree` → `commit-tree` → `update-ref
 * refs/snapshots/<threadId>`); diffs resolve to the shared
 * `StructuredFileDiff` shape by reusing the W1 parsers
 * (`structured-diff-parsers.ts`); restores are computed and applied from
 * snapshot ref pairs with per-path conflict gating.
 *
 * Frozen T0 interface (consumed by T1–T3): `ensureShadowRepo`, `snapshot`,
 * `diffRefs`, `computeRestorePlan`, `applyRestorePlan`, `pruneThread`,
 * `sweepOrphans`. `snapshotFileHashes` is a documented ADDITION for T3's
 * conflict scan (the pre-revert hash map `applyRestorePlan` consumes has to
 * come from somewhere) — it changes nothing about the frozen methods.
 *
 * Invariants (plan global constraints):
 * - The user's own `.git` is never read or written (see `snapshot-git.ts`).
 * - One async mutex per root serializes snapshot/restore ops; every op uses
 *   its own private `GIT_INDEX_FILE`.
 * - NO silent fallbacks: every failure is a typed thrown error
 *   (`SnapshotGitError`/`RestorePlanError`) or an explicit per-file failure
 *   outcome; `applyRestorePlan` reports exactly one outcome per plan action
 *   — no path is ever silently skipped, and gitlink (nested repo) entries
 *   surface as `skipped-nested-repo`, never as errors or silence.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { StructuredFileDiff, StructuredFileDiffContent } from '@brainstrike/types';
import { boundOutput } from './git-service';
import {
  assertValidOid,
  assertValidRootId,
  createShadowGitPlumbing,
  type ShadowBlobRead,
  type ShadowGitPlumbing,
  type SnapshotGitCommandRunner,
  SnapshotGitError,
  snapshotRefForThread,
} from './snapshot-git';
import {
  computeRestorePlanActions,
  parseLsTreeZ,
  parseRawDiffZ,
  pruneEmptyAncestorDirectories,
  type RawDiffEntry,
  type RestorePlan,
} from './snapshot-restore-plan';
import { parseHunkHeaders, parseNumstatZ } from './structured-diff-parsers';

/** Opaque per-root handle; obtain via `ensureShadowRepo`, never construct. */
export interface ShadowRepoHandle {
  readonly gitDir: string;
  readonly rootId: string;
  readonly rootPath: string;
}

export type SnapshotKind = 'pre-revert' | 'turn-end' | 'turn-start';

export interface SnapshotMeta {
  readonly kind: SnapshotKind;
  readonly runId?: string | undefined;
  readonly threadId: string;
}

/** `diffRefs` new side: a snapshot commit oid, or the live work-tree. */
export type SnapshotDiffTarget = string | { readonly worktree: true };

/**
 * Exactly one outcome per {@link RestorePlan} action — exhaustive by
 * construction (`applyRestorePlan` asserts the lengths match). `conflict`
 * and `failed` carry the reason; a conflicted or failed path is left
 * UNTOUCHED on disk.
 */
export type PerFileOutcome =
  | { readonly outcome: 'conflict'; readonly message: string; readonly path: string }
  | { readonly outcome: 'deleted'; readonly path: string }
  | { readonly outcome: 'failed'; readonly message: string; readonly path: string }
  | { readonly outcome: 'restored'; readonly path: string }
  | { readonly outcome: 'skipped-nested-repo'; readonly path: string };

export interface ApplyRestorePlanOptions {
  /**
   * Expected on-disk state per plan path, as git blob oids at the PRE-REVERT
   * snapshot (build it from `snapshotFileHashes(handle, preRevertOid)`). A
   * path ABSENT from the map is expected ABSENT on disk (it was deleted in
   * the range being restored). Any mismatch between a path's current on-disk
   * blob hash and its expectation is a `conflict` outcome and the path is
   * left untouched.
   */
  readonly expectedPreRevertHashes: ReadonlyMap<string, string>;
}

export interface SweepOrphansResult {
  readonly kept: readonly string[];
  readonly removed: readonly string[];
}

export interface SnapshotServiceOptions {
  readonly runner: SnapshotGitCommandRunner;
  /** Base dir owning every shadow repo (`<base>/<rootId>/git`). */
  readonly snapshotsBaseDir: string;
}

type MutexRunner = <T>(task: () => Promise<T>) => Promise<T>;

/** FIFO async mutex: tasks run strictly one at a time, failures don't wedge it. */
function createMutex(): MutexRunner {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

interface RootEntry {
  readonly handle: ShadowRepoHandle;
  readonly mutex: MutexRunner;
  readonly plumbing: ShadowGitPlumbing;
}

const GITLINK_MODE = '160000';
const ALL_ZERO_OID_PATTERN = /^0+$/;

const RAW_DIFF_ARGS = ['diff', '--raw', '-z', '--no-abbrev', '--no-renames'] as const;
const NUMSTAT_DIFF_ARGS = ['diff', '--numstat', '-z', '--no-renames'] as const;

function statusForRawEntry(entry: RawDiffEntry): 'added' | 'deleted' | 'modified' {
  if (entry.status === 'A') {
    return 'added';
  }
  if (entry.status === 'D') {
    return 'deleted';
  }
  if (entry.status === 'M' || entry.status === 'T') {
    return 'modified';
  }
  throw new SnapshotGitError(
    'inconsistent-diff',
    `snapshot diff returned unsupported status "${entry.status}" for "${entry.path}"`
  );
}

/** Render a gitlink side the way git's own unified diff does. */
function gitlinkContent(oid: string, entryPath: string): string {
  if (ALL_ZERO_OID_PATTERN.test(oid)) {
    throw new SnapshotGitError(
      'inconsistent-diff',
      `snapshot diff reported an unknown gitlink oid for "${entryPath}"`
    );
  }
  return `Subproject commit ${oid}\n`;
}

export function createSnapshotService({ runner, snapshotsBaseDir }: SnapshotServiceOptions) {
  const entries = new Map<string, RootEntry>();

  function requireEntry(handle: ShadowRepoHandle): RootEntry {
    const entry = entries.get(handle.rootId);
    if (!entry || entry.handle !== handle) {
      throw new SnapshotGitError(
        'stale-handle',
        `handle for root "${handle.rootId}" is stale — call ensureShadowRepo again`
      );
    }
    return entry;
  }

  async function ensureShadowRepo(root: {
    readonly path: string;
    readonly rootId: string;
  }): Promise<ShadowRepoHandle> {
    assertValidRootId(root.rootId);
    let rootPath: string;
    try {
      rootPath = await fsPromises.realpath(root.path);
    } catch (error) {
      throw new SnapshotGitError(
        'root-unavailable',
        `workspace root "${root.path}" is not accessible: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const existing = entries.get(root.rootId);
    if (existing && existing.handle.rootPath === rootPath) {
      return existing.handle;
    }
    const gitDir = path.join(snapshotsBaseDir, root.rootId, 'git');
    const plumbing = createShadowGitPlumbing({ gitDir, rootPath, runner });
    await plumbing.ensureInitialized();
    const handle: ShadowRepoHandle = Object.freeze({ gitDir, rootId: root.rootId, rootPath });
    // A root whose path moved keeps its mutex: serialization is per ROOT.
    entries.set(root.rootId, { handle, mutex: existing?.mutex ?? createMutex(), plumbing });
    return handle;
  }

  /** Stage the work-tree into the op's private index (`add -A`, ignore-aware). */
  async function stageWorktree(
    plumbing: ShadowGitPlumbing,
    env: Readonly<Record<string, string>>
  ): Promise<void> {
    await plumbing.runOrThrow(['add', '-A'], { env });
  }

  async function snapshot(
    handle: ShadowRepoHandle,
    meta: SnapshotMeta
  ): Promise<{ commitOid: string }> {
    const entry = requireEntry(handle);
    const ref = snapshotRefForThread(meta.threadId);
    if (meta.kind !== 'turn-start' && meta.kind !== 'turn-end' && meta.kind !== 'pre-revert') {
      throw new SnapshotGitError('invalid-argument', `unknown snapshot kind "${meta.kind}"`);
    }
    return await entry.mutex(() =>
      entry.plumbing.withTempIndex(async (env) => {
        await stageWorktree(entry.plumbing, env);
        const treeRun = await entry.plumbing.runOrThrow(['write-tree'], { env });
        const treeOid = treeRun.stdout.trim();
        assertValidOid(treeOid, 'write-tree result');
        const parentOid = await entry.plumbing.resolveRefOrNull(ref);
        const message = JSON.stringify({
          kind: meta.kind,
          ...(meta.runId === undefined ? {} : { runId: meta.runId }),
          threadId: meta.threadId,
        });
        const commitRun = await entry.plumbing.runOrThrow(
          ['commit-tree', treeOid, ...(parentOid ? ['-p', parentOid] : []), '-m', message],
          { env }
        );
        const commitOid = commitRun.stdout.trim();
        assertValidOid(commitOid, 'commit-tree result');
        await entry.plumbing.runOrThrow(['update-ref', ref, commitOid], { env });
        return { commitOid };
      })
    );
  }

  /** Read one diff side; `spec` is `<oid>:<path>` or `:0:<path>` (worktree via index). */
  async function readSide(
    plumbing: ShadowGitPlumbing,
    spec: string | null,
    env: Readonly<Record<string, string>> | undefined
  ): Promise<ShadowBlobRead> {
    if (spec === null) {
      return { kind: 'absent' };
    }
    return await plumbing.readBlobSized(spec, env === undefined ? undefined : { env });
  }

  function overCapReason(
    oldOverCap: boolean,
    newOverCap: boolean,
    diffTruncated: boolean
  ): 'diff-overflow' | 'over-cap-both' | 'over-cap-new' | 'over-cap-old' {
    if (oldOverCap && newOverCap) {
      return 'over-cap-both';
    }
    if (oldOverCap) {
      return 'over-cap-old';
    }
    if (newOverCap) {
      return 'over-cap-new';
    }
    if (diffTruncated) {
      return 'diff-overflow';
    }
    throw new SnapshotGitError('inconsistent-diff', 'over-cap reason requested with no cause');
  }

  interface AssembledSides {
    readonly content: StructuredFileDiffContent;
    readonly hunks: StructuredFileDiff['hunks'];
  }

  /** Gitlink "content" is the commit pointer git itself renders — the
   * commit object is not (and need not be) present in the shadow store. */
  function gitlinkSides(
    entry: RawDiffEntry,
    status: 'added' | 'deleted' | 'modified'
  ): { newSide: ShadowBlobRead; oldSide: ShadowBlobRead } {
    return {
      newSide:
        status === 'deleted'
          ? { kind: 'absent' }
          : {
              content: Buffer.from(gitlinkContent(entry.newOid, entry.path), 'utf8'),
              kind: 'present',
            },
      oldSide:
        status === 'added'
          ? { kind: 'absent' }
          : {
              content: Buffer.from(gitlinkContent(entry.oldOid, entry.path), 'utf8'),
              kind: 'present',
            },
    };
  }

  async function readBlobSides(
    plumbing: ShadowGitPlumbing,
    entry: RawDiffEntry,
    status: 'added' | 'deleted' | 'modified',
    from: string,
    toOid: string | null,
    env: Readonly<Record<string, string>> | undefined
  ): Promise<{ newSide: ShadowBlobRead; oldSide: ShadowBlobRead }> {
    const oldSpec = status === 'added' ? null : `${from}:${entry.path}`;
    let newSpec: string | null;
    if (status === 'deleted') {
      newSpec = null;
    } else {
      newSpec = toOid === null ? `:0:${entry.path}` : `${toOid}:${entry.path}`;
    }
    return {
      newSide: await readSide(plumbing, newSpec, toOid === null ? (env ?? {}) : undefined),
      oldSide: await readSide(plumbing, oldSpec, undefined),
    };
  }

  /** Single-file unified diff for hunk ranges (and the hunks-only preview). */
  async function runUnifiedFileDiff(
    plumbing: ShadowGitPlumbing,
    entryPath: string,
    from: string,
    toOid: string | null,
    env: Readonly<Record<string, string>> | undefined
  ): Promise<{ stdout: string; truncated: boolean }> {
    const diffRun = await plumbing.invoke(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        from,
        ...(toOid === null ? [] : [toOid]),
        '--',
        entryPath,
      ],
      env === undefined ? undefined : { env }
    );
    const truncated = diffRun.failureReason === 'maxBuffer';
    if ((diffRun.exitCode !== 0 || diffRun.failureReason !== undefined) && !truncated) {
      throw new SnapshotGitError(
        'git-command-failed',
        `git diff for "${entryPath}" failed with exit ${diffRun.exitCode ?? 'null'}: ${diffRun.stderr.trim()}`
      );
    }
    return { stdout: diffRun.stdout, truncated };
  }

  async function assembleContent(
    plumbing: ShadowGitPlumbing,
    entry: RawDiffEntry,
    from: string,
    toOid: string | null,
    env: Readonly<Record<string, string>> | undefined
  ): Promise<AssembledSides> {
    const status = statusForRawEntry(entry);
    const isGitlink = entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE;
    const { newSide, oldSide } = isGitlink
      ? gitlinkSides(entry, status)
      : await readBlobSides(plumbing, entry, status, from, toOid, env);

    const oldBinary = oldSide.kind === 'present' && oldSide.content.includes(0);
    const newBinary = newSide.kind === 'present' && newSide.content.includes(0);
    if (oldBinary || newBinary) {
      return { content: { kind: 'binary' }, hunks: [] };
    }

    const diff = await runUnifiedFileDiff(plumbing, entry.path, from, toOid, env);
    const oldOverCap = oldSide.kind === 'over-cap';
    const newOverCap = newSide.kind === 'over-cap';
    if (oldOverCap || newOverCap || diff.truncated) {
      const bounded = boundOutput(diff.stdout);
      return {
        content: {
          hunkText: bounded.text,
          hunkTextTruncated: bounded.truncated || diff.truncated,
          kind: 'hunks-only',
          reason: overCapReason(oldOverCap, newOverCap, diff.truncated),
        },
        hunks: parseHunkHeaders(bounded.text),
      };
    }
    return {
      content: {
        kind: 'full',
        newContent: newSide.kind === 'present' ? newSide.content.toString('utf8') : null,
        oldContent: oldSide.kind === 'present' ? oldSide.content.toString('utf8') : null,
      },
      hunks: parseHunkHeaders(diff.stdout),
    };
  }

  /**
   * Structured diffs between two snapshot commits, or between a snapshot and
   * the live work-tree (`{ worktree: true }` — staged into a private index
   * via `add -A`, so ignore semantics match `snapshot()` exactly and no
   * second snapshot commit is required).
   */
  async function diffRefs(
    handle: ShadowRepoHandle,
    from: string,
    to: SnapshotDiffTarget
  ): Promise<StructuredFileDiff[]> {
    const entry = requireEntry(handle);
    assertValidOid(from, 'diffRefs "from"');
    const toOid = typeof to === 'string' ? to : null;
    if (toOid !== null) {
      assertValidOid(toOid, 'diffRefs "to"');
    }

    async function computeDiffs(
      env: Readonly<Record<string, string>> | undefined
    ): Promise<StructuredFileDiff[]> {
      const invokeOptions = env === undefined ? undefined : { env };
      const targetArgs = toOid === null ? [from] : [from, toOid];
      const rawRun = await entry.plumbing.runOrThrow(
        [...RAW_DIFF_ARGS, ...targetArgs],
        invokeOptions
      );
      const rawEntries = parseRawDiffZ(rawRun.stdout);
      if (rawEntries.length === 0) {
        return [];
      }
      const numstatRun = await entry.plumbing.runOrThrow(
        [...NUMSTAT_DIFF_ARGS, ...targetArgs],
        invokeOptions
      );
      const numstatByPath = new Map(
        parseNumstatZ(numstatRun.stdout).map((numstat) => [numstat.path, numstat])
      );
      const diffs: StructuredFileDiff[] = [];
      for (const rawEntry of rawEntries) {
        const numstat = numstatByPath.get(rawEntry.path);
        if (!numstat) {
          throw new SnapshotGitError(
            'inconsistent-diff',
            `numstat is missing "${rawEntry.path}" reported by the raw diff`
          );
        }
        const assembled = await assembleContent(entry.plumbing, rawEntry, from, toOid, env);
        diffs.push({
          additions: numstat.additions,
          content: assembled.content,
          deletions: numstat.deletions,
          hunks: assembled.hunks,
          path: rawEntry.path,
          status: statusForRawEntry(rawEntry),
        });
      }
      return diffs;
    }

    if (toOid !== null) {
      return await computeDiffs(undefined);
    }
    return await entry.plumbing.withTempIndex(async (env) => {
      await stageWorktree(entry.plumbing, env);
      return await computeDiffs(env);
    });
  }

  /**
   * Plan the restore of `targetOid` given the `preRevertOid` snapshot taken
   * immediately before reverting: `git diff --raw target preRevert` decides
   * per-path actions (see `snapshot-restore-plan.ts`).
   */
  async function computeRestorePlan(
    handle: ShadowRepoHandle,
    targetOid: string,
    preRevertOid: string
  ): Promise<RestorePlan> {
    const entry = requireEntry(handle);
    assertValidOid(targetOid, 'computeRestorePlan "targetOid"');
    assertValidOid(preRevertOid, 'computeRestorePlan "preRevertOid"');
    const rawRun = await entry.plumbing.runOrThrow([...RAW_DIFF_ARGS, targetOid, preRevertOid]);
    return {
      actions: computeRestorePlanActions(parseRawDiffZ(rawRun.stdout)),
      preRevertOid,
      targetOid,
    };
  }

  /**
   * Per-path blob oids of one snapshot's tree (gitlink entries included —
   * their "hash" is the recorded commit oid). The canonical source for
   * `applyRestorePlan`'s expected pre-revert hashes.
   */
  async function snapshotFileHashes(
    handle: ShadowRepoHandle,
    oid: string
  ): Promise<ReadonlyMap<string, string>> {
    const entry = requireEntry(handle);
    assertValidOid(oid, 'snapshotFileHashes "oid"');
    const run = await entry.plumbing.runOrThrow(['ls-tree', '-r', '-z', oid]);
    return new Map(parseLsTreeZ(run.stdout).map((treeEntry) => [treeEntry.path, treeEntry.oid]));
  }

  /** Reject restore/delete targets whose EXISTING ancestor dirs include a
   * symlink — writing or unlinking through one would escape the root. A
   * missing ancestor is fine (checkout-index creates real directories). */
  async function findSymlinkedAncestor(
    rootPath: string,
    relativePath: string
  ): Promise<string | null> {
    const segments = relativePath.split('/').slice(0, -1);
    let current = rootPath;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stats: Awaited<ReturnType<typeof fsPromises.lstat>>;
      try {
        stats = await fsPromises.lstat(current);
      } catch {
        return null;
      }
      if (stats.isSymbolicLink()) {
        return current;
      }
    }
    return null;
  }

  async function applyOneAction(
    entry: RootEntry,
    action: RestorePlan['actions'][number],
    currentHashes: ReadonlyMap<string, string>,
    expected: ReadonlyMap<string, string>,
    targetIndexEnv: Readonly<Record<string, string>>
  ): Promise<PerFileOutcome> {
    if (action.kind === 'nested-repo') {
      return { outcome: 'skipped-nested-repo', path: action.path };
    }
    const currentHash = currentHashes.get(action.path);
    const expectedHash = expected.get(action.path);
    if (currentHash !== expectedHash) {
      return {
        message:
          `"${action.path}" changed since the pre-revert snapshot ` +
          `(expected ${expectedHash ?? 'absent'}, found ${currentHash ?? 'absent'}) — left untouched`,
        outcome: 'conflict',
        path: action.path,
      };
    }
    const symlinkedAncestor = await findSymlinkedAncestor(entry.handle.rootPath, action.path);
    if (symlinkedAncestor !== null) {
      return {
        message: `ancestor directory "${symlinkedAncestor}" is a symlink — refusing to write through it`,
        outcome: 'failed',
        path: action.path,
      };
    }
    if (action.kind === 'delete-file') {
      return await executeDeleteAction(entry, action.path);
    }
    return await executeRestoreAction(entry, action.path, targetIndexEnv);
  }

  async function executeDeleteAction(
    entry: RootEntry,
    relativePath: string
  ): Promise<PerFileOutcome> {
    const absolutePath = path.join(entry.handle.rootPath, relativePath);
    try {
      await fsPromises.unlink(absolutePath);
    } catch (error) {
      return {
        message: `delete failed: ${error instanceof Error ? error.message : String(error)}`,
        outcome: 'failed',
        path: relativePath,
      };
    }
    await pruneEmptyAncestorDirectories(entry.handle.rootPath, path.dirname(absolutePath));
    return { outcome: 'deleted', path: relativePath };
  }

  /** restore-file / restore-symlink: checkout-index writes content, mode,
   * and symlinks natively from the target-tree index — no blob ever passes
   * through a bounded stdout capture, so arbitrarily large files restore. */
  async function executeRestoreAction(
    entry: RootEntry,
    relativePath: string,
    targetIndexEnv: Readonly<Record<string, string>>
  ): Promise<PerFileOutcome> {
    try {
      await entry.plumbing.runOrThrow(['checkout-index', '-f', '--', relativePath], {
        env: targetIndexEnv,
      });
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        outcome: 'failed',
        path: relativePath,
      };
    }
    return { outcome: 'restored', path: relativePath };
  }

  /**
   * Apply a restore plan SEQUENTIALLY (never Promise.all — ordering and
   * per-path honesty beat latency on a destructive seam). Flow: one hash
   * scan of the current work-tree (private index `add -A` → `write-tree` →
   * `ls-tree`), then per action: conflict gate → restore via
   * `checkout-index` from a private index holding the TARGET tree, or
   * delete + empty-ancestor prune (bounded at the root).
   */
  async function applyRestorePlan(
    handle: ShadowRepoHandle,
    plan: RestorePlan,
    options: ApplyRestorePlanOptions
  ): Promise<PerFileOutcome[]> {
    const entry = requireEntry(handle);
    assertValidOid(plan.targetOid, 'applyRestorePlan targetOid');
    return await entry.mutex(async () => {
      const currentHashes = await entry.plumbing.withTempIndex(async (env) => {
        await stageWorktree(entry.plumbing, env);
        const treeRun = await entry.plumbing.runOrThrow(['write-tree'], { env });
        const treeOid = treeRun.stdout.trim();
        assertValidOid(treeOid, 'conflict-scan write-tree result');
        const lsRun = await entry.plumbing.runOrThrow(['ls-tree', '-r', '-z', treeOid], { env });
        return new Map(
          parseLsTreeZ(lsRun.stdout).map((treeEntry) => [treeEntry.path, treeEntry.oid])
        );
      });
      return await entry.plumbing.withTempIndex(async (targetIndexEnv) => {
        await entry.plumbing.runOrThrow(['read-tree', plan.targetOid], { env: targetIndexEnv });
        const outcomes: PerFileOutcome[] = [];
        for (const action of plan.actions) {
          outcomes.push(
            await applyOneAction(
              entry,
              action,
              currentHashes,
              options.expectedPreRevertHashes,
              targetIndexEnv
            )
          );
        }
        if (outcomes.length !== plan.actions.length) {
          throw new SnapshotGitError(
            'inconsistent-diff',
            'applyRestorePlan produced fewer outcomes than plan actions'
          );
        }
        return outcomes;
      });
    });
  }

  /** Delete the thread's snapshot lineage ref. `{ deleted: false }` = no ref existed. */
  async function pruneThread(
    handle: ShadowRepoHandle,
    threadId: string
  ): Promise<{ deleted: boolean }> {
    const entry = requireEntry(handle);
    const ref = snapshotRefForThread(threadId);
    return await entry.mutex(async () => {
      const existing = await entry.plumbing.resolveRefOrNull(ref);
      if (existing === null) {
        return { deleted: false };
      }
      await entry.plumbing.runOrThrow(['update-ref', '-d', ref, existing]);
      return { deleted: true };
    });
  }

  /**
   * Remove shadow repo dirs under `baseDir` whose rootId is not in
   * `liveRootIds`. Non-directory entries are not shadow repos and are left
   * alone. A missing base dir means there is nothing to sweep.
   */
  async function sweepOrphans(
    baseDir: string,
    liveRootIds: Iterable<string>
  ): Promise<SweepOrphansResult> {
    const live = new Set(liveRootIds);
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fsPromises.readdir(baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kept: [], removed: [] };
      }
      throw error;
    }
    const kept: string[] = [];
    const removed: string[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) {
        continue;
      }
      if (live.has(dirent.name)) {
        kept.push(dirent.name);
        continue;
      }
      await fsPromises.rm(path.join(baseDir, dirent.name), { force: true, recursive: true });
      removed.push(dirent.name);
    }
    return { kept: kept.sort(), removed: removed.sort() };
  }

  return {
    applyRestorePlan,
    computeRestorePlan,
    diffRefs,
    ensureShadowRepo,
    pruneThread,
    snapshot,
    snapshotFileHashes,
    sweepOrphans,
  };
}

export type SnapshotService = ReturnType<typeof createSnapshotService>;
