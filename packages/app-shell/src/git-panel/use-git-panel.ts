import { useFileExplorerStoreSelector, useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isTransientRootError,
  TRANSIENT_ROOT_RETRY_DELAY_MS,
  TRANSIENT_ROOT_RETRY_LIMIT,
} from '../roots/transient-root-error';
import {
  type GitBridge,
  type GitCommitFile,
  type GitHistoryPage,
  type GitRepository,
  type GitResult,
  type GitStatus,
  resolveGitBridge,
  type StructuredFileDiff,
} from './git-bridge';

const logger = createLogger('GitPanel');

interface RootScopedValue<T> {
  readonly rootId: string;
  readonly value: T;
}

/** One mounted workspace root, as the Git panel names and switches it (BST-1897). */
export interface GitWorkspaceFolder {
  /** True for the assistant's Main root (`activeRootIds[0]`), which focus never changes. */
  readonly isMain: boolean;
  readonly name: string;
  readonly path: string;
  readonly rootId: string;
}

export interface UseGitPanelResult {
  /** Durable rootId of the focused workspace root, or null if none is open. */
  readonly activeRootId: string | null;
  readonly commit: (summary: string, description?: string) => Promise<boolean>;
  readonly fetchRemote: (remote: string) => Promise<void>;
  /** The focused root Git inspects, or null when none is open. */
  readonly focusedFolder: GitWorkspaceFolder | null;
  /**
   * Focus another mounted root through the explorer's own focus action, so Git
   * follows it. Focus is UI selection only: Main and root order never change.
   * Selecting the already-focused root does nothing.
   */
  readonly focusFolder: (rootId: string) => void;
  /** True while a status fetch is in flight. */
  readonly isLoading: boolean;
  /** True while a push or pull network op is running. */
  readonly isSyncing: boolean;
  /**
   * Structured per-file diff for one commit (BST-1116 W6 Task B). Returns
   * the raw `GitResult` — never toasts, never collapses a failure into
   * `null` — so a caller rendering through `ChangesetFileDiffCard` (which
   * needs the actual error text, not a generic message) gets it verbatim;
   * `git-history-view.tsx` layers its own toast on top, matching the
   * toast-and-return pattern `git-changes-view.tsx`'s `loadFileDiff`
   * established for the Changes tab.
   */
  readonly loadCommitFileDiff: (
    commit: string,
    path: string
  ) => Promise<GitResult<StructuredFileDiff>>;
  readonly loadCommitFiles: (commit: string) => Promise<readonly GitCommitFile[] | null>;
  readonly loadHistory: (options?: LoadHistoryOptions) => Promise<GitHistoryPage | null>;
  /**
   * Read-only status for another mounted root, so the folder switcher can say
   * which roots are repositories. Raw result: the caller renders failures.
   */
  readonly probeFolder: (rootId: string) => Promise<GitResult<GitStatus>>;
  readonly pull: () => Promise<void>;
  readonly push: (remote?: string) => Promise<void>;
  readonly refresh: () => void;
  /** Repository identity, branches, remotes, and worktrees for the active root. */
  readonly repository: GitRepository | null;
  readonly repositoryError: string | null;
  readonly stageAll: () => Promise<void>;
  readonly stageFile: (path: string) => Promise<void>;
  readonly stageFiles: (paths: readonly string[]) => Promise<void>;
  /** Parsed status for the active root; null until first load / when no root. */
  readonly status: GitStatus | null;
  /** A non-recoverable status-load error (e.g. bridge failure), else null. */
  readonly statusError: string | null;
  readonly switchBranch: (branch: string) => Promise<void>;
  readonly unstageAll: () => Promise<void>;
  readonly unstageFile: (path: string) => Promise<void>;
  readonly unstageFiles: (paths: readonly string[]) => Promise<void>;
  /** Every mounted root in workspace order, the focused one included. */
  readonly workspaceFolders: readonly GitWorkspaceFolder[];
}

interface LoadHistoryOptions {
  readonly offset?: number;
  readonly ref?: string;
}

/**
 * Owns all `window.git` interaction for the Git panel: it resolves the focused
 * workspace root's durable `rootId` (re-fetching status whenever the focused
 * root changes), exposes status + ahead/behind, and wraps every mutation so a
 * `{ ok: false }` GitResult or a thrown/rejected call becomes a toast + log
 * (no silent failures), then refreshes status after a successful action.
 *
 * The `bridge` is resolved once (the preload bridge exists for the window's
 * lifetime); when it is absent the hook is inert and `activeRootId` gating in
 * the panel renders the desktop-only empty state.
 */
export function useGitPanel(): UseGitPanelResult {
  const { rootDirectoryHandle, rootDirectoryHandles, rootIdByPath, setFocusedRoot } =
    useFileSystem();
  const mainRootId = useFileExplorerStoreSelector((state) => state.activeRootIds[0] ?? null);
  const { toast } = useToast();
  const bridgeRef = useRef<GitBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = resolveGitBridge();
  }
  const bridge = bridgeRef.current;

  const activeRootId = useMemo<string | null>(() => {
    if (!rootDirectoryHandle) {
      return null;
    }
    // Prefer the durable, self-identifying handle.rootId; fall back to the
    // path→id map for legacy single-root handles. Matches the resolution used
    // by every other workspace surface (see FileTreeWrapper).
    return rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path) ?? null;
  }, [rootDirectoryHandle, rootIdByPath]);

  const workspaceFolders = useMemo<readonly GitWorkspaceFolder[]>(() => {
    const folders: GitWorkspaceFolder[] = [];
    for (const handle of rootDirectoryHandles) {
      const rootId = handle.rootId ?? rootIdByPath?.get(handle.path);
      if (!rootId) {
        // Every root source stamps a rootId; one without it cannot be addressed
        // through the git bridge, so it is reported rather than offered.
        logger.error('workspace root has no rootId; omitted from the Git folder switcher', {
          path: handle.path,
        });
        continue;
      }
      folders.push({ isMain: rootId === mainRootId, name: handle.name, path: handle.path, rootId });
    }
    return folders;
  }, [mainRootId, rootDirectoryHandles, rootIdByPath]);

  const focusedFolder = useMemo<GitWorkspaceFolder | null>(() => {
    if (!(rootDirectoryHandle && activeRootId)) {
      return null;
    }
    return (
      workspaceFolders.find((folder) => folder.rootId === activeRootId) ?? {
        isMain: activeRootId === mainRootId,
        name: rootDirectoryHandle.name,
        path: rootDirectoryHandle.path,
        rootId: activeRootId,
      }
    );
  }, [activeRootId, mainRootId, rootDirectoryHandle, workspaceFolders]);

  const focusFolder = useCallback(
    (rootId: string) => {
      if (rootId === activeRootId) {
        return;
      }
      setFocusedRoot(rootId);
    },
    [activeRootId, setFocusedRoot]
  );

  const [statusState, setStatusState] = useState<RootScopedValue<GitStatus> | null>(null);
  const [repositoryState, setRepositoryState] = useState<RootScopedValue<GitRepository> | null>(
    null
  );
  const [repositoryErrorState, setRepositoryErrorState] = useState<RootScopedValue<string> | null>(
    null
  );
  const [loadingRootId, setLoadingRootId] = useState<string | null>(null);
  const [statusErrorState, setStatusErrorState] = useState<RootScopedValue<string> | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // Bumped to force a refresh after a mutation or a manual refresh click.
  const [refreshToken, setRefreshToken] = useState(0);

  // Counts consecutive transient "root not reconciled yet" failures so the
  // silent boot-race retry loop is bounded. Reset on success, on a manual
  // refresh, and when the focused root changes.
  const transientRetryCountRef = useRef(0);

  const status = statusState?.rootId === activeRootId ? statusState.value : null;
  const repository = repositoryState?.rootId === activeRootId ? repositoryState.value : null;
  const repositoryError =
    repositoryErrorState?.rootId === activeRootId ? repositoryErrorState.value : null;
  const statusError = statusErrorState?.rootId === activeRootId ? statusErrorState.value : null;
  const isLoading =
    activeRootId !== null &&
    (loadingRootId === activeRootId || statusState?.rootId !== activeRootId);

  const refresh = useCallback(() => {
    transientRetryCountRef.current = 0;
    setRefreshToken((token) => token + 1);
  }, []);

  // Load status whenever the focused root changes or a refresh is requested.
  // A stale closure cannot clobber a newer load: the in-flight rootId/token are
  // captured and a `cancelled` flag guards the async write-back.
  useEffect(() => {
    if (!(bridge && activeRootId)) {
      setStatusState(null);
      setStatusErrorState(null);
      setLoadingRootId(null);
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setLoadingRootId(activeRootId);
    setStatusErrorState(null);

    bridge
      .status(activeRootId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          transientRetryCountRef.current = 0;
          setStatusState({ rootId: activeRootId, value: result.value });
          setStatusErrorState(null);
        } else if (
          isTransientRootError(result.error) &&
          transientRetryCountRef.current < TRANSIENT_ROOT_RETRY_LIMIT
        ) {
          // Boot race: the workspace root row hasn't reconciled into the DB
          // yet. Keep the loading state and poll again shortly — no error UI,
          // no toast — until it lands or the retry budget runs out.
          transientRetryCountRef.current += 1;
          logger.debug('git status waiting for workspace root reconciliation', {
            attempt: transientRetryCountRef.current,
            error: result.error,
          });
          retryTimer = setTimeout(() => {
            if (!cancelled) {
              setRefreshToken((token) => token + 1);
            }
          }, TRANSIENT_ROOT_RETRY_DELAY_MS);
          return;
        } else {
          setStatusState(null);
          setStatusErrorState({ rootId: activeRootId, value: result.error });
          logger.error('git status failed', { error: result.error });
          toast({
            description: result.error,
            title: 'Git status failed',
            variant: 'destructive',
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setStatusState(null);
        setStatusErrorState({ rootId: activeRootId, value: message });
        logger.error('git status threw', { error: message });
        toast({ description: message, title: 'Git status failed', variant: 'destructive' });
      })
      .finally(() => {
        // Keep the loading state up while a transient-root retry is pending so
        // the panel shows "loading", not a flash of empty/error UI.
        if (!(cancelled || retryTimer)) {
          setLoadingRootId((rootId) => (rootId === activeRootId ? null : rootId));
        }
      });

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [bridge, activeRootId, refreshToken, toast]);

  useEffect(() => {
    if (!(bridge && activeRootId && status?.isRepository)) {
      setRepositoryState(null);
      setRepositoryErrorState(null);
      return;
    }
    let cancelled = false;
    bridge
      .repository(activeRootId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setRepositoryState({ rootId: activeRootId, value: result.value });
          setRepositoryErrorState(null);
          return;
        }
        setRepositoryState(null);
        setRepositoryErrorState({ rootId: activeRootId, value: result.error });
        logger.error('git repository metadata failed', { error: result.error });
        toast({
          description: result.error,
          title: 'Repository details failed',
          variant: 'destructive',
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setRepositoryState(null);
        setRepositoryErrorState({ rootId: activeRootId, value: message });
        logger.error('git repository metadata threw', { error: message });
        toast({
          description: message,
          title: 'Repository details failed',
          variant: 'destructive',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeRootId, bridge, refreshToken, status?.isRepository, toast]);

  // A different focused root starts with a fresh transient-retry budget.
  useEffect(() => {
    transientRetryCountRef.current = 0;
  }, [activeRootId]);

  /**
   * Run a mutating git op, surfacing any failure as a toast + log, and refresh
   * status on success. Returns whether the op succeeded.
   */
  const runMutation = useCallback(
    async (
      label: string,
      run: (
        bridge: GitBridge,
        rootId: string
      ) => Promise<{ ok: true } | { ok: false; error: string }>
    ): Promise<boolean> => {
      if (!(bridge && activeRootId && status?.isRepository)) {
        return false;
      }
      try {
        const result = await run(bridge, activeRootId);
        if (!result.ok) {
          logger.error(`${label} failed`, { error: result.error });
          toast({ description: result.error, title: `${label} failed`, variant: 'destructive' });
          return false;
        }
        refresh();
        return true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${label} threw`, { error: message });
        toast({ description: message, title: `${label} failed`, variant: 'destructive' });
        return false;
      }
    },
    [bridge, activeRootId, refresh, status?.isRepository, toast]
  );

  const stageFile = useCallback(
    async (path: string): Promise<void> => {
      await runMutation('Stage', (b, rootId) => b.stage(rootId, { path }));
    },
    [runMutation]
  );

  const stageAll = useCallback(async (): Promise<void> => {
    await runMutation('Stage all', (b, rootId) => b.stage(rootId));
  }, [runMutation]);

  const stageFiles = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      if (paths.length === 0) {
        return;
      }
      const succeeded = await runMutation('Stage visible files', async (b, rootId) => {
        for (const path of paths) {
          const result = await b.stage(rootId, { path });
          if (!result.ok) {
            return result;
          }
        }
        return { ok: true };
      });
      if (!succeeded) {
        refresh();
      }
    },
    [refresh, runMutation]
  );

  const unstageFile = useCallback(
    async (path: string): Promise<void> => {
      await runMutation('Unstage', (b, rootId) => b.unstage(rootId, { path }));
    },
    [runMutation]
  );

  const unstageAll = useCallback(async (): Promise<void> => {
    await runMutation('Unstage all', (b, rootId) => b.unstage(rootId));
  }, [runMutation]);

  const unstageFiles = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      if (paths.length === 0) {
        return;
      }
      const succeeded = await runMutation('Unstage visible files', async (b, rootId) => {
        for (const path of paths) {
          const result = await b.unstage(rootId, { path });
          if (!result.ok) {
            return result;
          }
        }
        return { ok: true };
      });
      if (!succeeded) {
        refresh();
      }
    },
    [refresh, runMutation]
  );

  const commit = useCallback(
    async (summary: string, description?: string): Promise<boolean> => {
      const trimmed = summary.trim();
      if (trimmed.length === 0) {
        toast({
          description: 'Enter a commit message first.',
          title: 'Commit failed',
          variant: 'destructive',
        });
        return false;
      }
      return await runMutation('Commit', async (b, rootId) => {
        const result = await b.commit(rootId, {
          ...(description?.trim() ? { description: description.trim() } : {}),
          summary: trimmed,
        });
        if (result.ok) {
          toast({
            description: `${result.value.commit}${result.value.branch ? ` on ${result.value.branch}` : ''}`,
            title: 'Committed',
          });
        }
        return result;
      });
    },
    [runMutation, toast]
  );

  const push = useCallback(
    async (remote?: string): Promise<void> => {
      if (!(bridge && activeRootId)) {
        return;
      }
      setIsSyncing(true);
      try {
        await runMutation('Push', async (b, rootId) => {
          const result = remote ? await b.push(rootId, { remote }) : await b.push(rootId);
          if (result.ok) {
            toast({ description: result.value.output || 'Up to date.', title: 'Pushed' });
          }
          return result;
        });
      } finally {
        setIsSyncing(false);
      }
    },
    [bridge, activeRootId, runMutation, toast]
  );
  const fetchRemote = useCallback(
    async (remote: string): Promise<void> => {
      if (!(bridge && activeRootId)) {
        return;
      }
      setIsSyncing(true);
      try {
        await runMutation('Fetch', async (b, rootId) => {
          const result = await b.fetch(rootId, { remote });
          if (result.ok) {
            toast({ description: result.value.output || 'Up to date.', title: 'Fetched' });
          }
          return result;
        });
      } finally {
        setIsSyncing(false);
      }
    },
    [bridge, activeRootId, runMutation, toast]
  );

  const switchBranch = useCallback(
    async (branch: string): Promise<void> => {
      await runMutation('Switch branch', async (b, rootId) => {
        const result = await b.switchBranch(rootId, { branch });
        if (result.ok) {
          toast({ description: result.value.branch, title: 'Branch switched' });
        }
        return result;
      });
    },
    [runMutation, toast]
  );

  const pull = useCallback(async (): Promise<void> => {
    if (!(bridge && activeRootId)) {
      return;
    }
    setIsSyncing(true);
    try {
      await runMutation('Pull', async (b, rootId) => {
        const result = await b.pull(rootId);
        if (result.ok) {
          toast({ description: result.value.output || 'Already up to date.', title: 'Pulled' });
        }
        return result;
      });
    } finally {
      setIsSyncing(false);
    }
  }, [bridge, activeRootId, runMutation, toast]);

  const loadHistory = useCallback(
    async (options: LoadHistoryOptions = {}): Promise<GitHistoryPage | null> => {
      if (!(bridge && activeRootId)) {
        return null;
      }
      const { offset = 0, ref } = options;
      try {
        const result = await bridge.history(activeRootId, {
          limit: 100,
          offset,
          ...(ref ? { ref } : {}),
        });
        if (result.ok) {
          return result.value;
        }
        logger.error('git history failed', { error: result.error, ref });
        toast({ description: result.error, title: 'History failed', variant: 'destructive' });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('git history threw', { error: message, ref });
        toast({ description: message, title: 'History failed', variant: 'destructive' });
      }
      return null;
    },
    [bridge, activeRootId, toast]
  );

  const loadCommitFiles = useCallback(
    async (commitId: string): Promise<readonly GitCommitFile[] | null> => {
      if (!(bridge && activeRootId)) {
        return null;
      }
      try {
        const result = await bridge.commitFiles(activeRootId, { commit: commitId });
        if (result.ok) {
          return result.value;
        }
        logger.error('git commit files failed', { commit: commitId, error: result.error });
        toast({
          description: result.error,
          title: 'Commit files failed',
          variant: 'destructive',
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('git commit files threw', { commit: commitId, error: message });
        toast({ description: message, title: 'Commit files failed', variant: 'destructive' });
      }
      return null;
    },
    [bridge, activeRootId, toast]
  );

  const probeFolder = useCallback(
    async (rootId: string): Promise<GitResult<GitStatus>> => {
      if (!bridge) {
        return { error: 'git-bridge-unavailable: the desktop Git bridge is missing', ok: false };
      }
      try {
        const result = await bridge.status(rootId);
        if (!result.ok) {
          // The switcher shows a one-line summary; the full text lives here.
          logger.warn('git folder probe failed', { error: result.error, rootId });
        }
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('git folder probe threw', { error: message, rootId });
        return { error: message, ok: false };
      }
    },
    [bridge]
  );

  // No toast/log-on-`!ok` here by design — see this method's doc comment on
  // `UseGitPanelResult`. Only a thrown/rejected call (never expected from
  // the bridge's own contract, but not impossible from a broken preload) is
  // logged, mirroring `use-changeset.ts`'s `fileDiff`.
  const loadCommitFileDiff = useCallback(
    async (commitId: string, path: string): Promise<GitResult<StructuredFileDiff>> => {
      if (!(bridge && activeRootId)) {
        return { error: 'git-bridge-unavailable: no active workspace root', ok: false };
      }
      try {
        return await bridge.structuredFileDiff(activeRootId, {
          commitId,
          mode: 'commit',
          path,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('git commit structured diff threw', {
          commit: commitId,
          error: message,
          path,
        });
        return { error: message, ok: false };
      }
    },
    [bridge, activeRootId]
  );

  return {
    activeRootId,
    commit,
    fetchRemote,
    focusedFolder,
    focusFolder,
    isLoading,
    isSyncing,
    loadCommitFileDiff,
    loadCommitFiles,
    loadHistory,
    probeFolder,
    pull,
    push,
    refresh,
    repository,
    repositoryError,
    stageAll,
    stageFile,
    stageFiles,
    status,
    statusError,
    switchBranch,
    unstageAll,
    unstageFile,
    unstageFiles,
    workspaceFolders,
  };
}
