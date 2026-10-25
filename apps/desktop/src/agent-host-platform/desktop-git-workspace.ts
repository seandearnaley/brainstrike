/**
 * The desktop's git cluster, owned by the agent host (ADR-0029 stage 2): the
 * ONE `GitInventoryService`, `ForgeService`, `WorktreeService` and shadow-git
 * `SnapshotService`, over the host's own state store (the workspace catalog,
 * worktree ledger, forge cache and worktree settings). The git panel, Changes,
 * forge awareness and worktrees reach them as host methods; the host's own runs
 * use them for worktree tools, shell correlation, turn snapshots and rewinds.
 *
 * The git-metadata watchers own their native subscriptions directly
 * (`watchGitCommonDirNatively`). Each invalidation reaches every subscribed
 * window as `changes-invalidated`, so git-scope changeset views and the
 * inventory refetch without polling (BST-1161), and lets the forge service
 * refresh the repositories it already tracks. Each event carries a monotonic
 * generation; a window drops stale or duplicate deliveries.
 */
import path from 'node:path';
import type {
  HostGitWorkspace,
  HostRewindFiles,
  HostThreadReads,
  HostTurnSnapshot,
  HostTurnSnapshotRoot,
} from '@brainstrike/agent-host';
import type { GitWorkspaceEvent } from '@brainstrike/agent-host/protocol';
import type { createLogger } from '@brainstrike/logging';
import type { StateStore } from '@brainstrike/state-store';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { createHostThreadTurns } from '../assistant-server/changeset-host-turns';
import { execFileGhRunner } from '../assistant-server/forge-gh-client';
import { createForgeService } from '../assistant-server/forge-service';
import { createGitInventoryService } from '../assistant-server/git-inventory-service';
import { watchGitCommonDirNatively } from '../assistant-server/git-inventory-watcher';
import { execFileSnapshotGitRunner } from '../assistant-server/snapshot-git';
import { FAILED_SNAPSHOT_CAPTURE_OID } from '../assistant-server/snapshot-repository';
import { createSnapshotService } from '../assistant-server/snapshot-service';
import { captureRootSnapshot } from '../assistant-server/snapshot-turn-boundaries';
import { loadWorkspaceRootsFromCatalog } from '../assistant-server/workspace-roots';
import { hasHostRunInWorktree } from '../assistant-server/worktree-host-activity';
import { createWorktreeLedger } from '../assistant-server/worktree-ledger';
import { isPathWithin } from '../assistant-server/worktree-paths';
import { createWorktreeService } from '../assistant-server/worktree-service';
import { readWorktreeSettings, writeWorktreeSettings } from '../assistant-server/worktree-settings';
import { runWorktreeSetup } from '../assistant-server/worktree-setup';
import type { DesktopWorktreeServices } from '../assistant-server/worktree-tool-dependencies';
import { createChangesIpcHandlers } from '../changes-ipc-handlers';
import { createForgeIpcHandlers, createForgeRepositoryResolver } from '../forge-ipc-handlers';
import {
  createGitIpcHandlers,
  createWorkspaceRootResolver,
  execFileGitRunner,
} from '../git-ipc-handlers';
import { resolveRootCwd } from '../workspace-root-cwd';
import { createWorktreesIpcHandlers } from '../worktrees-ipc-handlers';
import { createHostRewindFiles } from './host-rewind-files';
import { startSnapshotStartupMaintenance } from './host-snapshot-maintenance';

export interface DesktopGitWorkspaceOptions {
  readonly homePath: string;
  readonly logger: Pick<ReturnType<typeof createLogger>, 'debug' | 'error' | 'info' | 'warn'>;
  /** Main mounts a worktree an agent created as a workspace folder and shows it. */
  readonly openWorktreeFolder: (
    path: string
  ) => Promise<{ displayName: string; path: string; rootId: string }>;
  /** Main's native index rescans a root a rewind restored. */
  readonly refreshWorkspaceIndex: (rootId: string) => Promise<void>;
  /** The host's state store: catalog, worktree ledger, forge cache and settings. */
  readonly store: StateStore;
  readonly userDataDir: string;
}

export interface DesktopGitWorkspace {
  /** Core's thread reads: which runs are live, and their committed turns. */
  attachThreadReads(reads: HostThreadReads): void;
  /** One turn boundary's snapshot of each root, under the host thread's own ref. */
  captureTurnBoundary(request: {
    readonly boundary: 'turn-start' | 'turn-end';
    readonly roots: readonly HostTurnSnapshotRoot[];
    readonly runId: string;
    readonly threadId: string;
  }): Promise<readonly HostTurnSnapshot[]>;
  /** Retires every service while the state store and git remain available. */
  close(): Promise<void>;
  /** A managed worktree's ledger row, which authorizes a run's binding to it. */
  readWorktree(id: string): Promise<ManagedWorktreeRow | null>;
  readonly rewindFiles: HostRewindFiles;
  readonly service: HostGitWorkspace;
  /** The worktree and forge services the host's own tools borrow per run. */
  readonly tools: DesktopWorktreeServices;
}

export function createDesktopGitWorkspace(
  options: DesktopGitWorkspaceOptions
): DesktopGitWorkspace {
  const { homePath, logger, store } = options;
  const listeners = new Set<(event: GitWorkspaceEvent) => void>();
  const publish = (event: GitWorkspaceEvent): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  let reads: HostThreadReads | undefined;
  const threadReads = (): HostThreadReads => {
    if (!reads) {
      throw new Error('The agent host has not opened its threads yet');
    }
    return reads;
  };
  const hasRunningThread = (worktreeId: string): Promise<boolean> =>
    hasHostRunInWorktree(
      {
        readLedger: async () => threadReads().readLedger(),
        readThread: (threadId) => threadReads().read(threadId, 0),
      },
      worktreeId
    );
  const ledger = createWorktreeLedger(async () => store, hasRunningThread);
  const loadRoots = async (): Promise<{ id: string; path: string }[]> =>
    (await loadWorkspaceRootsFromCatalog(store)).map((root) => ({
      id: root.rootId,
      path: root.path,
    }));
  const resolver = createWorkspaceRootResolver(store);

  let changesGeneration = 0;
  let forgeGeneration = 0;
  // Kept as its own binding so the git-metadata watcher's invalidation can also
  // clear this resolver's per-rootId cache on the SAME commonDir signal that
  // drives `forgeService.onRepositoryInvalidated` (BST-1391).
  const forgeRepositoryResolver = createForgeRepositoryResolver(resolver);
  const forgeService = createForgeService({
    getForgeCache: async () => store,
    onPrUpdated: (event) => {
      forgeGeneration += 1;
      publish({ event: { ...event, generation: forgeGeneration }, type: 'forge-pr-updated' });
    },
    resolveRepository: forgeRepositoryResolver,
    run: execFileGhRunner,
  });
  const gitInventoryService = createGitInventoryService({
    loadRoots,
    // The refs watcher moving `refs/remotes/<remote>/<branch>` is the "a push
    // happened" signal: windows refetch, and forge refreshes what it tracks.
    onInvalidate: (event) => {
      changesGeneration += 1;
      publish({
        event: {
          generation: changesGeneration,
          gitCommonDir: event.gitCommonDir,
          repositoryRoot: event.repositoryRoot,
        },
        type: 'changes-invalidated',
      });
      forgeService.onRepositoryInvalidated(event.gitCommonDir);
      forgeRepositoryResolver.invalidateResolverCache(event.gitCommonDir);
    },
    run: execFileGitRunner,
    // `stop()` resolves only after every subscribe and unsubscribe it started
    // has settled (BST-2244).
    watchDirectory: watchGitCommonDirNatively,
  });
  const readSettings = () => readWorktreeSettings(store, homePath);
  const worktreeService = createWorktreeService({
    getWorktreeStore: async () => store,
    hasRunningThread,
    readSettings,
    resolveInventory: async (request) => {
      // `maxAgeMs: 0` guarantees a build that started after this call, which
      // a shell reconcile needs to see the worktree its command just created.
      const snapshot = await inventory().getSnapshot(
        request?.forceFresh ? { maxAgeMs: 0 } : undefined
      );
      return { errors: snapshot.errors, repositories: snapshot.repositories };
    },
    resolveRootCwd: (rootId) => resolveRootCwd(resolver, rootId, 'worktrees', logger),
    resolveRootPaths: loadRoots,
    run: execFileGitRunner,
    runSetup: (setupInput) => runWorktreeSetup(setupInput),
  });
  // The shadow-git snapshot backbone, under `userData/snapshots/<rootId>/git`;
  // the factory reset's userData wipe covers it.
  const snapshotsBaseDir = path.join(options.userDataDir, 'snapshots');
  const snapshotService = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir,
  });
  let snapshotMaintenance: { stop(): Promise<void> } | undefined;
  let closing: Promise<void> | undefined;
  // Nothing here runs before the host reports ready: the git-metadata watchers
  // and the snapshot startup GC start on the first window subscription or the
  // first inventory read, both of which reach a host that is already serving.
  let started = false;
  const startMaintenance = (): void => {
    if (!(started && reads) || snapshotMaintenance) {
      return;
    }
    const attached = reads;
    // Host threads record their turn snapshots in Core's log; the startup GC
    // keeps their refs while Core lists the thread.
    snapshotMaintenance = startSnapshotStartupMaintenance({
      logger,
      readHostThreadIds: async () =>
        new Set(attached.readLedger().threads.map(({ threadId }) => threadId)),
      readHostThreadRows: (threadId) => attached.read(threadId, 0),
      snapshotService,
      snapshotsBaseDir,
      workspaceRoots: store,
    });
  };
  const start = (): void => {
    if (started || closing) {
      return;
    }
    started = true;
    gitInventoryService.start();
    startMaintenance();
  };
  const inventory = () => {
    start();
    return gitInventoryService;
  };

  const git = createGitIpcHandlers({ resolver });
  const changes = createChangesIpcHandlers({
    // BST-1977: host threads' agent-run changesets resolve from Core's log.
    hostThreadTurns: createHostThreadTurns({
      listThreads: async () =>
        new Set(
          threadReads()
            .listThreads()
            .map(({ threadId }) => threadId)
        ),
      readRows: (threadId, fromSeq) => threadReads().read(threadId, fromSeq),
    }),
    resolveInventoryService: inventory,
    resolver,
    resolveSnapshotService: () => snapshotService,
  });
  const forge = createForgeIpcHandlers({
    readCacheSnapshot: () => store.forgeCacheSnapshot(),
    service: forgeService,
  });
  const worktrees = createWorktreesIpcHandlers({
    readSettings,
    resolveService: () => worktreeService,
    // BST-1342 containment applies at save time, so the user learns at once
    // rather than when a later create targets the saved path.
    writeSettings: (next) =>
      writeWorktreeSettings(store, homePath, next, async () =>
        (await loadRoots()).map((root) => root.path)
      ),
  });
  const service: HostGitWorkspace = {
    'changes/file-diff': ({ changeset, path: filePath, rootId }) =>
      changes.fileDiff(rootId, changeset, filePath),
    'changes/inventory': (request) => changes.inventory(request),
    'changes/resolve-view': ({ changeset, rootId }) => changes.resolveView(rootId, changeset),
    'forge/cache-snapshot': () => forge.cacheSnapshot(),
    'forge/identity': ({ rootId }) => forge.identity(rootId),
    'forge/pr-status': ({ rootId }) => forge.prStatus(rootId),
    'forge/refresh': ({ reason, rootId }) => forge.refresh(rootId, { reason }),
    'git/ahead-behind': ({ rootId }) => git.aheadBehind(rootId),
    'git/commit': ({ rootId, ...request }) => git.commit(rootId, request),
    'git/commit-files': ({ rootId, ...request }) => git.commitFiles(rootId, request),
    'git/create-branch': ({ rootId, ...request }) => git.createBranch(rootId, request),
    'git/diff': ({ diff, rootId }) => git.diff(rootId, diff),
    'git/fetch': ({ rootId, ...request }) => git.fetch(rootId, request),
    'git/history': ({ rootId, ...request }) => git.history(rootId, request),
    'git/pull': ({ rootId }) => git.pull(rootId),
    'git/push': ({ rootId, ...request }) => git.push(rootId, request),
    'git/repository': ({ rootId }) => git.repository(rootId),
    'git/stage': ({ rootId, ...request }) => git.stage(rootId, request),
    'git/status': ({ rootId }) => git.status(rootId),
    'git/structured-file-diff': ({ diff, rootId }) => git.structuredFileDiff(rootId, diff),
    'git/switch-branch': ({ rootId, ...request }) => git.switchBranch(rootId, request),
    'git/unstage': ({ rootId, ...request }) => git.unstage(rootId, request),
    subscribe: (listener) => {
      listeners.add(listener);
      start();
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
    'worktrees/managed-paths': () => worktrees.listManagedPaths(),
    'worktrees/restore': (request) => worktrees.restore(request),
    'worktrees/settings/read': () => worktrees.getSettings(),
    'worktrees/settings/write': (request) => worktrees.setSettings(request),
  };
  return {
    attachThreadReads: (attached) => {
      reads = attached;
      startMaintenance();
    },
    // Roots are captured one at a time; a root that fails records the null object ID.
    captureTurnBoundary: async ({ boundary, roots, runId, threadId }) => {
      const captured: HostTurnSnapshot[] = [];
      for (const { rootId, rootPath } of roots) {
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
    close: () =>
      (closing ??= (async () => {
        listeners.clear();
        // The consumers settle first, then the services they read: a worktree
        // operation in flight still reads the inventory it started with. Each
        // retires in its own slot, so one failure never leaves another running.
        const failures = [
          ...(await Promise.allSettled([
            snapshotMaintenance?.stop(),
            worktreeService.prepareClose(),
          ])),
          ...(await Promise.allSettled([forgeService.stop(), gitInventoryService.stop()])),
        ].flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (failures.length > 0) {
          throw new AggregateError(failures, 'The workspace git services failed to close');
        }
      })()),
    readWorktree: (id) => ledger.get(id),
    rewindFiles: createHostRewindFiles({
      refreshWorkspaceIndex: options.refreshWorkspaceIndex,
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
    tools: {
      openWorktreeFolder: options.openWorktreeFolder,
      resolveForgeService: () => forgeService,
      resolveWorktreeService: () => worktreeService,
    },
  };
}
