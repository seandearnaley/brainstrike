/**
 * Managed-worktree lifecycle (spec §6). Desktop MAIN only.
 *
 * Every git invocation goes through the injected `GitCommandRunner` (the same
 * `execFileGitRunner` + `createPinnedGitEnvironment` the inventory and the git
 * panel use) wrapped in `invokeGitHookFree`: these repositories are discovered,
 * not audited, and a `git worktree add` that runs a repository hook would be a
 * code-execution path the user never asked for.
 *
 * Mutations are SERIALIZED through one FIFO tail. `git worktree add` mutates
 * `.git/worktrees/` and the name-collision check reads the ledger, so two
 * concurrent creates could both see a free name and one would fail on disk
 * halfway through — leaving a directory with no ledger row.
 *
 * NEVER throws across its own boundary: every failure is a typed
 * `BoundaryResult<never>` (the `changes`/`git` domain convention).
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type {
  ManagedWorktreePathEntry,
  ManagedWorktreeRow,
  WorktreeAdoptParams,
  WorktreeArchivePreview,
  WorktreeArchiveResult,
  WorktreeCheckoutStatus,
  WorktreeCreateContext,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
  WorktreeSetupOutcome,
} from '@brainstrike/types';
import { describeFailure, gitCommandFailed, gitFault, gitRefused } from './git-failure.ts';
import { GIT_DEFAULT_TIMEOUT_MS, invokeGitHookFree, toErrorMessage } from './git-service.ts';
import { generateWorkspaceSnapshotId } from './snapshot-repository.ts';
import {
  adoptWorktree,
  ghostListEntry,
  inventoryListEntry,
  isAuthorizedWorktreeMountPath,
  readCheckoutStatus,
  reconcileWorktreesFromShell,
  type WorktreeAdoptDeps,
  type WorktreeShellReconcileResult,
} from './worktree-adopt.ts';
import {
  captureArchiveSnapshot,
  captureMissingArchiveSnapshot,
  findNestedRepositories,
  inspectWorktreeSafety,
  nestedRepositoriesArchiveBlocker,
  type WorktreeSafetyReport as SafetyReport,
} from './worktree-archive.ts';
import {
  ignoredEntriesArchiveBlocker,
  inspectWorktreeArchivePreviewForPath,
  worktreePathExists,
} from './worktree-archive-preview.ts';
import { archiveIdleWorktree } from './worktree-idle-archive.ts';
import { createWorktreeLedger } from './worktree-ledger.ts';
import { WorktreeOperationLifetime } from './worktree-operation-lifetime.ts';
import {
  assertWorktreeTargetOutsideRoots,
  generateWorktreeName,
  repositorySlug,
  resolveWorktreeTargetPath,
} from './worktree-paths.ts';
import {
  buildRootIdByRealPath,
  createMutex,
  type RepositoryContext,
  type WorktreeArchiveParams,
  type WorktreeServiceDeps,
  type WorktreeSetupInput,
} from './worktree-service-inputs.ts';
import { resolveRepositorySetupContext } from './worktree-setup-consent.ts';

const logger = createLogger('WorktreeService');

export type { WorktreeServiceDeps, WorktreeSetupInput } from './worktree-service-inputs.ts';

export function createWorktreeService(deps: WorktreeServiceDeps) {
  const ledger = createWorktreeLedger(deps.getWorktreeStore, deps.hasRunningThread);
  const serialize = createMutex();
  const lifetime = new WorktreeOperationLifetime();
  const notActive = (worktreeId: string) =>
    gitRefused(
      'conflict',
      'worktree.not-active',
      `Managed worktree "${worktreeId}" is not active.`
    );

  function adoptDeps(): WorktreeAdoptDeps {
    return {
      ledger,
      readSettings: deps.readSettings,
      resolveInventory: deps.resolveInventory,
      resolveRootPaths: deps.resolveRootPaths,
      run: deps.run,
    };
  }

  function invokeIn(cwd: string) {
    return (args: readonly string[], timeoutMs: number = GIT_DEFAULT_TIMEOUT_MS) =>
      deps.run({ args, cwd, timeoutMs });
  }

  async function resolveRepositoryContext(
    rootId: string
  ): Promise<BoundaryResult<RepositoryContext>> {
    const cwd = await deps.resolveRootCwd(rootId);
    if (!cwd.ok) {
      return cwd;
    }
    const invoke = invokeIn(cwd.value);
    const commonDirRun = await invokeGitHookFree(invoke, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (commonDirRun.exitCode !== 0) {
      return gitCommandFailed(commonDirRun);
    }
    const topLevelRun = await invokeGitHookFree(invoke, ['rev-parse', '--show-toplevel']);
    if (topLevelRun.exitCode !== 0) {
      return gitCommandFailed(topLevelRun);
    }
    // Realpath both: the inventory keys repositories on the realpath'd common
    // dir, and a ledger row keyed on a symlinked path would never join.
    const [commonDir, repositoryRoot] = await Promise.all([
      fsPromises.realpath(commonDirRun.stdout.trim()),
      fsPromises.realpath(topLevelRun.stdout.trim()),
    ]);
    return { ok: true, value: { commonDir, cwd: cwd.value, repositoryRoot } };
  }

  async function assertBranchAvailable(cwd: string, branch: string): Promise<BoundaryResult<null>> {
    const exists = await invokeGitHookFree(invokeIn(cwd), [
      'show-ref',
      '--verify',
      '--hash',
      `refs/heads/${branch}`,
    ]);
    if (exists.exitCode === 0) {
      return gitRefused('conflict', 'git.branch-exists', `local branch "${branch}" already exists`);
    }
    return { ok: true, value: null };
  }

  async function resolveCreateTarget(
    settings: WorktreeSettings,
    context: RepositoryContext,
    name: string
  ): Promise<BoundaryResult<string>> {
    const slug = repositorySlug(context.repositoryRoot, context.commonDir);
    const roots = await deps.resolveRootPaths();
    // Lexical pre-check on the RAW paths before any mkdir: a refused managed
    // directory must not be created on disk as a side effect of the refusal.
    // The canonical re-check below still guards symlinked configurations.
    try {
      const rawTarget = resolveWorktreeTargetPath(settings.managedDirectory, slug, name);
      assertWorktreeTargetOutsideRoots(
        rawTarget,
        roots.map((root) => root.path)
      );
    } catch (error) {
      logger.warn('worktree create refused by path policy', { error, name });
      return gitRefused('input', 'worktree.path-refused', toErrorMessage(error));
    }
    const createdDirectory = await fsPromises.mkdir(settings.managedDirectory, {
      recursive: true,
    });
    const managedDirectory = await fsPromises.realpath(settings.managedDirectory);
    const target = resolveWorktreeTargetPath(managedDirectory, slug, name);
    const canonicalRootPaths = await Promise.all(
      roots.map((root) => fsPromises.realpath(root.path).catch(() => root.path))
    );
    try {
      assertWorktreeTargetOutsideRoots(target, canonicalRootPaths);
    } catch (error) {
      if (createdDirectory !== undefined) {
        await fsPromises.rm(createdDirectory, { recursive: true });
      }
      logger.warn('worktree create refused by path policy', { error, name });
      return gitRefused('input', 'worktree.path-refused', toErrorMessage(error));
    }
    return { ok: true, value: target };
  }

  async function insertCreatedWorktree(
    context: RepositoryContext,
    params: WorktreeCreateParams,
    branchName: string | null,
    target: string
  ): Promise<ManagedWorktreeRow> {
    try {
      return await ledger.insert({
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: params.baseRef,
        branch: branchName,
        createdAt: new Date().toISOString(),
        createdBy: params.createdBy,
        id: generateWorkspaceSnapshotId(),
        path: target,
        repoCommonDir: context.commonDir,
        runId: params.runId ?? null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: params.threadId ?? null,
      });
    } catch (insertError) {
      try {
        const removeRun = await invokeGitHookFree(invokeIn(context.cwd), [
          'worktree',
          'remove',
          '--force',
          '--',
          target,
        ]);
        if (removeRun.exitCode !== 0) {
          logger.error('could not compensate for failed worktree ledger insert', {
            error: describeFailure(removeRun),
            target,
          });
        } else if (branchName !== null) {
          const deleteBranchRun = await invokeGitHookFree(invokeIn(context.cwd), [
            'branch',
            '-D',
            '--',
            branchName,
          ]);
          if (deleteBranchRun.exitCode !== 0) {
            logger.error('could not delete branch after failed worktree ledger insert', {
              branchName,
              error: describeFailure(deleteBranchRun),
              target,
            });
          }
        }
      } catch (cleanupError) {
        logger.error('worktree ledger insert cleanup threw', { cleanupError, target });
      }
      throw insertError;
    }
  }

  /**
   * The repository's standing answer is read here, for every create, so the
   * person's own worktree, the model's and Automatic isolation's run setup
   * alike. A record that cannot be read fails setup visibly, not the create.
   */
  async function runSetupSafely(
    repositoryId: string,
    input: Omit<WorktreeSetupInput, 'repositorySetupDecision'>
  ): Promise<WorktreeSetupOutcome> {
    try {
      const decision = await deps.readRepositorySetupConsent(repositoryId);
      return await deps.runSetup({
        ...input,
        ...(decision ? { repositorySetupDecision: decision } : {}),
      });
    } catch (error) {
      return {
        copiedPaths: [],
        output: '',
        reason: toErrorMessage(error),
        skippedCopies: [],
        status: 'failed',
        truncated: false,
      };
    }
  }

  async function createUnserialized(
    params: WorktreeCreateParams
  ): Promise<BoundaryResult<WorktreeCreateResult>> {
    const context = await resolveRepositoryContext(params.rootId);
    if (!context.ok) {
      return context;
    }
    const settings = await deps.readSettings();
    const targetResult = await resolveCreateTarget(settings, context.value, params.name);
    if (!targetResult.ok) {
      return targetResult;
    }
    const target = targetResult.value;
    if (await ledger.getByPath(target)) {
      return gitRefused(
        'conflict',
        'worktree.path-exists',
        `A worktree at "${target}" already exists.`
      );
    }
    const branchName = 'name' in params.branch ? params.branch.name : null;
    if (branchName) {
      const available = await assertBranchAvailable(context.value.cwd, branchName);
      if (!available.ok) {
        return available;
      }
    }
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    const addRun = await invokeGitHookFree(invokeIn(context.value.cwd), [
      'worktree',
      'add',
      ...(branchName ? ['-b', branchName] : ['--detach']),
      '--',
      target,
      params.baseRef,
    ]);
    if (addRun.exitCode !== 0) {
      return gitCommandFailed(addRun);
    }
    const row = await insertCreatedWorktree(context.value, params, branchName, target);
    // Setup failure is VISIBLE and does NOT block using the worktree (§6.3):
    // the outcome rides back on the result and is persisted on the row.
    const setup = await runSetupSafely(context.value.commonDir, {
      settings,
      sourcePath: context.value.repositoryRoot,
      worktree: row,
    });
    let worktree = row;
    try {
      worktree = await ledger.recordSetup(row.id, setup);
    } catch (error) {
      logger.error('could not record worktree setup outcome', {
        error,
        setupStatus: setup.status,
        worktreeId: row.id,
      });
    }
    deps.afterCreate?.(worktree, params);
    return { ok: true, value: { setup, worktree } };
  }

  /**
   * Inventory ⋈ ledger (spec §5.3). Every worktree the inventory reports is
   * listed, plus every LIVE ledger row that is not on disk — the latter as
   * `provenance: 'agent-reported'`, `trust: 'unvalidated'`, reason "missing on
   * disk". Nothing is dropped.
   */
  async function listUnserialized(): Promise<BoundaryResult<readonly WorktreeListEntry[]>> {
    const [inventory, rows, roots] = await Promise.all([
      deps.resolveInventory(),
      ledger.listActive(),
      deps.resolveRootPaths(),
    ]);
    const rowsByPath = new Map(rows.map((row) => [row.path, row]));
    // Realpath'd, matching the basis `descriptor.path` and `row.path` already
    // use (git-inventory-service.ts canonicalizes worktree paths before
    // building descriptors; ledger rows are written from that same
    // canonical path) — a raw, non-canonical `root.path` would silently miss
    // an exact-mount match through a symlink and, before this fix, fall
    // through to the containment fallback that conflated "exact mount" with
    // "merely contains" (bot review, PR #2664 finding 1).
    const rootIdByPath = await buildRootIdByRealPath(roots);
    const seenPaths = new Set<string>();
    const entries: WorktreeListEntry[] = [];

    for (const repository of inventory.repositories) {
      for (const descriptor of repository.worktrees) {
        seenPaths.add(descriptor.path);
        const row = rowsByPath.get(descriptor.path) ?? null;
        entries.push(
          inventoryListEntry(
            descriptor,
            row,
            repository.identity.repositoryRoot,
            repository.identity.gitCommonDir,
            rootIdByPath
          )
        );
      }
    }

    for (const row of rows) {
      if (seenPaths.has(row.path)) {
        continue;
      }
      entries.push(ghostListEntry(row, rootIdByPath));
    }
    return { ok: true, value: entries };
  }

  async function inspectArchiveRow(row: ManagedWorktreeRow): Promise<BoundaryResult<SafetyReport>> {
    const inventory = await deps.resolveInventory();
    const descriptor = inventory.repositories
      .flatMap((repository) => repository.worktrees)
      .find((worktree) => worktree.path === row.path);
    return await inspectWorktreeSafety({
      baseRef: row.baseRef,
      invoke: invokeIn(row.path),
      lockedReason: descriptor?.lockedReason ?? null,
      threadIsRunning: await ledger.hasRunningThread(row.id),
      worktree: { id: row.id, path: row.path },
    });
  }

  async function removeArchivedWorktree(
    row: ManagedWorktreeRow,
    force: boolean
  ): Promise<BoundaryResult<null>> {
    const removeRun = await invokeGitHookFree(invokeIn(row.repoCommonDir), [
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      '--',
      row.path,
    ]);
    if (removeRun.exitCode !== 0) {
      return gitCommandFailed(removeRun);
    }
    return { ok: true, value: null };
  }

  function resolveArchiveBlocker(safety: SafetyReport, force: boolean): string | null {
    if (safety.threadIsRunning) {
      // The ONE blocker `force` never overrides.
      const runningBlocker = safety.blockers.find((blocker) => blocker.length > 0);
      if (!runningBlocker) {
        throw new Error(
          'Internal error: threadIsRunning but no blocker was reported — archive refused (fail-closed).'
        );
      }
      return runningBlocker;
    }
    // Nested repositories are not in the snapshot, so `force` cannot make
    // archiving them safe either (BST-1625).
    if (safety.nestedRepositories.length > 0) {
      return nestedRepositoriesArchiveBlocker(safety.nestedRepositories);
    }
    if (!(force || safety.blockers.length === 0)) {
      return safety.blockers.find((blocker) => blocker.length > 0) ?? null;
    }
    return null;
  }

  async function archiveMissingWorktree(
    row: ManagedWorktreeRow
  ): Promise<BoundaryResult<WorktreeArchiveResult>> {
    const snapshot = await captureMissingArchiveSnapshot({
      cwd: row.repoCommonDir,
      run: deps.run,
      worktree: row,
    });
    if (!snapshot.ok) {
      return snapshot;
    }
    // The directory is already gone, so removal cannot run. Expire the stale
    // administrative entry immediately before making the ledger archival
    // durable; otherwise inventory would keep rediscovering a ghost path.
    const pruneRun = await invokeGitHookFree(invokeIn(row.repoCommonDir), [
      'worktree',
      'prune',
      '--expire',
      'now',
    ]);
    if (pruneRun.exitCode !== 0) {
      return gitCommandFailed(pruneRun);
    }
    try {
      const worktree = await ledger.markArchived(row.id, snapshot.value);
      return { ok: true, value: { snapshotRef: snapshot.value, worktree } };
    } catch (error) {
      logger.error('missing worktree was pruned but its archive ledger write failed', {
        error,
        snapshotRef: snapshot.value,
        worktreeId: row.id,
      });
      return gitFault(
        'worktree.ledger-write-failed',
        `The missing worktree registration was pruned, but its archive status could not be recorded: ${toErrorMessage(
          error
        )}; your snapshot is at ${snapshot.value}.`
      );
    }
  }

  /**
   * Checked before the snapshot: `git add -A` fails outright on a nested
   * repository with no commit, which would surface as a raw Git error
   * instead of this refusal (BST-1625).
   */
  async function refuseNestedRepositories(row: ManagedWorktreeRow): Promise<BoundaryResult<null>> {
    const nested = await findNestedRepositories({
      invoke: invokeIn(row.path),
      worktreePath: row.path,
    });
    if (!nested.ok) {
      return nested;
    }
    if (nested.value.length > 0) {
      return gitRefused(
        'conflict',
        'worktree.archive-blocked',
        nestedRepositoriesArchiveBlocker(nested.value)
      );
    }
    return { ok: true, value: null };
  }

  async function archiveUnserialized(
    params: WorktreeArchiveParams
  ): Promise<BoundaryResult<WorktreeArchiveResult>> {
    const row = await ledger.get(params.worktreeId);
    if (!row || row.archivedAt !== null) {
      return notActive(params.worktreeId);
    }
    if (!(await worktreePathExists(row.path))) {
      return await archiveMissingWorktree(row);
    }
    const nestedRefusal = await refuseNestedRepositories(row);
    if (!nestedRefusal.ok) {
      return nestedRefusal;
    }
    const snapshot = await captureArchiveSnapshot({ cwd: row.path, run: deps.run, worktree: row });
    if (!snapshot.ok) {
      return snapshot;
    }
    // Private GIT_INDEX_FILE capture never mutates the worktree or index; this report is authoritative.
    const currentSafety = await inspectArchiveRow(row);
    if (!currentSafety.ok) {
      return currentSafety;
    }
    const blocker = resolveArchiveBlocker(currentSafety.value, params.force === true);
    if (blocker !== null) {
      return gitRefused('conflict', 'worktree.archive-blocked', blocker);
    }
    if (
      currentSafety.value.ignoredEntryCount > 0 &&
      params.confirmIgnoredEntries !== currentSafety.value.ignoredEntriesConfirmationToken
    ) {
      return gitRefused(
        'conflict',
        'worktree.ignored-entries-unconfirmed',
        ignoredEntriesArchiveBlocker(currentSafety.value)
      );
    }
    const removed = await removeArchivedWorktree(row, params.force === true);
    if (!removed.ok) {
      return removed;
    }
    try {
      const worktree = await ledger.markArchived(row.id, snapshot.value);
      return { ok: true, value: { snapshotRef: snapshot.value, worktree } };
    } catch (error) {
      logger.error('worktree was removed but its archive ledger write failed', {
        error,
        snapshotRef: snapshot.value,
        worktreeId: row.id,
      });
      return gitFault(
        'worktree.ledger-write-failed',
        `The worktree was removed, but its archive status could not be recorded: ${toErrorMessage(
          error
        )}; your snapshot is at ${snapshot.value}.`
      );
    }
  }

  async function assertRestoreTargetAvailable(target: string): Promise<BoundaryResult<null>> {
    try {
      const entries = await fsPromises.readdir(target);
      if (entries.length === 0) {
        return { ok: true, value: null };
      }
      return gitRefused(
        'conflict',
        'worktree.restore-target-occupied',
        `"${target}" already exists and is not empty — move it aside before restoring.`
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { ok: true, value: null };
      }
      throw error;
    }
  }

  async function replayArchiveSnapshot(
    row: ManagedWorktreeRow,
    snapshotRef: string
  ): Promise<BoundaryResult<null>> {
    // Git restore defaults to --no-overlay; that is load-bearing because paths
    // absent from the captured tree must be deleted for archive round-trips.
    const replayRun = await invokeGitHookFree(invokeIn(row.path), [
      'restore',
      `--source=${snapshotRef}`,
      '--worktree',
      '--',
      '.',
    ]);
    if (replayRun.exitCode === 0) {
      return { ok: true, value: null };
    }
    const replayError = describeFailure(replayRun);
    try {
      const removeRun = await invokeGitHookFree(invokeIn(row.repoCommonDir), [
        'worktree',
        'remove',
        '--force',
        '--',
        row.path,
      ]);
      if (removeRun.exitCode !== 0) {
        logger.error('could not compensate for failed archive snapshot replay', {
          removalError: describeFailure(removeRun),
          restoreError: replayError,
          target: row.path,
          worktreeId: row.id,
        });
      }
    } catch (cleanupError) {
      logger.error('archive snapshot replay compensation threw', {
        cleanupError,
        restoreError: replayError,
        target: row.path,
        worktreeId: row.id,
      });
    }
    return gitCommandFailed(replayRun);
  }

  async function recordRestoredWorktree(
    row: ManagedWorktreeRow,
    snapshotRef: string
  ): Promise<BoundaryResult<WorktreeCreateResult>> {
    const setup = {
      copiedPaths: [],
      output: '',
      reason: null,
      skippedCopies: [],
      status: 'none',
      truncated: false,
    } as const;
    try {
      const worktree = await ledger.markRestored(row.id);
      return { ok: true, value: { setup, worktree } };
    } catch (error) {
      logger.error('worktree was restored but its ledger write failed', {
        error,
        snapshotRef,
        target: row.path,
        worktreeId: row.id,
      });
      return gitFault(
        'worktree.ledger-write-failed',
        `The worktree was restored to ${row.path}, but its ledger status could not be recorded: ${toErrorMessage(
          error
        )}.`
      );
    }
  }

  async function resolveRestoreAddArgs(
    row: ManagedWorktreeRow,
    snapshotRef: string,
    repositoryInvoke: ReturnType<typeof invokeIn>
  ): Promise<BoundaryResult<readonly string[]>> {
    if (row.branch === null) {
      return {
        ok: true,
        value: ['worktree', 'add', '--detach', '--', row.path, `${snapshotRef}^`],
      };
    }
    const expectedTipRun = await invokeGitHookFree(repositoryInvoke, [
      'rev-parse',
      '--verify',
      `${snapshotRef}^`,
    ]);
    if (expectedTipRun.exitCode !== 0) {
      return gitCommandFailed(expectedTipRun);
    }
    const branchTipRun = await invokeGitHookFree(repositoryInvoke, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${row.branch}`,
    ]);
    if (branchTipRun.exitCode === 1) {
      return {
        ok: true,
        value: ['worktree', 'add', '-b', row.branch, '--', row.path, `${snapshotRef}^`],
      };
    }
    if (branchTipRun.exitCode !== 0) {
      return gitCommandFailed(branchTipRun);
    }
    const branchTip = branchTipRun.stdout.trim();
    const expectedTip = expectedTipRun.stdout.trim();
    if (branchTip !== expectedTip) {
      return gitRefused(
        'conflict',
        'worktree.branch-moved',
        `"${row.branch}" has moved since this worktree was archived (now ${branchTip.slice(0, 7)}, snapshot expects ${expectedTip.slice(0, 7)}) — rename or move the branch first.`
      );
    }
    return { ok: true, value: ['worktree', 'add', '--', row.path, row.branch] };
  }

  async function restoreUnserialized(params: {
    readonly worktreeId: string;
  }): Promise<BoundaryResult<WorktreeCreateResult>> {
    const row = await ledger.get(params.worktreeId);
    if (!row) {
      return gitRefused(
        'input',
        'worktree.not-found',
        `Managed worktree "${params.worktreeId}" is not in the ledger.`
      );
    }
    if (row.archivedAt === null || row.archiveSnapshotRef === null) {
      return gitRefused(
        'conflict',
        'worktree.not-archived',
        'That worktree is not archived — there is nothing to restore.'
      );
    }
    const snapshotRef = row.archiveSnapshotRef;
    const repositoryInvoke = invokeIn(row.repoCommonDir);
    const verifySnapshotRun = await invokeGitHookFree(repositoryInvoke, [
      'rev-parse',
      '--verify',
      `${snapshotRef}^{commit}`,
    ]);
    if (verifySnapshotRun.exitCode !== 0) {
      return gitRefused(
        'conflict',
        'worktree.snapshot-missing',
        `The archive snapshot "${snapshotRef}" no longer exists in this repository, so this worktree cannot be restored.`
      );
    }
    const verifyParentRun = await invokeGitHookFree(repositoryInvoke, [
      'rev-parse',
      '--verify',
      `${snapshotRef}^`,
    ]);
    if (verifyParentRun.exitCode === 128) {
      return gitRefused(
        'conflict',
        'worktree.nothing-to-restore',
        'This worktree was archived while missing on disk — there is nothing to restore. Create a new worktree instead.'
      );
    }
    if (verifyParentRun.exitCode !== 0) {
      return gitCommandFailed(verifyParentRun);
    }
    const targetAvailable = await assertRestoreTargetAvailable(row.path);
    if (!targetAvailable.ok) {
      return targetAvailable;
    }
    const addArgs = await resolveRestoreAddArgs(row, snapshotRef, repositoryInvoke);
    if (!addArgs.ok) {
      return addArgs;
    }
    await fsPromises.mkdir(path.dirname(row.path), { recursive: true });
    const addRun = await invokeGitHookFree(repositoryInvoke, addArgs.value);
    if (addRun.exitCode !== 0) {
      return gitCommandFailed(addRun);
    }
    const replayed = await replayArchiveSnapshot(row, snapshotRef);
    if (!replayed.ok) {
      return replayed;
    }
    return await recordRestoredWorktree(row, snapshotRef);
  }

  const idleArchive = { archive: archiveUnserialized, inspectArchiveRow, invokeIn, ledger };
  const operations = {
    async adopt(params: WorktreeAdoptParams): Promise<BoundaryResult<ManagedWorktreeRow>> {
      return await serialize(async () => {
        try {
          const adopted = await adoptWorktree(adoptDeps(), params);
          return adopted;
        } catch (error) {
          logger.error('worktree adopt failed', { error, path: params.path });
          return lifetime.faultResult(error);
        }
      });
    },
    /**
     * Snapshot, then remove. ORDER IS THE CONTRACT: the snapshot is captured
     * BEFORE the safety verdict is acted on and before `git worktree remove`
     * runs, so a forced archive of dirty work is always restorable. The ledger
     * row is marked archived only AFTER the removal succeeds — a failed
     * removal must never leave a row claiming a directory is gone.
     */
    async archive(params: WorktreeArchiveParams): Promise<BoundaryResult<WorktreeArchiveResult>> {
      return await serialize(async () => {
        try {
          return params.idleCap
            ? await archiveIdleWorktree(idleArchive, params.worktreeId, params.idleCap)
            : await archiveUnserialized(params);
        } catch (error) {
          logger.error('worktree archive failed', { error, worktreeId: params.worktreeId });
          return lifetime.faultResult(error);
        }
      });
    },
    async checkoutStatus(params: {
      readonly path: string;
    }): Promise<BoundaryResult<WorktreeCheckoutStatus>> {
      try {
        return await readCheckoutStatus(adoptDeps(), params);
      } catch (error) {
        logger.error('worktree checkout status failed', { error, path: params.path });
        return lifetime.faultResult(error);
      }
    },
    /** Create a managed worktree, record it, and run its setup. */
    async create(params: WorktreeCreateParams): Promise<BoundaryResult<WorktreeCreateResult>> {
      return await serialize(async () => {
        try {
          return await createUnserialized(params);
        } catch (error) {
          logger.error('worktree create failed', { error, name: params.name });
          return lifetime.faultResult(error);
        }
      });
    },
    /** Create a branch at the detached worktree's HEAD and check it out there [D2]. */
    async createBranchHere(params: {
      readonly branch: string;
      readonly worktreeId: string;
    }): Promise<BoundaryResult<ManagedWorktreeRow>> {
      return await serialize(async () => {
        try {
          const row = await ledger.get(params.worktreeId);
          if (!row || row.archivedAt !== null) {
            return notActive(params.worktreeId);
          }
          const invoke = invokeIn(row.path);
          const attachedBranchRun = await invokeGitHookFree(invoke, [
            'symbolic-ref',
            '--quiet',
            '--short',
            'HEAD',
          ]);
          if (attachedBranchRun.exitCode === 0) {
            return gitRefused(
              'conflict',
              'worktree.attached',
              `Managed worktree "${row.id}" is attached to branch "${attachedBranchRun.stdout.trim()}"; createBranchHere requires a detached worktree.`
            );
          }
          if (attachedBranchRun.exitCode !== 1) {
            return gitCommandFailed(attachedBranchRun);
          }
          const exists = await invoke([
            'show-ref',
            '--verify',
            '--hash',
            `refs/heads/${params.branch}`,
          ]);
          if (exists.exitCode === 0) {
            return gitRefused(
              'conflict',
              'git.branch-exists',
              `local branch "${params.branch}" already exists`
            );
          }
          const switchRun = await invokeGitHookFree(invoke, [
            'switch',
            '--no-guess',
            '-c',
            params.branch,
          ]);
          if (switchRun.exitCode !== 0) {
            return gitCommandFailed(switchRun);
          }
          return { ok: true, value: await ledger.updateBranch(row.id, params.branch) };
        } catch (error) {
          return lifetime.faultResult(error);
        }
      });
    },
    /** Resolve the create sheet preview from the same main-owned policy as create(). */
    async createContext(params: {
      readonly rootId: string;
    }): Promise<BoundaryResult<WorktreeCreateContext>> {
      try {
        const context = await resolveRepositoryContext(params.rootId);
        if (!context.ok) {
          return context;
        }
        const [settings, rows, inventory] = await Promise.all([
          deps.readSettings(),
          ledger.listActive(),
          deps.resolveInventory(),
        ]);
        const slug = repositorySlug(context.value.repositoryRoot, context.value.commonDir);
        const taken = new Set<string>();
        for (const row of rows) {
          if (row.repoCommonDir === context.value.commonDir) {
            taken.add(path.basename(row.path));
          }
        }
        for (const repository of inventory.repositories) {
          if (repository.identity.repositoryRoot !== context.value.repositoryRoot) {
            continue;
          }
          for (const worktree of repository.worktrees) {
            taken.add(worktree.name);
          }
        }
        return {
          ok: true,
          value: {
            managedParentPath: path.join(settings.managedDirectory, slug),
            repositorySetup: await resolveRepositorySetupContext(
              settings,
              context.value,
              deps.readRepositorySetupConsent
            ),
            suggestedName: generateWorktreeName(taken),
          },
        };
      } catch (error) {
        logger.error('worktree create context failed', { error, rootId: params.rootId });
        return lifetime.faultResult(error);
      }
    },
    async inspectArchive(params: {
      readonly worktreeId: string;
    }): Promise<BoundaryResult<WorktreeArchivePreview>> {
      try {
        const row = await ledger.get(params.worktreeId);
        if (!row || row.archivedAt !== null) {
          return notActive(params.worktreeId);
        }
        return await inspectWorktreeArchivePreviewForPath({
          inspectSafety: async () => await inspectArchiveRow(row),
          path: row.path,
        });
      } catch (error) {
        logger.error('worktree archive inspection failed', {
          error,
          worktreeId: params.worktreeId,
        });
        return lifetime.faultResult(error);
      }
    },
    /**
     * The ONE sanctioned picker-less grant besides recents (spec §6.2, widened
     * in the BST-1392 follow-up): a LIVE ledger row that is reachable per
     * adoption's rule — under the managed directory, or inside a granted
     * workspace root per a forced-fresh inventory. The shared
     * `isReachableCheckout` predicate in `worktree-adopt.ts` backs both this
     * and `assertReachable`, so the two cannot drift.
     */
    async isManagedWorktreePath(candidate: string): Promise<boolean> {
      return await isAuthorizedWorktreeMountPath(adoptDeps(), candidate);
    },
    async list(): Promise<BoundaryResult<readonly WorktreeListEntry[]>> {
      try {
        return await listUnserialized();
      } catch (error) {
        logger.error('worktree list failed', { error });
        return lifetime.faultResult(error);
      }
    },
    async listManagedPaths(): Promise<BoundaryResult<readonly ManagedWorktreePathEntry[]>> {
      try {
        const rows = await ledger.listActive();
        return {
          ok: true,
          value: rows.map((row) => ({ id: row.id, path: row.path })),
        };
      } catch (error) {
        logger.error('managed worktree path list failed', { error });
        return lifetime.faultResult(error);
      }
    },
    async reconcileFromShell(params: {
      readonly precedingWorktreePaths: ReadonlySet<string> | undefined;
      readonly repoCommonDir: string;
      readonly runId?: string;
      readonly threadId?: string;
    }): Promise<BoundaryResult<WorktreeShellReconcileResult>> {
      return await serialize(async () => {
        try {
          return await reconcileWorktreesFromShell(adoptDeps(), params);
        } catch (error) {
          // Spreading `params` directly would dump `precedingWorktreePaths` —
          // a `Set`, which loses its members through JSON-shaped logging
          // anyway — into the log line. Log its identity (present or not)
          // and size instead of its spread contents (BST-1392 review).
          logger.error('worktree shell reconcile failed', {
            error,
            precedingWorktreePathsCount: params.precedingWorktreePaths?.size ?? null,
            repoCommonDir: params.repoCommonDir,
            runId: params.runId ?? null,
            threadId: params.threadId ?? null,
          });
          return lifetime.faultResult(error);
        }
      });
    },
    async repositoryContextForRoot(rootId: string): Promise<BoundaryResult<RepositoryContext>> {
      return await resolveRepositoryContext(rootId);
    },
    /** Recreate an archived worktree and replay its durable archive snapshot. */
    async restore(params: {
      readonly worktreeId: string;
    }): Promise<BoundaryResult<WorktreeCreateResult>> {
      return await serialize(async () => {
        try {
          return await restoreUnserialized(params);
        } catch (error) {
          logger.error('worktree restore failed', { error, worktreeId: params.worktreeId });
          return lifetime.faultResult(error);
        }
      });
    },
  };
  return {
    adopt: lifetime.admit(operations.adopt),
    archive: lifetime.admit(operations.archive),
    checkoutStatus: lifetime.admit(operations.checkoutStatus),
    create: lifetime.admit(operations.create),
    createBranchHere: lifetime.admit(operations.createBranchHere),
    createContext: lifetime.admit(operations.createContext),
    inspectArchive: lifetime.admit(operations.inspectArchive),
    isManagedWorktreePath: (candidate: string): Promise<boolean> =>
      lifetime.track(() => operations.isManagedWorktreePath(candidate)),
    list: lifetime.admit(operations.list),
    listManagedPaths: lifetime.admit(operations.listManagedPaths),
    prepareClose: () => lifetime.prepareClose(),
    reconcileFromShell: lifetime.admit(operations.reconcileFromShell),
    repositoryContextForRoot: lifetime.admit(operations.repositoryContextForRoot),
    restore: lifetime.admit(operations.restore),
  };
}

export type WorktreeService = ReturnType<typeof createWorktreeService>;
