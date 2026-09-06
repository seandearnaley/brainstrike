/**
 * Git awareness lifecycle, moved out of `main.ts`'s `app.whenReady()` block
 * (BST-1648 step 4 — bookkeeping only, wiring preserved): the ONE
 * `GitInventoryService`, the ONE `ForgeService` (+ its IPC registration),
 * and the ONE `WorktreeService`, plus the two main→renderer pushes they
 * drive (`changes:invalidated`, `forge:prUpdated`) with their monotonic
 * generations. Constructed only from inside `app.whenReady()` — never at
 * module scope (BST-1112: `start()`'s first step reaches `getDatabase()` →
 * `utilityProcess.fork`, which Electron rejects before ready). `main.ts`
 * keeps the returned services in its shutdown-runner slots: git-inventory
 * and forge are graceful-shutdown steps BEFORE 'database' (both read the
 * DB), and `runGracefulShutdown` is untouched by this move.
 */
import path from 'node:path';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { createLogger } from '@brainstrike/logging';
import type { StorageAdapter } from '@brainstrike/storage';
import type { ChangesInvalidationEvent, ForgePrUpdatedEvent } from '@brainstrike/types';
import { execFileGhRunner } from '../assistant-server/forge-gh-client';
import { createForgeService, type ForgeService } from '../assistant-server/forge-service';
import {
  createGitInventoryService,
  type GitInventoryService,
} from '../assistant-server/git-inventory-service';
import { recordDesktopAssistantRunEvent } from '../assistant-server/run-persistence';
import { loadWorkspaceRootsFromDatabase } from '../assistant-server/workspace-roots';
import { createWorktreeService } from '../assistant-server/worktree-service';
import { readWorktreeSettings } from '../assistant-server/worktree-settings';
import { runWorktreeSetup } from '../assistant-server/worktree-setup';
import type { getDatabase as getDesktopDatabase } from '../db-main';
import { createForgeIpcHandlers, createForgeRepositoryResolver } from '../forge-ipc-handlers';
import { createDatabaseRootResolver, execFileGitRunner } from '../git-ipc-handlers';
import { registerForgeIpcHandlers } from '../ipc-forge';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { resolveRootCwd } from '../workspace-root-cwd';

export interface GitAwarenessLifecycleDeps {
  /** Push one payload to every live renderer window (ipc-mcp precedent). */
  readonly broadcast: (channel: string, payload: unknown) => void;
  readonly getDatabase: typeof getDesktopDatabase;
  readonly homePath: string;
  readonly logger: Pick<ReturnType<typeof createLogger>, 'debug' | 'error' | 'info' | 'warn'>;
  readonly storage: StorageAdapter;
}

export interface GitAwarenessLifecycle {
  readonly forgeService: ForgeService;
  readonly gitInventoryService: GitInventoryService;
  readonly unregisterForgeIpc: () => void;
  readonly worktreeService: ReturnType<typeof createWorktreeService>;
}

export function startGitAwarenessLifecycle(deps: GitAwarenessLifecycleDeps): GitAwarenessLifecycle {
  const { broadcast, getDatabase, homePath, logger, storage } = deps;
  // Uses a PRIVATE `ElectronFileSystemAdapter` instance — never the shared
  // `fileSystem` and never the renderer-owned `fs:watch` IPC pipeline
  // (`ipc-domains/file-system-watch-ipc.ts` dedupes native subscriptions
  // on `(ownerId, resolvedPath)` ONLY; the ignore-pattern set is not part
  // of that key, so routing this module's fixed `ignorePatterns: []`
  // through the shared pipeline could let an unrelated registration for
  // the same resolved path silently share this filter set). See
  // `ipc-notes-vault.ts`'s private-adapter + inline `DirectoryHandle` pattern.
  const gitInventoryWatcherAdapter = new ElectronFileSystemAdapter();
  // BST-1161 (spec §6): each watcher invalidation is pushed to every live
  // renderer as `changes:invalidated` so git-scope changeset views and the
  // inventory refetch without polling. The monotonic generation lets the
  // renderer drop stale/duplicate deliveries. Broadcast: the Changes surface
  // and git panel can live in any window.
  let changesInvalidationGeneration = 0;
  const broadcastChangesInvalidation = (event: {
    gitCommonDir: string;
    repositoryRoot: string | null;
  }): void => {
    changesInvalidationGeneration += 1;
    const payload: ChangesInvalidationEvent = {
      generation: changesInvalidationGeneration,
      gitCommonDir: event.gitCommonDir,
      repositoryRoot: event.repositoryRoot,
    };
    broadcast(DESKTOP_IPC_CHANNELS.changes.invalidated, payload);
  };
  // BST-1391 (W4): forge PR awareness. ONE instance, never at module
  // scope, same posture as GitInventoryService below. It reads the DB
  // through db-main's provider and spawns `gh` only inside a resolved,
  // containment-checked workspace root.
  let forgePrUpdatedGeneration = 0;
  // Kept as its own binding (not inlined into `resolveRepository` below)
  // so the git-metadata watcher's `onInvalidate` callback below can also
  // clear this resolver's per-rootId cache on the SAME commonDir signal
  // that already drives `forgeService.onRepositoryInvalidated`.
  const forgeRepositoryResolver = createForgeRepositoryResolver(
    createDatabaseRootResolver(getDatabase)
  );
  const forgeService = createForgeService({
    getDatabase,
    onPrUpdated: (event) => {
      forgePrUpdatedGeneration += 1;
      const payload: ForgePrUpdatedEvent = {
        ...event,
        generation: forgePrUpdatedGeneration,
      };
      broadcast(DESKTOP_IPC_CHANNELS.forge.prUpdated, payload);
    },
    resolveRepository: forgeRepositoryResolver,
    run: execFileGhRunner,
  });
  const unregisterForgeIpc = registerForgeIpcHandlers(
    createForgeIpcHandlers({ service: forgeService })
  );
  const gitInventoryService = createGitInventoryService({
    loadRoots: async () => {
      const roots = await loadWorkspaceRootsFromDatabase(await getDatabase());
      return roots.map((root) => ({ id: root.rootId, path: root.path }));
    },
    // The refs watcher moving `refs/remotes/<remote>/<branch>` is the
    // "a push happened" signal §8 asks for: broadcast to renderers AND
    // let the forge service refresh the repositories it already tracks.
    onInvalidate: (event) => {
      broadcastChangesInvalidation(event);
      forgeService.onRepositoryInvalidated(event.gitCommonDir);
      forgeRepositoryResolver.invalidateResolverCache(event.gitCommonDir);
    },
    run: execFileGitRunner,
    // `ElectronFileSystemAdapter.watchDirectory` returns its disposer
    // SYNCHRONOUSLY; `WatchGitCommonDir`'s DI shape is `Promise<() => void>` —
    // adapting with `Promise.resolve(...)` is the documented intent in that
    // type's own doc comment in `git-inventory-watcher.ts` (no health-
    // transition gate needed here, unlike `ipc-notes-vault.ts`'s `startWatch`,
    // because the returned disposer is already safe to use immediately).
    watchDirectory: (commonDir, callback, onSignal, options) =>
      Promise.resolve(
        gitInventoryWatcherAdapter.watchDirectory(
          {
            kind: 'directory',
            name: path.basename(commonDir),
            path: commonDir,
            platform: 'electron',
          },
          callback,
          onSignal,
          options
        )
      ),
  });
  gitInventoryService.start();
  const worktreeService = createWorktreeService({
    getDatabase,
    readSettings: () => readWorktreeSettings(storage, homePath),
    recordRunEvent: (runId, event) => recordDesktopAssistantRunEvent(runId, event, getDatabase),
    resolveInventory: async (options) => {
      // `maxAgeMs: 0` is FORCED (git-inventory-service.ts's own doc
      // comment): it guarantees a build that started after this call, not
      // merely a cache-bust — what reconcileWorktreesFromShell's
      // post-command read needs to reliably see a worktree the agent's
      // shell command just created.
      const snapshot = await gitInventoryService.getSnapshot(
        options?.forceFresh ? { maxAgeMs: 0 } : undefined
      );
      return { errors: snapshot.errors, repositories: snapshot.repositories };
    },
    resolveRootCwd: (rootId) =>
      resolveRootCwd(createDatabaseRootResolver(getDatabase), rootId, 'worktrees', logger),
    resolveRootPaths: async () => {
      const roots = await loadWorkspaceRootsFromDatabase(await getDatabase());
      return roots.map((root) => ({ id: root.rootId, path: root.path }));
    },
    run: execFileGitRunner,
    runSetup: (setupInput) => runWorktreeSetup(setupInput),
  });

  return { forgeService, gitInventoryService, unregisterForgeIpc, worktreeService };
}
