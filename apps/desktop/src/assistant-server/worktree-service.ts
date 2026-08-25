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
 * `GitResult<never>` (the `changes`/`git` domain convention).
 */
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type {
  GitInventory,
  GitResult,
  ManagedWorktreeRow,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeDescriptor,
  WorktreeListEntry,
  WorktreeSettings,
  WorktreeSetupOutcome,
} from '@brainstrike/types';
import type { GitCommandRunner } from './git-service';
import {
  describeFailure,
  GIT_DEFAULT_TIMEOUT_MS,
  invokeGitHookFree,
  toErrorMessage,
} from './git-service';
import { generateWorkspaceSnapshotId } from './snapshot-repository';
import { createWorktreeLedger, type WorktreeLedgerDatabase } from './worktree-ledger';
import {
  assertWorktreeTargetOutsideRoots,
  externalToolForPath,
  repositorySlug,
  resolveWorktreeTargetPath,
} from './worktree-paths';

const logger = createLogger('WorktreeService');

/** What `runSetup` (Layer 5) needs; stubbed to a `'none'` outcome until then. */
export interface WorktreeSetupInput {
  readonly settings: WorktreeSettings;
  readonly sourcePath: string;
  readonly worktree: ManagedWorktreeRow;
}

export interface WorktreeServiceDeps {
  readonly getDatabase: () => Promise<WorktreeLedgerDatabase>;
  readonly readSettings: () => Promise<WorktreeSettings>;
  /** The cached inventory snapshot — the same one `window.changes.inventory()` serves. */
  readonly resolveInventory: () => Promise<GitInventory>;
  readonly resolveRootCwd: (rootId: string) => Promise<GitResult<string>>;
  readonly resolveRootPaths: () => Promise<
    readonly { readonly id: string; readonly path: string }[]
  >;
  readonly run: GitCommandRunner;
  readonly runSetup: (input: WorktreeSetupInput) => Promise<WorktreeSetupOutcome>;
}

interface RepositoryContext {
  readonly commonDir: string;
  readonly cwd: string;
  readonly repositoryRoot: string;
}

/** FIFO async mutex: tasks run strictly one at a time, failures don't wedge it. */
function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

export function createWorktreeService(deps: WorktreeServiceDeps) {
  const ledger = createWorktreeLedger(deps.getDatabase);
  const serialize = createMutex();

  function invokeIn(cwd: string) {
    return (args: readonly string[], timeoutMs: number = GIT_DEFAULT_TIMEOUT_MS) =>
      deps.run({ args, cwd, timeoutMs });
  }

  async function resolveRepositoryContext(rootId: string): Promise<GitResult<RepositoryContext>> {
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
      return { error: describeFailure(commonDirRun), ok: false };
    }
    const topLevelRun = await invokeGitHookFree(invoke, ['rev-parse', '--show-toplevel']);
    if (topLevelRun.exitCode !== 0) {
      return { error: describeFailure(topLevelRun), ok: false };
    }
    // Realpath both: the inventory keys repositories on the realpath'd common
    // dir, and a ledger row keyed on a symlinked path would never join.
    const commonDir = await fsPromises.realpath(commonDirRun.stdout.trim());
    const repositoryRoot = await fsPromises.realpath(topLevelRun.stdout.trim());
    return { ok: true, value: { commonDir, cwd: cwd.value, repositoryRoot } };
  }

  async function assertBranchAvailable(cwd: string, branch: string): Promise<GitResult<null>> {
    const exists = await invokeGitHookFree(invokeIn(cwd), [
      'show-ref',
      '--verify',
      '--hash',
      `refs/heads/${branch}`,
    ]);
    if (exists.exitCode === 0) {
      return { error: `local branch "${branch}" already exists`, ok: false };
    }
    return { ok: true, value: null };
  }

  async function resolveCreateTarget(
    settings: WorktreeSettings,
    context: RepositoryContext,
    name: string
  ): Promise<GitResult<string>> {
    await fsPromises.mkdir(settings.managedDirectory, { recursive: true });
    const managedDirectory = await fsPromises.realpath(settings.managedDirectory);
    const slug = repositorySlug(context.repositoryRoot, context.commonDir);
    let target: string;
    try {
      target = resolveWorktreeTargetPath(managedDirectory, slug, name);
    } catch (error) {
      logger.warn('worktree create refused by path policy', { error, name });
      return { error: toErrorMessage(error), ok: false };
    }
    const roots = await deps.resolveRootPaths();
    const canonicalRootPaths = await Promise.all(
      roots.map((root) => fsPromises.realpath(root.path))
    );
    try {
      assertWorktreeTargetOutsideRoots(target, canonicalRootPaths);
    } catch (error) {
      logger.warn('worktree create refused by path policy', { error, name });
      return { error: toErrorMessage(error), ok: false };
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
        }
      } catch (cleanupError) {
        logger.error('worktree ledger insert cleanup threw', { cleanupError, target });
      }
      throw insertError;
    }
  }

  async function createUnserialized(
    params: WorktreeCreateParams
  ): Promise<GitResult<WorktreeCreateResult>> {
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
      return { error: `A worktree at "${target}" already exists.`, ok: false };
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
      return { error: describeFailure(addRun), ok: false };
    }
    const row = await insertCreatedWorktree(context.value, params, branchName, target);
    // Setup failure is VISIBLE and does NOT block using the worktree (§6.3):
    // the outcome rides back on the result and is persisted on the row.
    const setup = await deps.runSetup({
      settings,
      sourcePath: context.value.repositoryRoot,
      worktree: row,
    });
    const worktree = await ledger.recordSetup(row.id, setup);
    return { ok: true, value: { setup, worktree } };
  }

  /**
   * Inventory ⋈ ledger (spec §5.3). Every worktree the inventory reports is
   * listed, plus every LIVE ledger row that is not on disk — the latter as
   * `provenance: 'agent-reported'`, `trust: 'unvalidated'`, reason "missing on
   * disk". Nothing is dropped.
   */
  async function listUnserialized(): Promise<GitResult<readonly WorktreeListEntry[]>> {
    const [inventory, rows, roots] = await Promise.all([
      deps.resolveInventory(),
      ledger.listActive(),
      deps.resolveRootPaths(),
    ]);
    const rowsByPath = new Map(rows.map((row) => [row.path, row]));
    const rootIdByPath = new Map(roots.map((root) => [root.path, root.id]));
    const seenPaths = new Set<string>();
    const entries: WorktreeListEntry[] = [];

    for (const repository of inventory.repositories) {
      for (const descriptor of repository.worktrees) {
        seenPaths.add(descriptor.path);
        const row = rowsByPath.get(descriptor.path) ?? null;
        entries.push(
          inventoryListEntry(descriptor, row, repository.identity.repositoryRoot, rootIdByPath)
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

  return {
    /** Create a managed worktree, record it, and run its setup. */
    async create(params: WorktreeCreateParams): Promise<GitResult<WorktreeCreateResult>> {
      return await serialize(async () => {
        try {
          return await createUnserialized(params);
        } catch (error) {
          logger.error('worktree create failed', { error, name: params.name });
          return { error: toErrorMessage(error), ok: false };
        }
      });
    },
    /**
     * The ONE sanctioned picker-less grant besides recents (spec §6.2): a path
     * is authorized only when it is a LIVE ledger row whose realpath sits under
     * the realpath'd managed directory. The app created it, so the app is the
     * grantor — but only for paths it actually created.
     */
    async isManagedWorktreePath(candidate: string): Promise<boolean> {
      try {
        const settings = await deps.readSettings();
        const [realCandidate, realManaged] = await Promise.all([
          fsPromises.realpath(candidate),
          fsPromises.realpath(settings.managedDirectory),
        ]);
        const within =
          realCandidate === realManaged || realCandidate.startsWith(`${realManaged}${path.sep}`);
        if (!within) {
          return false;
        }
        const row = await ledger.getByPath(realCandidate);
        return row !== null && row.archivedAt === null;
      } catch (error) {
        // A path that cannot be realpath'd is not a worktree this app created.
        logger.debug('managed worktree authorization check failed', { candidate, error });
        return false;
      }
    },
    async list(): Promise<GitResult<readonly WorktreeListEntry[]>> {
      try {
        return await listUnserialized();
      } catch (error) {
        logger.error('worktree list failed', { error });
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}

export type WorktreeService = ReturnType<typeof createWorktreeService>;

interface UsabilityGate {
  readonly disabledReason: string | null;
  readonly remedy: 'grant-access' | null;
  readonly usable: boolean;
}

function inventoryListEntry(
  descriptor: WorktreeDescriptor,
  row: ManagedWorktreeRow | null,
  repositoryRoot: string,
  rootIdByPath: ReadonlyMap<string, string>
): WorktreeListEntry {
  const gate = resolveUsability(descriptor, row);
  return {
    branch: descriptor.branch,
    containment: descriptor.containment,
    detached: descriptor.detached,
    disabledReason: gate.disabledReason,
    externalTool: externalToolForPath(descriptor.path),
    id: row?.id ?? null,
    lockedReason: descriptor.lockedReason,
    managed: row !== null,
    name: descriptor.name,
    path: descriptor.path,
    // The FIRST producer of anything but 'scanned' (see
    // docs/agents/changeset-diff.md): a scanned worktree that also has a
    // ledger row is known from BOTH sides.
    provenance: row ? 'both' : 'scanned',
    remedy: gate.remedy,
    repositoryRoot,
    rootId:
      rootIdByPath.get(descriptor.path) ??
      (descriptor.containment === 'outside-roots' ? null : (descriptor.containment[0] ?? null)),
    trust: descriptor.trust,
    trustReason: descriptor.trustReason,
    usable: gate.usable,
  };
}

function ghostListEntry(
  row: ManagedWorktreeRow,
  rootIdByPath: ReadonlyMap<string, string>
): WorktreeListEntry {
  return {
    branch: row.branch,
    containment: 'outside-roots',
    detached: row.branch === null,
    disabledReason: 'Worktree is missing on disk — restore it or archive it.',
    externalTool: externalToolForPath(row.path),
    id: row.id,
    lockedReason: null,
    managed: true,
    name: path.basename(row.path),
    path: row.path,
    provenance: 'agent-reported',
    remedy: null,
    repositoryRoot: repositoryRootFromCommonDir(row.repoCommonDir),
    rootId: rootIdByPath.get(row.path) ?? null,
    trust: 'unvalidated',
    trustReason: 'missing on disk',
    usable: false,
  };
}

/**
 * Whether this worktree can be USED as a thread's checkout, and if not, why —
 * ordered most-specific-cause first. NO SILENT HIDING and NO SILENT DISABLE:
 * an unusable row is still returned, still carries its reason, and names the
 * remedy when one exists.
 *
 * `outside-roots` is NOT terminal: a managed worktree is authorized by the
 * ledger, and any other outside-roots worktree becomes usable once the user
 * grants it through the OS picker — which is what `remedy: 'grant-access'`
 * tells the UI to offer (the picker-only ruling in
 * `changes-context-actions.ts` still holds: no caller-supplied path).
 */
function resolveUsability(
  descriptor: WorktreeDescriptor,
  row: ManagedWorktreeRow | null
): UsabilityGate {
  if (descriptor.prunableReason !== null) {
    return {
      disabledReason: `Worktree is prunable: ${descriptor.prunableReason}`,
      remedy: null,
      usable: false,
    };
  }
  if (descriptor.trust === 'unvalidated') {
    return {
      disabledReason:
        descriptor.trustReason ?? 'This worktree could not be verified against its own .git.',
      remedy: null,
      usable: false,
    };
  }
  if (descriptor.lockedReason !== null) {
    return { disabledReason: `Locked: ${descriptor.lockedReason}`, remedy: null, usable: false };
  }
  if (descriptor.containment !== 'outside-roots' || row !== null) {
    return { disabledReason: null, remedy: null, usable: true };
  }
  return {
    disabledReason:
      "This worktree isn't inside any workspace folder yet — grant access to use it here.",
    remedy: 'grant-access',
    usable: false,
  };
}

/** Non-bare repositories use `<main-worktree>/.git`; bare common dirs stay as-is. */
function repositoryRootFromCommonDir(repoCommonDir: string): string {
  return path.basename(repoCommonDir) === '.git' ? path.dirname(repoCommonDir) : repoCommonDir;
}
