/**
 * SnapshotService — the W7 shadow-git snapshot backbone (BST-1164 T0).
 *
 * One shadow git dir per workspace root under a caller-injected
 * `snapshotsBaseDir` (`<base>/<rootId>/git`; production passes
 * `userData/snapshots` in T1 — this module has NO Electron imports). Snapshot
 * commits are taken at turn boundaries via a private per-operation index
 * (`add -A` → `write-tree` → `commit-tree` → `update-ref
 * <canonical thread lineage ref>`); diffs resolve to the shared
 * `StructuredFileDiff` shape through the same payload assembly as git scopes
 * (`structured-diff-content.ts`); restores are computed and applied from
 * snapshot ref pairs with per-path conflict gating.
 *
 * Frozen T0 interface (consumed by T1–T3): `ensureShadowRepo`, `snapshot`,
 * `diffRefs`, `computeRestorePlan`, `applyRestorePlan`, `pruneThread`,
 * `sweepOrphans`. `snapshotFileHashes` is a documented ADDITION for T3's
 * conflict scan (the pre-revert hash map `applyRestorePlan` consumes has to
 * come from somewhere) — it changes nothing about the frozen methods.
 * `worktreeFileHashes` is the second documented T3 addition, same posture:
 * the per-path blob-oid map of the LIVE work-tree (no commit created), which
 * is the rewind preview fingerprint the preview→apply staleness gate in
 * `rewind-snapshot-engine.ts` compares against.
 *
 * T4 additions (BST-1164, same documented-addition posture): the
 * startup-GC primitives `listSnapshotThreadIds` + `pruneHistory` (shallow-cut
 * + `git gc` retention, consumed by `snapshot-startup-gc.ts`).
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
import {
  assertValidOid,
  assertValidRootId,
  createShadowGitPlumbing,
  ENCODED_SNAPSHOT_REF_PREFIX,
  LEGACY_SNAPSHOT_REF_PREFIX,
  type ShadowGitCommands,
  type ShadowGitPlumbing,
  type SnapshotGitCommandRunner,
  SnapshotGitError,
  snapshotRefForThread,
} from './snapshot-git.ts';
import {
  computeRestorePlanActions,
  parseLsTreeZ,
  parseRawDiffZ,
  pruneEmptyAncestorDirectories,
  type RestorePlan,
} from './snapshot-restore-plan.ts';
import {
  type DiffSide,
  fileDiffContent,
  type PatchCapture,
  pinnedDiffArgs,
  pinnedPatchArgs,
} from './structured-diff-content.ts';
import { parseNumstatZ, parseRawZ, type RawDiffRecord } from './structured-diff-parsers.ts';

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

/** A settled turn: its start and end snapshot commits. */
export interface TurnEndpoints {
  readonly fromOid: string;
  readonly toOid: string;
}

/**
 * A turn revert. `busy`: the thread was not idle. `changed`: these paths are
 * no longer as the turn left them. Either way nothing was written; otherwise
 * one outcome per path.
 */
export type TurnRevertResult =
  | { readonly kind: 'busy' }
  | { readonly kind: 'changed'; readonly paths: readonly string[] }
  | { readonly kind: 'written'; readonly outcomes: readonly PerFileOutcome[] };

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
/** A scanned path's entry when it cannot be read as a file: equal to no tree entry. */
const UNREADABLE_PATH = 'unreadable';
const ALL_ZERO_OID_PATTERN = /^0+$/u;

/**
 * `--ignore-submodules=dirty`: a nested repository (a gitlink, such as an
 * agent's worktree under the workspace) counts as changed only when its
 * recorded commit moved. Uncommitted files inside it would otherwise list it
 * as "modified" with the same commit on both sides and +0 −0, a change no
 * restore acts on (see `nested-repo` in snapshot-restore-plan.ts).
 */
const RAW_DIFF_ARGS = [
  'diff',
  '--raw',
  '-z',
  '--no-abbrev',
  '--no-renames',
  '--ignore-submodules=dirty',
] as const;
/**
 * A view pairs a moved file with where it came from, as the git-scope views
 * do. Restore plans keep `--no-renames`: a revert writes and deletes paths.
 */
const VIEW_RAW_DIFF_ARGS = [
  'diff',
  '--raw',
  '-z',
  '--no-abbrev',
  '--find-renames',
  '--ignore-submodules=dirty',
] as const;
const NUMSTAT_DIFF_ARGS = pinnedDiffArgs([
  '--numstat',
  '-z',
  '--find-renames',
  '--ignore-submodules=dirty',
]);

type ViewStatus = 'added' | 'deleted' | 'modified' | 'renamed';

function statusForRawEntry(entry: RawDiffRecord): ViewStatus {
  if (entry.status === 'A') {
    return 'added';
  }
  if (entry.status === 'D') {
    return 'deleted';
  }
  if (entry.status === 'M' || entry.status === 'T') {
    return 'modified';
  }
  if (entry.status === 'R') {
    return 'renamed';
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

function readSnapshotRefIdentity(refname: string, subject: string): string {
  if (refname.startsWith(LEGACY_SNAPSHOT_REF_PREFIX)) {
    const threadId = refname.slice(LEGACY_SNAPSHOT_REF_PREFIX.length);
    if (snapshotRefForThread(threadId) === refname) {
      return threadId;
    }
  } else if (refname.startsWith(ENCODED_SNAPSHOT_REF_PREFIX)) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(subject);
    } catch {
      throw new SnapshotGitError(
        'git-command-failed',
        'Encoded snapshot ref has invalid identity metadata'
      );
    }
    if (
      metadata &&
      typeof metadata === 'object' &&
      'threadId' in metadata &&
      typeof metadata.threadId === 'string' &&
      snapshotRefForThread(metadata.threadId) === refname
    ) {
      return metadata.threadId;
    }
  }
  throw new SnapshotGitError(
    'git-command-failed',
    `Snapshot ref "${refname}" does not match its durable identity`
  );
}

async function verifyEncodedRefOwner(
  plumbing: Pick<ShadowGitCommands, 'runOrThrow'>,
  ref: string,
  oid: string
): Promise<void> {
  if (!ref.startsWith(ENCODED_SNAPSHOT_REF_PREFIX)) {
    return;
  }
  const commit = await plumbing.runOrThrow(['show', '-s', '--format=%s', oid]);
  readSnapshotRefIdentity(ref, commit.stdout.trim());
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
    plumbing: Pick<ShadowGitCommands, 'runOrThrow'>,
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
        // One hook probe, inside the root's lock, serves the whole snapshot.
        const git = await entry.plumbing.hookFreeCommands();
        await stageWorktree(git, env);
        const treeRun = await git.runOrThrow(['write-tree'], { env });
        const treeOid = treeRun.stdout.trim();
        assertValidOid(treeOid, 'write-tree result');
        const parentOid = await git.resolveRefOrNull(ref);
        if (parentOid) {
          await verifyEncodedRefOwner(git, ref, parentOid);
        }
        const message = JSON.stringify({
          kind: meta.kind,
          ...(meta.runId === undefined ? {} : { runId: meta.runId }),
          threadId: meta.threadId,
        });
        const commitRun = await git.runOrThrow(
          ['commit-tree', treeOid, ...(parentOid ? ['-p', parentOid] : []), '-m', message],
          { env }
        );
        const commitOid = commitRun.stdout.trim();
        assertValidOid(commitOid, 'commit-tree result');
        await git.runOrThrow(['update-ref', ref, commitOid], { env });
        return { commitOid };
      })
    );
  }

  /** Read one diff side; `spec` is `<oid>:<path>` or `:0:<path>` (worktree via index). */
  async function readSide(
    plumbing: ShadowGitPlumbing,
    spec: string | null,
    env: Readonly<Record<string, string>> | undefined
  ): Promise<DiffSide> {
    if (spec === null) {
      return { kind: 'absent' };
    }
    return await plumbing.readBlobSized(spec, env === undefined ? undefined : { env });
  }

  /** Gitlink "content" is the commit pointer git itself renders — the
   * commit object is not (and need not be) present in the shadow store. */
  function gitlinkSides(
    entry: RawDiffRecord,
    status: ViewStatus
  ): { newSide: DiffSide; oldSide: DiffSide } {
    return {
      newSide:
        status === 'deleted'
          ? { kind: 'absent' }
          : {
              content: Buffer.from(gitlinkContent(entry.newId, entry.path), 'utf8'),
              kind: 'present',
            },
      oldSide:
        status === 'added'
          ? { kind: 'absent' }
          : {
              content: Buffer.from(gitlinkContent(entry.oldId, entry.path), 'utf8'),
              kind: 'present',
            },
    };
  }

  async function readBlobSides(
    plumbing: ShadowGitPlumbing,
    entry: RawDiffRecord,
    status: ViewStatus,
    from: string,
    toOid: string | null,
    env: Readonly<Record<string, string>> | undefined
  ): Promise<{ newSide: DiffSide; oldSide: DiffSide }> {
    const oldSpec = status === 'added' ? null : `${from}:${entry.oldPath ?? entry.path}`;
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

  /** Git's patch for one file, in the pinned output format; a moved file's names both paths. */
  async function runUnifiedFileDiff(
    plumbing: ShadowGitPlumbing,
    entry: RawDiffRecord,
    from: string,
    toOid: string | null,
    env: Readonly<Record<string, string>> | undefined
  ): Promise<PatchCapture> {
    const entryPath = entry.path;
    const diffRun = await plumbing.invoke(
      pinnedPatchArgs([
        '--find-renames',
        '--ignore-submodules=dirty',
        from,
        ...(toOid === null ? [] : [toOid]),
        '--',
        ...(entry.oldPath === null ? [] : [entry.oldPath]),
        entryPath,
      ]),
      env === undefined ? undefined : { env }
    );
    const truncated = diffRun.failureReason === 'maxBuffer';
    if ((diffRun.exitCode !== 0 || diffRun.failureReason !== undefined) && !truncated) {
      throw new SnapshotGitError(
        'git-command-failed',
        `git diff for "${entryPath}" failed with exit ${diffRun.exitCode ?? 'null'}: ${diffRun.stderr.trim()}`
      );
    }
    return { text: diffRun.stdout, truncated };
  }

  async function assembleContent(
    plumbing: ShadowGitPlumbing,
    entry: RawDiffRecord,
    from: string,
    toOid: string | null,
    env: Readonly<Record<string, string>> | undefined
  ): Promise<StructuredFileDiffContent> {
    const status = statusForRawEntry(entry);
    const isGitlink = entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE;
    const { newSide, oldSide } = isGitlink
      ? gitlinkSides(entry, status)
      : await readBlobSides(plumbing, entry, status, from, toOid, env);
    const patch = await runUnifiedFileDiff(plumbing, entry, from, toOid, env);
    return fileDiffContent(oldSide, newSide, patch);
  }

  /**
   * Structured diffs between two snapshot commits, or between a snapshot and
   * the live work-tree (`{ worktree: true }` — staged into a private index
   * via `add -A`, so ignore semantics match `snapshot()` exactly and no
   * second snapshot commit is required). A moved file lists once, renamed.
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
        [...VIEW_RAW_DIFF_ARGS, ...targetArgs],
        invokeOptions
      );
      const rawEntries = parseRawZ(rawRun.stdout);
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
        diffs.push({
          additions: numstat.additions,
          content: await assembleContent(entry.plumbing, rawEntry, from, toOid, env),
          deletions: numstat.deletions,
          ...(rawEntry.oldPath === null ? {} : { oldPath: rawEntry.oldPath }),
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

  /**
   * Stage the LIVE work-tree into a private index and return its per-path
   * blob-oid map — the ONE definition of "what does the work-tree hash to
   * right now", shared by `applyRestorePlan`'s conflict gate and
   * `worktreeFileHashes`. Callers must already hold (or not need) the root
   * mutex; this helper never takes it, because `createMutex` is a FIFO
   * promise chain and a nested acquisition would deadlock.
   */
  async function readWorktreeHashes(entry: RootEntry): Promise<ReadonlyMap<string, string>> {
    return await entry.plumbing.withTempIndex(async (env) => {
      await stageWorktree(entry.plumbing, env);
      const treeRun = await entry.plumbing.runOrThrow(['write-tree'], { env });
      const treeOid = treeRun.stdout.trim();
      assertValidOid(treeOid, 'worktree-scan write-tree result');
      const lsRun = await entry.plumbing.runOrThrow(['ls-tree', '-r', '-z', treeOid], { env });
      return new Map(
        parseLsTreeZ(lsRun.stdout).map((treeEntry) => [treeEntry.path, treeEntry.oid])
      );
    });
  }

  /**
   * Per-path blob oids of the LIVE work-tree, staged with the same `add -A`
   * ignore semantics as `snapshot()` but WITHOUT creating a commit or moving
   * any ref. T3 ADDITION (see the module doc comment): the rewind engine
   * fingerprints the work-tree at preview time and compares at apply time —
   * any path whose oid changed in between is content the user was never
   * shown, which is exactly what the preview→apply staleness gate refuses
   * over.
   */
  async function worktreeFileHashes(
    handle: ShadowRepoHandle
  ): Promise<ReadonlyMap<string, string>> {
    const entry = requireEntry(handle);
    return await entry.mutex(() => readWorktreeHashes(entry));
  }

  /** The first EXISTING ancestor of `relativePath` that `stops` matches, or
   * null. A missing ancestor ends the walk. */
  async function findAncestor(
    rootPath: string,
    relativePath: string,
    stops: (stats: Awaited<ReturnType<typeof fsPromises.lstat>>) => boolean
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
      if (stops(stats)) {
        return current;
      }
    }
    return null;
  }

  /** Reject restore/delete targets whose EXISTING ancestor dirs include a
   * symlink — writing or unlinking through one would escape the root. A
   * missing ancestor is fine (checkout-index creates real directories). */
  function findSymlinkedAncestor(rootPath: string, relativePath: string): Promise<string | null> {
    return findAncestor(rootPath, relativePath, (stats) => stats.isSymbolicLink());
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
      const currentHashes = await readWorktreeHashes(entry);
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

  /**
   * The live mode and blob oid of each of `paths` (`<mode> <oid>`), hashed
   * into a private index the way `update-index --add` writes it: only these
   * paths, whatever the ignore rules say. An absent path is left out. A path
   * that is now a directory, lies under a file, or lies past a symlinked
   * directory maps to {@link UNREADABLE_PATH}, which no tree entry equals.
   */
  async function readPathHashes(
    entry: RootEntry,
    git: ShadowGitCommands,
    paths: readonly string[]
  ): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    const present: string[] = [];
    for (const relativePath of paths) {
      // The walk, not lstat's error, says a path lies under a file: Windows
      // answers ENOENT for it where POSIX answers ENOTDIR.
      const blocked = await findAncestor(
        entry.handle.rootPath,
        relativePath,
        (stats) => !stats.isDirectory()
      );
      if (blocked !== null) {
        hashes.set(relativePath, UNREADABLE_PATH);
        continue;
      }
      const stats = await fsPromises
        .lstat(path.join(entry.handle.rootPath, relativePath))
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
          }
          throw error;
        });
      if (stats?.isDirectory()) {
        hashes.set(relativePath, UNREADABLE_PATH);
      } else if (stats) {
        present.push(relativePath);
      }
    }
    if (present.length === 0) {
      return hashes;
    }
    return await entry.plumbing.withTempIndex(async (env) => {
      await git.runOrThrow(['update-index', '--add', '-z', '--stdin'], {
        env,
        input: `${present.join('\0')}\0`,
      });
      const treeRun = await git.runOrThrow(['write-tree'], { env });
      const treeOid = treeRun.stdout.trim();
      assertValidOid(treeOid, 'path-scan write-tree result');
      const lsRun = await git.runOrThrow(['ls-tree', '-r', '-z', treeOid], { env });
      for (const treeEntry of parseLsTreeZ(lsRun.stdout)) {
        hashes.set(treeEntry.path, `${treeEntry.mode} ${treeEntry.oid}`);
      }
      return hashes;
    });
  }

  /**
   * A turn `fromOid` → `toOid` as a restore plan back to `fromOid`, without
   * gitlinks and cut to `paths` when given, with each path's mode and blob
   * at `toOid` (from the turn's own diff) and on disk now. A path is
   * unchanged since the turn while the two agree; one the turn deleted must
   * still be absent.
   */
  async function turnPlan(
    entry: RootEntry,
    git: ShadowGitCommands,
    turn: TurnEndpoints,
    paths?: ReadonlySet<string>
  ) {
    const rawRun = await git.runOrThrow([...RAW_DIFF_ARGS, turn.fromOid, turn.toOid]);
    const records = parseRawDiffZ(rawRun.stdout);
    const actions = computeRestorePlanActions(records).filter(
      (action) => action.kind !== 'nested-repo' && (paths === undefined || paths.has(action.path))
    );
    const atEnd = new Map(
      records
        .filter((record) => record.status !== 'D')
        .map((record) => [record.path, `${record.newMode} ${record.newOid}`])
    );
    const now = await readPathHashes(
      entry,
      git,
      actions.map((action) => action.path)
    );
    const unchanged = new Set(
      actions
        .filter((action) => now.get(action.path) === atEnd.get(action.path))
        .map(({ path: changed }) => changed)
    );
    return { actions, atEnd, now, unchanged };
  }

  function turnEntry(handle: ShadowRepoHandle, turn: TurnEndpoints): RootEntry {
    const entry = requireEntry(handle);
    assertValidOid(turn.fromOid, 'turn "fromOid"');
    assertValidOid(turn.toOid, 'turn "toOid"');
    return entry;
  }

  /**
   * The paths a turn changed that the live work-tree still holds exactly as
   * the turn left them: what {@link revertTurnPaths} would take now.
   */
  async function unchangedSinceTurn(
    handle: ShadowRepoHandle,
    turn: TurnEndpoints
  ): Promise<ReadonlySet<string>> {
    const entry = turnEntry(handle, turn);
    const git = await entry.plumbing.hookFreeCommands();
    return (await turnPlan(entry, git, turn)).unchanged;
  }

  /**
   * Put `paths` back as they were at the turn's start, as one change: only
   * while `idle` says the thread is idle and every path is a change of the
   * turn that the live work-tree still holds as the turn left it. The root's
   * lock is held from `idle` to the last write, and a run's turn-start
   * snapshot takes the same lock, so a run that starts meanwhile starts from
   * the reverted files.
   */
  async function revertTurnPaths(
    handle: ShadowRepoHandle,
    turn: TurnEndpoints,
    paths: readonly string[],
    idle: () => Promise<boolean>
  ): Promise<TurnRevertResult> {
    const entry = turnEntry(handle, turn);
    return await entry.mutex(async () => {
      if (!(await idle())) {
        return { kind: 'busy' };
      }
      const git = await entry.plumbing.hookFreeCommands();
      const wanted = new Set(paths);
      const plan = await turnPlan(entry, git, turn, wanted);
      const changed = [...wanted].filter((wantedPath) => !plan.unchanged.has(wantedPath));
      if (changed.length > 0) {
        return { kind: 'changed', paths: changed };
      }
      return await entry.plumbing.withTempIndex(async (targetIndexEnv) => {
        await git.runOrThrow(['read-tree', turn.fromOid], { env: targetIndexEnv });
        const outcomes: PerFileOutcome[] = [];
        for (const action of plan.actions) {
          outcomes.push(await applyOneAction(entry, action, plan.now, plan.atEnd, targetIndexEnv));
        }
        return { kind: 'written', outcomes };
      });
    });
  }

  /** Inventory both legacy refs and encoded native identities for startup GC.
   * Encoded refs are decoded from their existing commit metadata and checked
   * against the canonical key; corruption must never hide or prune another owner. */
  async function listSnapshotThreadIds(handle: ShadowRepoHandle): Promise<readonly string[]> {
    const entry = requireEntry(handle);
    const run = await entry.plumbing.runOrThrow([
      'for-each-ref',
      '--format=%(refname)%00%(contents:subject)',
      LEGACY_SNAPSHOT_REF_PREFIX,
      ENCODED_SNAPSHOT_REF_PREFIX,
    ]);
    return run.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf('\0');
        if (separator < 0) {
          throw new SnapshotGitError(
            'git-command-failed',
            'Snapshot ref inventory has no metadata separator'
          );
        }
        return readSnapshotRefIdentity(line.slice(0, separator), line.slice(separator + 1));
      });
  }

  /**
   * Reclaim shadow-repo history beyond the retention ring (BST-1164 T4).
   *
   * Snapshot commits chain per thread (`commit-tree -p`), so deleting ledger
   * rows alone never frees objects — the per-thread ref keeps every ancestor
   * alive. The cut is git's own shallow mechanism: `keepBoundaries` (the
   * OLDEST ledger-referenced commit per surviving thread chain in this repo)
   * is written to `<gitDir>/shallow`, which makes those commits parentless to
   * every reachability walk, and `git gc --prune=now --quiet` then collects
   * everything behind them (and everything orphaned by deleted refs).
   * Verified empirically against git 2.x: pruned-turn blobs are reclaimed,
   * kept-range `diff`/`ls-tree`/restores still work, and new snapshots stack
   * on the shallow chain; successive trims stay `fsck`-clean. An EMPTY
   * boundary set removes the shallow file (no cut) and still runs gc.
   *
   * Runs under the root mutex — never concurrently with a snapshot/restore.
   * Callers keep it off the run hot path (startup sweep only).
   */
  async function pruneHistory(
    handle: ShadowRepoHandle,
    keepBoundaries: readonly string[]
  ): Promise<void> {
    const entry = requireEntry(handle);
    for (const oid of keepBoundaries) {
      assertValidOid(oid, 'pruneHistory boundary');
    }
    await entry.mutex(async () => {
      const shallowPath = path.join(entry.handle.gitDir, 'shallow');
      const unique = [...new Set(keepBoundaries)].sort();
      if (unique.length === 0) {
        await fsPromises.rm(shallowPath, { force: true });
      } else {
        await fsPromises.writeFile(shallowPath, `${unique.join('\n')}\n`, 'utf8');
      }
      await entry.plumbing.runOrThrow(['gc', '--prune=now', '--quiet']);
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
      await verifyEncodedRefOwner(entry.plumbing, ref, existing);
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
    listSnapshotThreadIds,
    pruneHistory,
    pruneThread,
    revertTurnPaths,
    snapshot,
    snapshotFileHashes,
    sweepOrphans,
    unchangedSinceTurn,
    worktreeFileHashes,
  };
}

export type SnapshotService = ReturnType<typeof createSnapshotService>;
