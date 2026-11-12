/**
 * The git cluster an agent host owns (ADR-0029 stage 2): the ONE
 * `GitInventoryService` and `WorktreeService` over the host's own state store
 * (worktree ledger and settings), and on the desktop host the shadow-git
 * `SnapshotService` beside them. Changes, the branch switcher and worktrees reach
 * them as host methods; the host's own runs use them for worktree tools, shell
 * correlation, turn snapshots and rewinds.
 *
 * The git-metadata watchers own their native subscriptions directly
 * (`watchGitCommonDirNatively`). Each invalidation reaches every subscribed
 * window as `changes-invalidated`, so git-scope changeset views and the
 * inventory refetch without polling (BST-1161). Each event carries a monotonic
 * generation; a window drops stale or duplicate deliveries.
 */
import type {
  HostGitWorkspace,
  HostIdleWorktreeArchive,
  HostPlatform,
  HostRewindFiles,
  HostThreadReads,
  HostTurnSnapshot,
  HostTurnSnapshotRoot,
} from '@brainstrike/agent-host';
import type { GitWorkspaceEvent } from '@brainstrike/agent-host/protocol';
import type { createLogger } from '@brainstrike/logging';
import type { StateStore } from '@brainstrike/state-store';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { resolveRootCwd, type WorkspaceRootResolver } from '../workspace-root-cwd.ts';
import { createChangesMethods } from './changes-methods.ts';
import { createHostThreadTurns } from './changeset-host-turns.ts';
import { hostCheckoutIsolation } from './checkout-isolation.ts';
import { createGitInventoryService, type GitInventoryService } from './git-inventory-service.ts';
import { watchGitCommonDirNatively } from './git-inventory-watcher.ts';
import { createGitMethods, execFileGitRunner } from './git-methods.ts';
import type { GitCommandRunner } from './git-service.ts';
import { createHostRewindFiles } from './host-rewind-files.ts';
import { startSnapshotStartupMaintenance } from './host-snapshot-maintenance.ts';
import { createTrustedFolderCheck, guardRepositoryFilters } from './repo-filter-guard.ts';
import { execFileSnapshotGitRunner } from './snapshot-git.ts';
import { FAILED_SNAPSHOT_CAPTURE_OID } from './snapshot-repository.ts';
import { createSnapshotService } from './snapshot-service.ts';
import { captureRootSnapshot } from './snapshot-turn-boundaries.ts';
import { hasHostRunInWorktree } from './worktree-host-activity.ts';
import { createIdleWorktreeCap } from './worktree-idle-cap.ts';
import { createWorktreeLedger } from './worktree-ledger.ts';
import { isPathWithin } from './worktree-paths.ts';
import {
  createWorktreeService,
  type WorktreeService,
  type WorktreeServiceDeps,
} from './worktree-service.ts';
import { readWorktreeSettings, writeWorktreeSettings } from './worktree-settings.ts';
import { runWorktreeSetup } from './worktree-setup.ts';
import { readWorktreeSetupConsent } from './worktree-setup-consent.ts';
import type { HostWorktreeServices } from './worktree-tool-dependencies.ts';
import { createWorktreesMethods } from './worktrees-methods.ts';

type GitWorkspaceLogger = Pick<
  ReturnType<typeof createLogger>,
  'debug' | 'error' | 'info' | 'warn'
>;

export interface WorktreeWorkspaceOptions {
  /** Told of each worktree the service creates (ADR-0034 decision 7: the idle-worktree cap). */
  readonly afterCreate?: WorktreeServiceDeps['afterCreate'];
  readonly logger: GitWorkspaceLogger;
  /** The managed worktree directory when the user saved none (`~/.brainstrike/worktrees`). */
  readonly managedWorktreeDirectory: string;
  /** Repository changes on disk, for the clients subscribed to them. */
  readonly onInvalidate?: (event: {
    readonly gitCommonDir: string;
    readonly repositoryRoot: string | null;
  }) => void;
  /** Called once, when the first inventory read starts the inventory. */
  readonly onStart?: () => void;
  /** The workspace roots this host serves: the catalog's, or a standalone host's launch roots. */
  readonly roots: WorkspaceRootResolver;
  /** The host's state store: the worktree ledger, settings and setup script consent. */
  readonly store: StateStore;
}

export interface WorktreeWorkspace {
  /** Core's thread reads: which runs are live, and their committed turns. */
  attachThreadReads(reads: HostThreadReads): void;
  /** Retires the worktree service, then the inventory it reads. */
  close(): Promise<void>;
  /** The inventory, started on first use: its watchers arm with it. */
  inventory(): GitInventoryService;
  /** A repository's managed worktrees as the ledger records them, archived ones too. */
  listRepositoryWorktrees(repoCommonDir: string): Promise<readonly ManagedWorktreeRow[]>;
  readonly loadRoots: () => Promise<{ id: string; path: string }[]>;
  readonly readSettings: () => ReturnType<typeof readWorktreeSettings>;
  /**
   * Git as the host runs it in the person's folders: a repository's own filter
   * commands stay off until its folder is trusted (BST-2454).
   */
  readonly run: GitCommandRunner;
  /** Thread reads once attached; throws before the host has opened its threads. */
  threadReads(): HostThreadReads;
  /** The worktree services the host's own tools borrow per run. */
  readonly tools: HostWorktreeServices;
  readonly worktrees: WorktreeService;
}

/**
 * The worktree half every agent host composes: the ledger-backed worktree
 * service over one git inventory. Nothing starts until the first inventory read.
 */
export function createWorktreeWorkspace(options: WorktreeWorkspaceOptions): WorktreeWorkspace {
  const { logger, roots, store } = options;
  let reads: HostThreadReads | undefined;
  const threadReads = (): HostThreadReads => {
    if (!reads) {
      throw new Error('The agent host has not opened its threads yet');
    }
    return reads;
  };
  const loadRoots = async (): Promise<{ id: string; path: string }[]> =>
    (await roots.listRoots()).map((root) => ({ id: root.rootId, path: root.path }));
  const run = guardRepositoryFilters({
    isTrusted: createTrustedFolderCheck(store, roots),
    run: execFileGitRunner,
  });
  const gitInventoryService = createGitInventoryService({
    loadRoots,
    ...(options.onInvalidate ? { onInvalidate: options.onInvalidate } : {}),
    run,
    // `stop()` resolves only after every subscribe and unsubscribe it started
    // has settled (BST-2244).
    watchDirectory: watchGitCommonDirNatively,
  });
  let started = false;
  let closing: Promise<void> | undefined;
  const inventory = (): GitInventoryService => {
    if (!(started || closing)) {
      started = true;
      gitInventoryService.start();
      options.onStart?.();
    }
    return gitInventoryService;
  };
  const readSettings = () => readWorktreeSettings(store, options.managedWorktreeDirectory);
  const hasRunningThread = (worktreeId: string): Promise<boolean> =>
    hasHostRunInWorktree(
      {
        readLedger: () => threadReads().readLedger(),
        readThread: (threadId) => threadReads().read(threadId, 0),
      },
      worktreeId
    );
  // The service writes the ledger; this reads it through the same decoder.
  const ledger = createWorktreeLedger(async () => store, hasRunningThread);
  const worktrees = createWorktreeService({
    ...(options.afterCreate ? { afterCreate: options.afterCreate } : {}),
    getWorktreeStore: async () => store,
    hasRunningThread,
    readRepositorySetupConsent: (repositoryId) => readWorktreeSetupConsent(store, repositoryId),
    readSettings,
    resolveInventory: async (request) => {
      // `maxAgeMs: 0` guarantees a build that started after this call, which
      // a shell reconcile needs to see the worktree its command just created.
      const snapshot = await inventory().getSnapshot(
        request?.forceFresh ? { maxAgeMs: 0 } : undefined
      );
      return { errors: snapshot.errors, repositories: snapshot.repositories };
    },
    resolveRootCwd: (rootId) => resolveRootCwd(roots, rootId, 'worktrees', logger),
    resolveRootPaths: loadRoots,
    run,
    runSetup: (setupInput) => runWorktreeSetup(setupInput),
  });
  return {
    attachThreadReads: (attached) => {
      reads = attached;
    },
    close: () =>
      (closing ??= (async () => {
        // A worktree operation in flight still reads the inventory it started with.
        const failures = [
          ...(await Promise.allSettled([worktrees.prepareClose()])),
          ...(await Promise.allSettled([gitInventoryService.stop()])),
        ].flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (failures.length > 0) {
          throw new AggregateError(failures, 'The workspace worktree services failed to close');
        }
      })()),
    inventory,
    listRepositoryWorktrees: (repoCommonDir) => ledger.listForRepository(repoCommonDir),
    loadRoots,
    readSettings,
    run,
    threadReads,
    tools: { resolveWorktreeService: () => worktrees },
    worktrees,
  };
}

export interface GitWorkspaceOptions
  extends Omit<WorktreeWorkspaceOptions, 'onInvalidate' | 'onStart'> {
  /** Main mounts a worktree an agent created as a workspace folder and shows it. */
  readonly openWorktreeFolder: (
    path: string
  ) => Promise<{ displayName: string; path: string; rootId: string }>;
  /** The shadow-git repositories' directory; the composing host's reset must cover it. */
  readonly snapshotsBaseDir: string;
}

export interface GitWorkspace {
  /** Core's thread reads: which runs are live, and their committed turns. */
  attachThreadReads(reads: HostThreadReads): void;
  /** One turn boundary's snapshot of each root, under the host thread's own ref. */
  captureTurnBoundary(request: {
    readonly boundary: 'turn-start' | 'turn-end';
    readonly roots: readonly HostTurnSnapshotRoot[];
    readonly runId: string;
    readonly threadId: string;
  }): Promise<readonly HostTurnSnapshot[]>;
  /** ADR-0034 Automatic isolation: a checkout's uncommitted paths, and a worktree of it for a thread. */
  readonly checkoutIsolation: HostPlatform['checkoutIsolation'];
  /** Retires every service while the state store and git remain available. */
  close(): Promise<void>;
  /** ADR-0034 decision 7: the idle worktrees the cap archives, for Core to tell their thread. */
  readonly idleWorktreeArchives: NonNullable<HostPlatform['idleWorktreeArchives']>;
  readonly rewindFiles: HostRewindFiles;
  readonly service: HostGitWorkspace;
  /** The worktree services the host's own tools borrow per run. */
  readonly tools: HostWorktreeServices;
}

/**
 * The desktop host's whole git cluster: the worktree half, the shadow-git
 * snapshots with their startup maintenance, and the git, changes and
 * worktrees methods its private client calls.
 */
export function createGitWorkspace(options: GitWorkspaceOptions): GitWorkspace {
  const { logger, roots, store } = options;
  const listeners = new Set<(event: GitWorkspaceEvent) => void>();
  let changesGeneration = 0;
  let attached: HostThreadReads | undefined;
  let snapshotMaintenance: { stop(): Promise<void> } | undefined;
  let closing: Promise<void> | undefined;
  // Nothing here runs before the host reports ready: the git-metadata watchers
  // and the snapshot startup GC start on the first window subscription or the
  // first inventory read, both of which reach a host that is already serving.
  let started = false;
  // ADR-0034 decision 7: after a creation for a thread, its repository's oldest idle worktrees
  // beyond the cap are archived and Core tells that thread.
  const archiveListeners = new Set<(archive: HostIdleWorktreeArchive) => void>();
  const idleCap = createIdleWorktreeCap({
    archive: (params) => workspace.worktrees.archive(params),
    listRepository: (repoCommonDir) => workspace.listRepositoryWorktrees(repoCommonDir),
    publish: (archive) => {
      if (archiveListeners.size === 0) {
        logger.error('Idle worktrees were archived with no thread listening to be told', {
          threadId: archive.threadId,
          worktreeIds: archive.worktrees.map(({ worktreeId }) => worktreeId),
        });
      }
      for (const listener of [...archiveListeners]) {
        listener(archive);
      }
    },
    readRoots: async () => (await store.workspaceRoots({ operation: 'list' })).roots,
    readThreads: async () =>
      (await workspace.threadReads().listThreads()).map(({ binding, latestRun, threadId }) => ({
        binding,
        hasRun: latestRun !== undefined,
        threadId,
      })),
  });
  const workspace = createWorktreeWorkspace({
    afterCreate: (worktree, params) => {
      void idleCap.afterCreate(worktree, params);
    },
    logger,
    managedWorktreeDirectory: options.managedWorktreeDirectory,
    // The refs watcher moving `refs/remotes/<remote>/<branch>` is the "a push
    // happened" signal: windows refetch.
    onInvalidate: (event) => {
      changesGeneration += 1;
      const published: GitWorkspaceEvent = {
        event: {
          generation: changesGeneration,
          gitCommonDir: event.gitCommonDir,
          repositoryRoot: event.repositoryRoot,
        },
        type: 'changes-invalidated',
      };
      for (const listener of [...listeners]) {
        listener(published);
      }
    },
    onStart: () => {
      started = true;
      startMaintenance();
    },
    roots,
    store,
  });
  const { worktrees: worktreeService, readSettings, loadRoots } = workspace;
  const snapshotsBaseDir = options.snapshotsBaseDir;
  const snapshotService = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir,
  });
  const startMaintenance = (): void => {
    if (!(started && attached) || snapshotMaintenance) {
      return;
    }
    const reads = attached;
    // Host threads record their turn snapshots in Core's log; the startup GC
    // keeps their refs while Core lists the thread.
    snapshotMaintenance = startSnapshotStartupMaintenance({
      logger,
      readHostThreadIds: async () =>
        new Set((await reads.readLedger()).threads.map(({ threadId }) => threadId)),
      readHostThreadRows: (threadId) => reads.read(threadId, 0),
      snapshotService,
      snapshotsBaseDir,
      workspaceRoots: store,
    });
  };
  const inventory = (): GitInventoryService => workspace.inventory();

  const git = createGitMethods({ resolver: roots, run: workspace.run });
  const changes = createChangesMethods({
    // BST-1977: host threads' agent-run changesets resolve from Core's log.
    hostThreadTurns: createHostThreadTurns({
      listThreads: async () =>
        (await workspace.threadReads().listThreads()).map(({ latestRun, threadId }) => ({
          running: latestRun?.status === 'running',
          threadId,
        })),
      readRows: (threadId, fromSeq) => workspace.threadReads().read(threadId, fromSeq),
    }),
    resolveInventoryService: inventory,
    resolver: roots,
    resolveSnapshotService: () => snapshotService,
    run: workspace.run,
  });
  const worktrees = createWorktreesMethods({
    listRepositoryWorktrees: (repoCommonDir) => workspace.listRepositoryWorktrees(repoCommonDir),
    readSettings,
    resolveService: () => worktreeService,
    setupConsentStore: store,
    // BST-1342 containment applies at save time, so the user learns at once
    // rather than when a later create targets the saved path.
    writeSettings: (next) =>
      writeWorktreeSettings(store, options.managedWorktreeDirectory, next, async () =>
        (await loadRoots()).map((root) => root.path)
      ),
  });
  const tools: HostWorktreeServices = {
    ...workspace.tools,
    openWorktreeFolder: options.openWorktreeFolder,
  };
  const service: HostGitWorkspace = {
    'changes/apply': (request) => changes.apply(request),
    'changes/commits': ({ rootId, worktreePath }) => changes.commits(rootId, worktreePath),
    'changes/file-diff': ({ changeset, path: filePath, rootId }) =>
      changes.fileDiff(rootId, changeset, filePath),
    'changes/inventory': (request) => changes.inventory(request),
    'changes/resolve-view': ({ changeset, rootId }) => changes.resolveView(rootId, changeset),
    'git/commit': ({ rootId, ...request }) => git.commit(rootId, request),
    'git/create-branch': ({ rootId, ...request }) => git.createBranch(rootId, request),
    'git/fetch': ({ rootId, ...request }) => git.fetch(rootId, request),
    'git/push': ({ rootId, ...request }) => git.push(rootId, request),
    'git/repository': ({ rootId }) => git.repository(rootId),
    'git/status': ({ rootId }) => git.status(rootId),
    'git/switch-branch': ({ rootId, ...request }) => git.switchBranch(rootId, request),
    subscribe: (listener) => {
      listeners.add(listener);
      inventory();
      return () => {
        listeners.delete(listener);
      };
    },
    'worktrees/adopt': (request) => worktrees.adopt(request),
    'worktrees/archive': (request) => worktrees.archive(request),
    'worktrees/checkout-status': (request) => worktrees.checkoutStatus(request),
    // Main's root registration: a managed worktree mounts only with its ledger row.
    'worktrees/classify-path': async ({ path: candidate }) => {
      if (await worktreeService.isManagedWorktreePath(candidate)) {
        return { classification: 'authorized' };
      }
      const settings = await readSettings();
      return {
        classification: isPathWithin(candidate, settings.managedDirectory)
          ? 'managed-but-unauthorized'
          : 'unmanaged',
      };
    },
    'worktrees/create': (request) => worktrees.create(request),
    'worktrees/create-branch-here': (request) => worktrees.createBranchHere(request),
    'worktrees/create-context': (request) => worktrees.createContext(request),
    'worktrees/inspect-archive': (request) => worktrees.inspectArchive(request),
    'worktrees/list': () => worktrees.list(),
    'worktrees/list-archived': (request) => worktrees.listArchived(request),
    'worktrees/managed-paths': () => worktrees.listManagedPaths(),
    'worktrees/restore': (request) => worktrees.restore(request),
    'worktrees/settings/read': () => worktrees.getSettings(),
    'worktrees/settings/write': (request) => worktrees.setSettings(request),
    'worktrees/setup-consent/decide': (request) => worktrees.decideSetupConsent(request),
    'worktrees/setup-consent/list': () => worktrees.listSetupConsent(),
    'worktrees/setup-consent/revoke': (request) => worktrees.revokeSetupConsent(request),
  };
  return {
    attachThreadReads: (reads) => {
      attached = reads;
      workspace.attachThreadReads(reads);
      startMaintenance();
    },
    // Roots are captured one at a time; a root that fails records the null object ID.
    captureTurnBoundary: async ({ boundary, roots: turnRoots, runId, threadId }) => {
      const captured: HostTurnSnapshot[] = [];
      for (const { rootId, rootPath } of turnRoots) {
        const outcome = await captureRootSnapshot(snapshotService, boundary, threadId, runId, {
          path: rootPath,
          rootId,
        });
        captured.push({
          commitOid: outcome.kind === 'captured' ? outcome.commitOid : FAILED_SNAPSHOT_CAPTURE_OID,
          rootId,
          rootPath: outcome.rootPath,
        });
      }
      return captured;
    },
    checkoutIsolation: hostCheckoutIsolation({
      repository: (rootId) => git.repository(rootId),
      services: tools,
      status: (rootId) => git.status(rootId),
    }),
    close: () =>
      (closing ??= (async () => {
        listeners.clear();
        // The cap's archive in flight finishes on the worktree service before that retires.
        await idleCap.close();
        // Each owner retires in its own slot, so one failure never leaves another running.
        const failures = (
          await Promise.allSettled([snapshotMaintenance?.stop(), workspace.close()])
        ).flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (failures.length > 0) {
          throw new AggregateError(failures, 'The workspace git services failed to close');
        }
      })()),
    idleWorktreeArchives: {
      settle: () => idleCap.close(),
      subscribe: (listener) => {
        archiveListeners.add(listener);
        return () => {
          archiveListeners.delete(listener);
        };
      },
    },
    rewindFiles: createHostRewindFiles({
      resolveWorkspaceRoot: async (rootId) => {
        const root = (await loadRoots()).find((candidate) => candidate.id === rootId);
        if (!root) {
          throw new Error('The workspace root is no longer mounted');
        }
        return root.path;
      },
      snapshots: () => snapshotService,
    }),
    service,
    tools,
  };
}
